'use client';
import { useToast } from '@/components/ui/Toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { SubNav } from '@/components/wg/SubNav';
import { ThumbAction } from '@/components/wg/ThumbAction';
import { useWg } from '@/components/wg/WgContextProvider';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { usePendingSet } from '@/core/hooks/usePendingSet';
import { apiFetch } from '@/core/infra/api-client';
import { captureException } from '@/core/infra/observability';
import { buildDraftKey, readDraft, removeDraft, writeDraft } from '@/core/offline/drafts';
import {
	discardQueuedEntry,
	enqueueOfflineAction,
	isOfflineActionQueued,
	readOfflineQueue,
	syncOfflineActions,
	writeOfflineQueue,
} from '@/core/offline/offline-client';
import {
	DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE,
	QUEUE_EDIT_ALREADY_SENT_MESSAGE,
	formatQueuedOfflineEntries,
} from '@/core/offline/offline-copy';
import {
	createOfflineIdempotencyKey,
	createQueuedShoppingItem,
	createQueuedShoppingUpdate,
	hasQueuedShoppingUpdate,
	isQueuedCreateId,
} from '@/core/offline/offline-queue';
import { useOfflineQueueSync } from '@/core/offline/useOfflineQueueSync';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import {
	type InventoryItemDto,
	isBelowThreshold,
	normalizeForMatch,
} from '@/features/inventory/inventory';
import { ListSkeleton } from '@/features/shopping/components/ListSkeleton';
import { ShoppingItemRow } from '@/features/shopping/components/ShoppingItemRow';
import { NAME_MAX, QUICK_SHOPPING_ITEMS } from '@/features/shopping/components/constants';
import type { MemberInfo, ShoppingItem } from '@/features/shopping/components/shopping-types';
import { parseShoppingInput } from '@/features/shopping/parse-shopping-input';
import {
	clearBoughtErrorMessage,
	shoppingActionErrorMessage,
	shoppingAddErrorMessage,
} from '@/features/shopping/shopping-errors';
import { cn } from '@/shared/lib/cn';
import { ChevronRight, ListChecks, Plus, Receipt, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ShoppingCreateWarning =
	| null
	| 'notification_delivery_failed'
	| 'notification_delivery_unknown';

type ShoppingCreateResponse = { item: ShoppingItem; warning: ShoppingCreateWarning };

const UNKNOWN_MEMBER: MemberInfo = { name: '?', color: null };
const RECEIPT_PROMPT_WINDOW_MS = 12 * 60 * 60 * 1000;

// Keeps the same array reference when nothing actually changed, so memoized
// rows do not re-render on unrelated state updates (typing, error banners).
function keepItems(prev: ShoppingItem[], next: ShoppingItem[]): ShoppingItem[] {
	const unchanged =
		prev.length === next.length && prev.every((item, index) => item === next[index]);
	return unchanged ? prev : next;
}

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function EinkaufPage() {
	const { wg, members, identity, isAdmin } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const {
		data: cachedShopping,
		error: shoppingReadError,
		isLoading: shoppingReadLoading,
		refresh: refreshShopping,
		setData: setCachedShopping,
	} = useCachedFetch<{ items: ShoppingItem[] }>(`/api/wg/${encodedShareCode}/shopping`, {
		memberId: identity.memberId,
	});
	const { data: cachedInventory, refresh: refreshInventory } = useCachedFetch<{
		items: InventoryItemDto[];
	}>(`/api/wg/${encodedShareCode}/inventory`, {
		memberId: identity.memberId,
	});
	const wgBaseHref = `/wg/${encodedShareCode}`;
	const searchParams = useSearchParams();
	const highlightedId = searchParams.get('highlight');
	const prefillName = searchParams.get('name');
	const [items, setItems] = useState<ShoppingItem[]>(() => cachedShopping?.items ?? []);
	const commitItems = useCallback(
		(update: ShoppingItem[] | ((current: ShoppingItem[]) => ShoppingItem[])) => {
			setItems(update);
			setCachedShopping((current) => {
				const previousItems = current?.items ?? items;
				const nextItems = typeof update === 'function' ? update(previousItems) : update;
				if (!current && nextItems === previousItems) return current;
				return { ...(current ?? { items: previousItems }), items: nextItems };
			});
		},
		[items, setCachedShopping],
	);
	const [initialLoading, setInitialLoading] = useState(shoppingReadLoading);
	const [newName, setNewName] = useState('');
	const [inventory, setInventory] = useState<InventoryItemDto[]>(
		() => cachedInventory?.items ?? [],
	);
	const [doneOpen, setDoneOpen] = useState(false);
	const [receiptSince, setReceiptSince] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [addError, setAddError] = useState<string | null>(null);
	const [addNotice, setAddNotice] = useState<string | null>(null);
	const [toggleError, setToggleError] = useState<string | null>(null);
	const [toggleNotice, setToggleNotice] = useState<string | null>(null);
	const [removeError, setRemoveError] = useState<string | null>(null);
	const [removeErrorId, setRemoveErrorId] = useState<string | null>(null);
	const [removeNotice, setRemoveNotice] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [clearingBought, setClearingBought] = useState(false);
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const [queueEditId, setQueueEditId] = useState<string | null>(null);
	const [draftHydrated, setDraftHydrated] = useState(false);
	const { isPending, start, end } = usePendingSet();
	const addingRef = useRef(false);
	const addIdempotencyKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const clearingBoughtRef = useRef(false);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const nameValueRef = useRef('');
	const shoppingPatchRequestKeysRef = useRef(
		new Map<string, { fingerprint: string; key: string }>(),
	);

	const draftKey = buildDraftKey(wg.shareCode, identity.memberId, 'shopping');
	const appliedPrefillRef = useRef<string | null>(null);
	const mountedRef = useRef(false);
	const loadRequestIdRef = useRef(0);
	const hasShoppingCacheRef = useRef(cachedShopping !== undefined);

	const load = useCallback(
		async (silent = false, afterMutation = false): Promise<void> => {
			const requestId = loadRequestIdRef.current + 1;
			loadRequestIdRef.current = requestId;
			if (!silent && !hasShoppingCacheRef.current) setInitialLoading(true);
			const res = await refreshShopping({ afterMutation });
			if (requestId !== loadRequestIdRef.current) {
				if (!silent) setInitialLoading(false);
				return;
			}
			if (res.ok) {
				setLoadError(null);
				setItems(res.data.items);
				// Nur für Vorschläge: ein Fehler hier darf die Liste nicht blockieren.
				void refreshInventory();
				syncOfflineActions(wg.shareCode, { memberId: identity.memberId })
					.then((synced) => {
						if (!mountedRef.current) return;
						if (requestId !== loadRequestIdRef.current) return;
						refreshCount();
						if (synced > 0) void load(true);
					})
					.catch((err) => captureException(err, { action: 'syncOfflineActions', page: 'einkauf' }));
			} else {
				// keep existing items on error during silent refresh
				if (!silent) setLoadError(getWgLoadErrorMessage('Einkaufsliste', res.status, res.error));
			}
			if (!silent && requestId === loadRequestIdRef.current) setInitialLoading(false);
		},
		[identity.memberId, refreshInventory, refreshShopping, wg.shareCode],
	);
	useEffect(() => {
		if (cachedShopping) {
			hasShoppingCacheRef.current = true;
			setItems(cachedShopping.items);
			setLoadError(null);
			setInitialLoading(false);
		} else if (shoppingReadError) {
			setLoadError(
				getWgLoadErrorMessage('Einkaufsliste', shoppingReadError.status, shoppingReadError.error),
			);
			setInitialLoading(false);
		}
		if (cachedInventory) setInventory(cachedInventory.items);
	}, [cachedInventory, cachedShopping, shoppingReadError]);
	const itemCount = items.length;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		void load(false);
	}, [load]);
	// Auto-Refresh wie auf dem Dashboard — ersetzt den manuellen Reload-Button.
	useVisibilityPausedInterval(() => void load(true), 30_000);

	useEffect(() => {
		if (prefillName) {
			setDraftHydrated(true);
			return;
		}
		const draft = readDraft<{ name?: string; quantity?: string; queueEditId?: string }>(draftKey);
		if (draft?.name) setNewName(draft.quantity ? `${draft.quantity} ${draft.name}` : draft.name);
		if (draft?.queueEditId) setQueueEditId(draft.queueEditId);
		setDraftHydrated(true);
	}, [draftKey, prefillName]);

	useEffect(() => {
		if (!prefillName) return;
		if (appliedPrefillRef.current === prefillName) return;
		appliedPrefillRef.current = prefillName;
		setNewName(prefillName.slice(0, NAME_MAX));
		setQueueEditId(null);
	}, [prefillName]);

	useEffect(() => {
		if (!draftHydrated) return;
		writeDraft(draftKey, { name: newName, queueEditId });
	}, [draftHydrated, draftKey, newName, queueEditId]);

	useEffect(() => {
		nameValueRef.current = newName;
	}, [newName]);

	const { queuedCount, refreshCount } = useOfflineQueueSync({
		shareCode: wg.shareCode,
		memberId: identity.memberId,
		page: 'einkauf',
		onSynced: () => void load(true),
	});

	useEffect(() => {
		if (!highlightedId || itemCount === 0) return;
		if (items.some((item) => item.id === highlightedId && item.boughtAt !== null))
			setDoneOpen(true);
		window.setTimeout(() => {
			document.getElementById(`shopping-${highlightedId}`)?.scrollIntoView({
				block: 'center',
				behavior: 'smooth',
			});
		}, 80);
	}, [highlightedId, itemCount, items]);

	const memberInfoById = useMemo(() => {
		const map = new Map<string, MemberInfo>();
		for (const member of members) {
			map.set(member.id, { name: member.name, color: member.color ?? null });
		}
		return map;
	}, [members]);

	const memberLookup = useCallback(
		(id: string | null): MemberInfo => {
			if (!id) return UNKNOWN_MEMBER;
			return memberInfoById.get(id) ?? UNKNOWN_MEMBER;
		},
		[memberInfoById],
	);

	function clearEditedQueueItem(): boolean {
		if (!queueEditId) return true;
		const saved = writeOfflineQueue(readOfflineQueue().filter((item) => item.id !== queueEditId));
		if (!saved) return false;
		setQueueEditId(null);
		return true;
	}

	/** Chips übergeben ihren Text direkt; nur Eingaben aus dem Feld leeren danach das Feld. */
	async function add(text?: string): Promise<void> {
		if (addingRef.current) return;
		const fromInput = text === undefined;
		const submittedName = text ?? newName;
		const { name, quantity } = parseShoppingInput(submittedName);
		if (name.length === 0) return;
		// The edited queue entry may have been synced meanwhile; a new create would duplicate it.
		if (fromInput && queueEditId && !isOfflineActionQueued(queueEditId)) {
			setQueueEditId(null);
			setNewName('');
			removeDraft(draftKey);
			setAddError(null);
			setAddNotice(QUEUE_EDIT_ALREADY_SENT_MESSAGE);
			void load(true);
			return;
		}
		addingRef.current = true;
		setAdding(true);
		setAddError(null);
		setAddNotice(null);
		const fingerprint = JSON.stringify({ name, quantity });
		const pendingRequest = addIdempotencyKeyRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setAddError('Artikel konnte nicht sicher gespeichert werden. Versuche es erneut.');
			addingRef.current = false;
			setAdding(false);
			return;
		}
		addIdempotencyKeyRef.current = { fingerprint, key: idempotencyKey };
		try {
			const res = await apiFetch<ShoppingCreateResponse>(`/api/wg/${encodedShareCode}/shopping`, {
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({
					name,
					quantity: quantity ?? undefined,
					addedByMemberId: identity.memberId,
				}),
			});
			if (!res.ok) {
				const retryableResponse =
					res.status === 429 || res.status >= 500 || res.error === 'idempotency_response_pending';
				if (res.status !== 0 && !retryableResponse) addIdempotencyKeyRef.current = null;
				if (res.status === 0) {
					const queued = createQueuedShoppingItem({
						wgId: wg.id,
						shareCode: wg.shareCode,
						memberId: identity.memberId,
						idempotencyKey,
						name,
						quantity,
					});
					if (enqueueOfflineAction(queued) === 0) {
						setAddError(OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE);
						return;
					}
					addIdempotencyKeyRef.current = null;
					refreshCount();
					if (fromInput && !clearEditedQueueItem()) {
						setAddError(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
						return;
					}
					commitItems((prev) => [
						{
							id: queued.id,
							addedByMemberId: identity.memberId,
							name,
							quantity,
							boughtAt: null,
							boughtByMemberId: null,
							createdAt: queued.createdAt,
						},
						...prev,
					]);
					if (fromInput && nameValueRef.current === submittedName) {
						setNewName('');
						removeDraft(draftKey);
					}
					setAddNotice('Offline gespeichert. Wird synchronisiert, sobald ihr wieder online seid.');
					return;
				}
				if (res.status === 409 && res.error === 'shopping_item_duplicate') {
					await load(true);
				}
				if (retryableResponse) await load(true);
				setAddError(
					retryableResponse
						? 'Speicherstatus unklar. Prüfe die Liste und versuche es bei Bedarf erneut.'
						: shoppingAddErrorMessage(res.error),
				);
				return;
			}
			addIdempotencyKeyRef.current = null;
			if (fromInput && !clearEditedQueueItem()) {
				setAddError(DRAFT_CLEANUP_FAILED_MESSAGE);
				return;
			}
			if (fromInput && nameValueRef.current === submittedName) {
				setNewName('');
				removeDraft(draftKey);
			}
			toast.success('Hinzugefügt');
			if (res.data.warning === 'notification_delivery_failed') {
				toast.info('Gespeichert. Nicht alle Push-Benachrichtigungen konnten versendet werden.');
			} else if (res.data.warning === 'notification_delivery_unknown') {
				toast.info('Gespeichert. Push-Versand konnte nicht bestätigt werden.');
			}
			// The add has no optimistic row; make sure the list reflects it.
			void load(true, true);
		} finally {
			addingRef.current = false;
			setAdding(false);
		}
	}

	const toggleBought = useCallback(
		async (item: ShoppingItem): Promise<void> => {
			if (isPending(item.id)) return;
			if (hasQueuedShoppingUpdate(readOfflineQueue(), wg.shareCode, identity.memberId, item.id)) {
				return;
			}
			const becomingBought = item.boughtAt === null;
			const queuedCreate = readOfflineQueue().find(
				(queued) =>
					queued.id === item.id &&
					queued.shareCode === wg.shareCode &&
					queued.type === 'shopping.create',
			);
			let patchRequest: {
				expectedUpdatedAt: string;
				expectedBoughtAt: string | null;
				fingerprint: string;
				idempotencyKey: string;
			} | null = null;
			if (!queuedCreate) {
				if (!item.updatedAt) {
					setToggleError(
						'Der Artikelstand wird aktualisiert. Prüfe die Liste und versuche es erneut.',
					);
					void load(true);
					return;
				}
				const fingerprint = JSON.stringify({
					expectedUpdatedAt: item.updatedAt,
					expectedBoughtAt: item.boughtAt,
					bought: becomingBought,
				});
				const previous = shoppingPatchRequestKeysRef.current.get(item.id);
				const idempotencyKey =
					previous?.fingerprint === fingerprint ? previous.key : createOfflineIdempotencyKey();
				if (!idempotencyKey) {
					setToggleError(
						'Einkaufsstatus konnte nicht sicher gespeichert werden. Versuche es erneut.',
					);
					return;
				}
				patchRequest = {
					expectedUpdatedAt: item.updatedAt,
					expectedBoughtAt: item.boughtAt,
					fingerprint,
					idempotencyKey,
				};
				shoppingPatchRequestKeysRef.current.set(item.id, { fingerprint, key: idempotencyKey });
			}
			start(item.id);
			setToggleError(null);
			setToggleNotice(null);
			const optimisticItem: ShoppingItem = {
				...item,
				boughtAt: becomingBought ? new Date().toISOString() : null,
				boughtByMemberId: becomingBought ? identity.memberId : null,
			};
			commitItems((prev) =>
				keepItems(
					prev,
					prev.map((current) => (current.id === item.id ? optimisticItem : current)),
				),
			);
			const rollback = () =>
				commitItems((prev) =>
					keepItems(
						prev,
						prev.map((current) => (current.id === item.id ? item : current)),
					),
				);

			try {
				if (queuedCreate) {
					const saved = writeOfflineQueue(
						readOfflineQueue().map((queued) =>
							queued.id === item.id
								? { ...queued, payload: { ...queued.payload, bought: becomingBought } }
								: queued,
						),
					);
					if (!saved) {
						rollback();
						setToggleError(
							'Offline-Speicher ist blockiert. Der Einkaufsstatus konnte nicht vorgemerkt werden.',
						);
						return;
					}
					refreshCount();
					setToggleNotice(
						becomingBought
							? 'Offline vorgemerkt. Der neue Artikel wird direkt als erledigt synchronisiert.'
							: 'Offline vorgemerkt. Der neue Artikel wird wieder offen synchronisiert.',
					);
					return;
				}
				if (!patchRequest) {
					rollback();
					setToggleError('Der Einkaufsstatus konnte nicht sicher gespeichert werden.');
					return;
				}

				const res = await apiFetch<{ item: ShoppingItem }>(
					`/api/wg/${encodedShareCode}/shopping/${encodeURIComponent(item.id)}`,
					{
						method: 'PATCH',
						memberId: identity.memberId,
						memberToken: identity.memberToken,
						headers: { 'Idempotency-Key': patchRequest.idempotencyKey },
						body: JSON.stringify({
							bought: becomingBought,
							expectedUpdatedAt: patchRequest.expectedUpdatedAt,
							expectedBoughtAt: patchRequest.expectedBoughtAt,
						}),
					},
				);
				if (!res.ok) {
					if (res.status > 0 && res.status < 500 && res.status !== 429) {
						const pending = shoppingPatchRequestKeysRef.current.get(item.id);
						if (pending?.fingerprint === patchRequest.fingerprint) {
							shoppingPatchRequestKeysRef.current.delete(item.id);
						}
					}
					if (res.status === 403) {
						rollback();
						setToggleError('Nur der/die Autor:in kann dies abhaken.');
					} else if (res.status === 404 && res.error === 'item_not_found') {
						commitItems((prev) =>
							keepItems(
								prev,
								prev.filter((current) => current.id !== item.id),
							),
						);
						setToggleError(
							'Dieser Einkaufsartikel existiert nicht mehr und wurde aus deiner Liste entfernt.',
						);
					} else if (res.status === 409 && res.error === 'shopping_item_duplicate') {
						rollback();
						await load(true);
						setToggleError(shoppingAddErrorMessage(res.error));
					} else if (res.status === 409 && res.error === 'shopping_item_changed') {
						rollback();
						await load(true);
						setToggleError('Der Einkaufsstatus hat sich geändert. Prüfe den aktualisierten Stand.');
					} else if (res.status === 0) {
						const queued = createQueuedShoppingUpdate({
							wgId: wg.id,
							shareCode: wg.shareCode,
							memberId: identity.memberId,
							itemId: item.id,
							name: item.name,
							bought: becomingBought,
							expectedUpdatedAt: patchRequest.expectedUpdatedAt,
							expectedBoughtAt: patchRequest.expectedBoughtAt,
							idempotencyKey: patchRequest.idempotencyKey,
						});
						if (enqueueOfflineAction(queued) === 0) {
							rollback();
							setToggleError(
								'Offline-Speicher ist blockiert. Der Einkaufsstatus konnte nicht vorgemerkt werden.',
							);
							return;
						}
						shoppingPatchRequestKeysRef.current.delete(item.id);
						refreshCount();
						setToggleNotice(
							becomingBought
								? 'Offline vorgemerkt. Der Artikel wird später als erledigt synchronisiert.'
								: 'Offline vorgemerkt. Der Artikel wird später wieder geöffnet.',
						);
					} else {
						rollback();
						setToggleError(shoppingActionErrorMessage(res.error, 'Abhaken fehlgeschlagen.'));
					}
					return;
				}
				commitItems((prev) =>
					keepItems(
						prev,
						prev.map((current) => (current.id === item.id ? res.data.item : current)),
					),
				);
				shoppingPatchRequestKeysRef.current.delete(item.id);
				void load(true);
			} finally {
				end(item.id);
			}
		},
		[
			end,
			encodedShareCode,
			commitItems,
			identity.memberId,
			identity.memberToken,
			isPending,
			load,
			refreshCount,
			start,
			wg.id,
			wg.shareCode,
		],
	);

	const remove = useCallback(
		async (id: string): Promise<void> => {
			if (isPending(id)) return;
			setRemoveError(null);
			setRemoveErrorId(null);
			setRemoveNotice(null);
			const queued = discardQueuedEntry(wg.shareCode, id);
			if (queued === 'storage_blocked') {
				setRemoveErrorId(id);
				setRemoveError(
					'Offline-Speicher ist blockiert. Der vorgemerkte Artikel konnte nicht entfernt werden.',
				);
				return;
			}
			if (queued === 'removed' || isQueuedCreateId(id)) {
				commitItems((prev) =>
					keepItems(
						prev,
						prev.filter((item) => item.id !== id),
					),
				);
				refreshCount();
				setQueueEditId((current) => (current === id ? null : current));
				setRemoveNotice('Der offline angelegte Eintrag wurde aus deiner Liste entfernt.');
				return;
			}
			start(id);
			const res = await apiFetch<unknown>(
				`/api/wg/${encodedShareCode}/shopping/${encodeURIComponent(id)}`,
				{
					method: 'DELETE',
					memberId: identity.memberId,
					memberToken: identity.memberToken,
				},
			);
			if (!res.ok) {
				if (res.status === 403) {
					setRemoveErrorId(id);
					setRemoveError('Nur der/die Autor:in kann diesen Eintrag entfernen.');
				} else if (res.status === 404 && res.error === 'item_not_found') {
					commitItems((prev) =>
						keepItems(
							prev,
							prev.filter((item) => item.id !== id),
						),
					);
					setRemoveError(
						'Dieser Einkaufsartikel existiert nicht mehr und wurde aus deiner Liste entfernt.',
					);
				} else {
					setRemoveErrorId(id);
					setRemoveError(shoppingActionErrorMessage(res.error, 'Entfernen fehlgeschlagen.'));
				}
				end(id);
				return;
			}
			commitItems((prev) =>
				keepItems(
					prev,
					prev.filter((item) => item.id !== id),
				),
			);
			void load(true);
			end(id);
		},
		[
			end,
			encodedShareCode,
			commitItems,
			identity.memberId,
			identity.memberToken,
			isPending,
			load,
			refreshCount,
			start,
			wg.shareCode,
		],
	);

	async function clearBought(): Promise<void> {
		if (clearingBoughtRef.current) return;
		clearingBoughtRef.current = true;
		setClearingBought(true);
		setRemoveError(null);
		setRemoveErrorId(null);
		try {
			const res = await apiFetch<{ deleted: number }>(`/api/wg/${encodedShareCode}/shopping`, {
				method: 'DELETE',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
			});
			if (res.ok) {
				commitItems((prev) =>
					keepItems(
						prev,
						prev.filter((item) => item.boughtAt === null),
					),
				);
				void load(true);
			} else {
				setRemoveError(clearBoughtErrorMessage(res.status, res.error));
			}
		} finally {
			clearingBoughtRef.current = false;
			setClearingBought(false);
		}
	}

	const open = items.filter((i) => i.boughtAt === null);
	const done = items.filter((i) => i.boughtAt !== null);

	const byCreated = (a: ShoppingItem, b: ShoppingItem) =>
		a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
	const openItems = [...open].sort(byCreated);
	const doneItems = [...done].sort(
		(a, b) => (b.boughtAt ?? '').localeCompare(a.boughtAt ?? '') || byCreated(a, b),
	);
	const actionError = toggleError ?? (removeErrorId ? null : removeError);
	const queuedShoppingUpdateIds = new Set(
		readOfflineQueue()
			.filter(
				(action) =>
					action.type === 'shopping.update' &&
					action.shareCode === wg.shareCode &&
					action.memberId === identity.memberId,
			)
			.map((action) => String(action.payload.itemId)),
	);

	// Nach dem Einkauf: eigene frisch gekaufte Artikel direkt als Ausgabe erfassen.
	const receiptKey = `manawg:receipt-prompt:${wg.shareCode}`;
	useEffect(() => {
		try {
			setReceiptSince(window.localStorage.getItem(receiptKey));
		} catch {
			// Ohne Speicher erscheint der Hinweis nur für die letzten Stunden.
		}
	}, [receiptKey]);
	const receiptCutoff = Math.max(
		Date.now() - RECEIPT_PROMPT_WINDOW_MS,
		receiptSince ? Date.parse(receiptSince) || 0 : 0,
	);
	const myFreshBought = doneItems.filter(
		(item) =>
			item.boughtByMemberId === identity.memberId &&
			item.boughtAt !== null &&
			Date.parse(item.boughtAt) > receiptCutoff,
	);
	function dismissReceiptPrompt(): void {
		const now = new Date().toISOString();
		setReceiptSince(now);
		try {
			window.localStorage.setItem(receiptKey, now);
		} catch {
			// Hinweis bleibt dann nur in dieser Sitzung ausgeblendet.
		}
	}

	// Vorschläge ohne Artikel, die schon offen auf der Liste stehen.
	const openNames = new Set(open.map((item) => normalizeForMatch(item.name)));
	const lowStock = inventory
		.filter((item) => isBelowThreshold(item) && !openNames.has(normalizeForMatch(item.name)))
		.map((item) => item.name);
	const taken = new Set([...openNames, ...lowStock.map(normalizeForMatch)]);
	const frequent = [
		...inventory
			.filter((item) => item.decrementCount30d > 0)
			.sort((a, b) => b.decrementCount30d - a.decrementCount30d)
			.map((item) => item.name),
		...done.map((item) => item.name),
	].filter((name) => {
		const key = normalizeForMatch(name);
		if (taken.has(key)) return false;
		taken.add(key);
		return true;
	});
	const suggestionGroups = [
		{ label: 'Vorrat niedrig', names: lowStock.slice(0, 6) },
		frequent.length > 0
			? { label: 'Oft gekauft', names: frequent.slice(0, 6) }
			: {
					label: 'Vorschläge',
					names: QUICK_SHOPPING_ITEMS.map((item) => item.name).filter(
						(name) => !taken.has(normalizeForMatch(name)),
					),
				},
	].filter((group) => group.names.length > 0);

	function renderRow(item: ShoppingItem) {
		return (
			<ShoppingItemRow
				key={item.id}
				item={item}
				adder={memberLookup(item.addedByMemberId)}
				buyer={item.boughtByMemberId ? memberLookup(item.boughtByMemberId) : null}
				pending={isPending(item.id)}
				queued={queuedShoppingUpdateIds.has(item.id)}
				onToggle={toggleBought}
				onRemove={remove}
				removeError={removeErrorId === item.id ? removeError : null}
				canRemove={item.addedByMemberId === identity.memberId}
				highlighted={highlightedId === item.id}
				shareCode={wg.shareCode}
			/>
		);
	}

	return (
		<div data-household-content className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
			<SubNav liveCount={!initialLoading && !loadError ? open.length : undefined} />
			{/* Der aktive Tab benennt die Seite schon; Titel und Zähler bleiben für Screenreader. */}
			<header className="sr-only">
				<h1 className="font-heading text-[26px] leading-8 font-semibold tracking-tight text-foreground">
					Einkaufsliste
				</h1>
				<p
					className="mt-0.5 text-[12px] text-muted-foreground tabular-nums"
					aria-live="polite"
					aria-atomic="true"
				>
					{initialLoading && items.length === 0 ? 'Lädt…' : `${open.length} offen`}
				</p>
			</header>

			<div className="flex flex-col gap-3">
				{suggestionGroups.map((group) => (
					<div key={group.label} className="flex min-w-0 flex-col gap-1.5">
						<p className="text-sm font-medium text-muted-foreground">{group.label}</p>
						<ul aria-label={group.label} className="-mx-4 -my-1.5 flex flex-wrap gap-2 px-4 py-1.5">
							{group.names.map((name) => (
								<li key={name} className="min-w-0 max-w-full">
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={adding}
										onClick={() => void add(name)}
										onFocus={(event) => {
											if (!event.currentTarget.matches(':focus-visible')) return;
											const action = document.querySelector<HTMLElement>(
												'[data-page-primary-action]',
											);
											if (
												action &&
												event.currentTarget.getBoundingClientRect().bottom >
													action.getBoundingClientRect().top
											) {
												event.currentTarget.scrollIntoView({ block: 'start', inline: 'nearest' });
											}
										}}
										aria-label={`${name} hinzufügen`}
										className="min-w-0 max-w-full"
									>
										<Plus data-icon="inline-start" aria-hidden />
										<span className="truncate">{name}</span>
									</Button>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>

			{queuedCount > 0 && (
				<Alert>
					<AlertDescription>{formatQueuedOfflineEntries(queuedCount)}</AlertDescription>
				</Alert>
			)}
			{loadError && (
				<LoadErrorBanner
					message={loadError}
					onRetry={() => void load(false)}
					busy={initialLoading}
					retryLabel="Liste erneut laden"
				/>
			)}
			{actionError && (
				<Alert variant="destructive">
					<AlertDescription>{actionError}</AlertDescription>
				</Alert>
			)}
			{toggleNotice && (
				<Alert>
					<AlertDescription>{toggleNotice}</AlertDescription>
				</Alert>
			)}
			{removeNotice && (
				<Alert>
					<AlertDescription>{removeNotice}</AlertDescription>
				</Alert>
			)}
			{myFreshBought.length > 0 && (
				<Alert>
					<Receipt aria-hidden />
					<AlertDescription className="flex flex-col gap-2">
						<span>Beleg für {myFreshBought.length} Artikel als Ausgabe erfassen?</span>
						<span className="flex flex-wrap gap-2">
							<Link
								href={`${wgBaseHref}/ausgaben?new=1&desc=${encodeURIComponent(
									`Einkauf: ${myFreshBought
										.slice(0, 5)
										.map((item) => item.name)
										.join(', ')}`,
								)}`}
								onClick={dismissReceiptPrompt}
								className={cn(buttonVariants({ size: 'sm' }))}
							>
								Ausgabe erfassen
							</Link>
							<Button variant="ghost" size="sm" onClick={dismissReceiptPrompt}>
								Nicht jetzt
							</Button>
						</span>
					</AlertDescription>
				</Alert>
			)}

			{initialLoading && items.length === 0 ? (
				<ListSkeleton />
			) : loadError && items.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Noch keine Artikel geladen</EmptyTitle>
						<EmptyDescription>Versuche es erneut.</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : items.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ListChecks aria-hidden />
						</EmptyMedia>
						<EmptyTitle>Noch nichts auf der Liste</EmptyTitle>
						<EmptyDescription>Was fehlt bei euch?</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<section aria-label="Einkaufsartikel" className="flex flex-col gap-4">
					{openItems.length > 0 ? (
						<ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
							{openItems.map(renderRow)}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">Alles eingekauft.</p>
					)}
					{doneItems.length > 0 && (
						<details
							open={doneOpen}
							onToggle={(event) => setDoneOpen(event.currentTarget.open)}
							className="group"
						>
							<summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
								<ChevronRight
									aria-hidden
									className="size-4 transition-transform group-open:rotate-90"
								/>
								Erledigt ({doneItems.length})
							</summary>
							<ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
								{doneItems.map(renderRow)}
							</ul>
							{isAdmin && (
								<Button
									variant="outline"
									onClick={() => setClearConfirmOpen(true)}
									disabled={clearingBought}
									aria-label={`Erledigte Artikel entfernen (${done.length})`}
									className="mt-2 self-start"
								>
									{clearingBought ? (
										<Spinner data-icon="inline-start" aria-hidden />
									) : (
										<Trash2 data-icon="inline-start" aria-hidden />
									)}
									Erledigte entfernen
								</Button>
							)}
						</details>
					)}
				</section>
			)}
			<ThumbAction>
				<div className="flex flex-col gap-2 rounded-xl border border-border bg-background p-2">
					<form
						id="shopping-add-form"
						onSubmit={(event) => {
							event.preventDefault();
							void add();
						}}
						className="flex min-w-0 flex-wrap gap-2"
					>
						<Input
							id="shopping-name"
							ref={nameInputRef}
							value={newName}
							onChange={(event) => {
								nameValueRef.current = event.target.value;
								setNewName(event.target.value);
							}}
							maxLength={NAME_MAX}
							placeholder="z. B. 2 Hafermilch"
							aria-label="Artikel-Name"
							enterKeyHint="done"
							aria-invalid={Boolean(addError)}
							aria-describedby={addError ? 'shopping-add-error' : undefined}
							className="min-w-[200px] flex-1 text-base"
						/>
						<Button
							type="submit"
							size="icon"
							disabled={!newName.trim() || adding}
							aria-label="Artikel hinzufügen"
							onPointerDown={(event) => event.preventDefault()}
							className="size-11 shrink-0"
						>
							{adding ? <Spinner aria-hidden /> : <Plus aria-hidden />}
						</Button>
					</form>
					{addError && (
						<Alert id="shopping-add-error" variant="destructive">
							<AlertDescription>{addError}</AlertDescription>
						</Alert>
					)}
					{addNotice && (
						<Alert>
							<AlertDescription>{addNotice}</AlertDescription>
						</Alert>
					)}
				</div>
			</ThumbAction>
			{isAdmin && (
				<AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
					<AlertDialogContent className="max-w-[calc(100%-2rem)]">
						<AlertDialogHeader>
							<AlertDialogTitle>Erledigte Artikel entfernen?</AlertDialogTitle>
							<AlertDialogDescription>
								{done.length} erledigte Artikel werden für die ganze WG endgültig entfernt. Offene
								Artikel bleiben erhalten.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel className="min-h-11">Abbrechen</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								className="min-h-11 min-w-0 max-w-full shrink whitespace-normal"
								disabled={clearingBought}
								onClick={() => {
									setClearConfirmOpen(false);
									void clearBought();
								}}
							>
								Entfernen
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</div>
	);
}
