import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { isReadOnlyMode } from '@/core/http/error-codes';
import {
	type PendingIdempotentRequest,
	resolveIdempotencyKey,
	shouldReleaseIdempotencyKey,
} from '@/core/http/idempotency-key';
import { apiFetch } from '@/core/infra/api-client';
import type { NotificationWarning } from '@/core/notifications/notification-warning';
import { buildDraftKey, readDraft, removeDraft, writeDraft } from '@/core/offline/drafts';
import {
	enqueueOfflineAction,
	isOfflineActionQueued,
	removeQueuedAction,
} from '@/core/offline/offline-client';
import { createQueuedShoppingItem } from '@/core/offline/offline-queue';
import type { PendingOverlay } from '@/core/sync/use-synced-collection';
import { NAME_MAX } from '@/features/shopping/components/constants';
import type { ShoppingItem } from '@/features/shopping/components/shopping-types';
import { parseShoppingInput } from '@/features/shopping/parse-shopping-input';
import { shoppingAddError, shoppingDuplicateError } from '@/features/shopping/shopping-errors';
import { TEMP_ITEM_ID_PREFIX } from '@/features/shopping/shopping-view';
import { type Message, useMessage } from '@/shared/i18n/message';

type ShoppingCreateResponse = { item: ShoppingItem; warning: NotificationWarning };

interface UseShoppingAddOptions {
	wg: { id: string; shareCode: string };
	identity: { memberId: string };
	prefillName: string | null;
	commitItems: (update: (current: ShoppingItem[]) => ShoppingItem[]) => void;
	/** Unconfirmed rows; polls must not overwrite them. */
	pending: PendingOverlay<ShoppingItem>;
	load: (silent?: boolean, afterMutation?: boolean) => Promise<void>;
	refreshCount: () => void;
	setAddNotice: (notice: Message | null) => void;
	/** 409: name of the item that is already open on the list. */
	onDuplicate: (name: string) => void;
	/** An item typed into the field was saved (or queued); lets the page show where it landed. */
	onAdded?: (id: string) => void;
}

/** Input field, draft (including an offline entry being edited) and adding items. */
export function useShoppingAdd({
	wg,
	identity,
	prefillName,
	commitItems,
	pending,
	load,
	refreshCount,
	setAddNotice,
	onDuplicate,
	onAdded,
}: UseShoppingAddOptions) {
	const toast = useToast();
	const render = useMessage();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const [newName, setNewName] = useState('');
	const [addError, setAddError] = useState<Message | null>(null);
	const [adding, setAdding] = useState(false);
	const [queueEditId, setQueueEditId] = useState<string | null>(null);
	const [draftHydrated, setDraftHydrated] = useState(false);
	const addingRef = useRef(false);
	const inFlightRef = useRef<Promise<void> | null>(null);
	const inFlightTextRef = useRef<string | null>(null);
	const addIdempotencyKeyRef = useRef<PendingIdempotentRequest | null>(null);
	const nameValueRef = useRef('');
	const appliedPrefillRef = useRef<string | null>(null);
	const draftKey = buildDraftKey(wg.shareCode, identity.memberId, 'shopping');

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

	async function clearEditedQueueItem(): Promise<boolean> {
		if (!queueEditId) return true;
		if (!(await removeQueuedAction(queueEditId))) return false;
		setQueueEditId(null);
		return true;
	}

	/** Chips pass their text directly; only input from the field clears the field afterwards. */
	async function add(text?: string): Promise<void> {
		// Drop a double tap on a chip; Enter in the field while an add is running is queued
		// behind it instead of silently dropped (same text, same idempotency key).
		if (addingRef.current && text !== undefined) return;
		const fromInput = text === undefined;
		const submittedName = text ?? newName;
		// Double Enter or double tap on the same text: it is already running, and a second attempt
		// would only hit the duplicate check and show an error for an item that was saved.
		if (addingRef.current && submittedName === inFlightTextRef.current) return;
		// Remember the waiting input too: another Enter on the same text would otherwise be sent
		// a second time after the wait and hit the duplicate check.
		inFlightTextRef.current = submittedName;
		while (addingRef.current && inFlightRef.current) await inFlightRef.current;
		// A chip carries a complete item name ("7 Up"), so only typed input is split into amount and name.
		const { name, quantity } = fromInput
			? parseShoppingInput(submittedName)
			: { name: submittedName.trim(), quantity: null };
		if (name.length === 0) return;
		// The edited queue entry may have been synced meanwhile; a new create would duplicate it.
		if (fromInput && queueEditId && !isOfflineActionQueued(queueEditId)) {
			setQueueEditId(null);
			setNewName('');
			removeDraft(draftKey);
			setAddError(null);
			setAddNotice({ key: 'shopping.add.queueEditAlreadySent' });
			void load(true);
			return;
		}
		addingRef.current = true;
		inFlightTextRef.current = submittedName;
		let release: () => void = () => {};
		inFlightRef.current = new Promise<void>((resolve) => {
			release = resolve;
		});
		setAdding(true);
		setAddError(null);
		setAddNotice(null);
		const fingerprint = JSON.stringify({ name, quantity });
		const idempotencyKey = resolveIdempotencyKey(addIdempotencyKeyRef.current, fingerprint);
		if (!idempotencyKey) {
			setAddError({ key: 'shopping.add.keyUnavailable' });
			addingRef.current = false;
			inFlightRef.current = null;
			inFlightTextRef.current = null;
			release();
			setAdding(false);
			return;
		}
		addIdempotencyKeyRef.current = { fingerprint, key: idempotencyKey };
		// Clear the field right away; restore it below on failure (only if it is still empty).
		let saved = false;
		if (fromInput) {
			nameValueRef.current = '';
			setNewName('');
		}
		// The item shows up at once; on success the row is replaced in place by the saved one,
		// on failure it disappears again (the error shows below the list).
		const tempId = `${TEMP_ITEM_ID_PREFIX}${idempotencyKey}`;
		const tempItem: ShoppingItem = {
			id: tempId,
			addedByMemberId: identity.memberId,
			name,
			quantity,
			boughtAt: null,
			boughtByMemberId: null,
			createdAt: new Date().toISOString(),
		};
		pending.set(tempItem);
		commitItems((prev) => [tempItem, ...prev]);
		const settleTemp = (replacement: ShoppingItem | null): void => {
			pending.delete(tempId);
			commitItems((prev) => {
				if (replacement && prev.some((i) => i.id === replacement.id)) {
					return prev.filter((i) => i.id !== tempId);
				}
				return replacement
					? prev.map((i) => (i.id === tempId ? replacement : i))
					: prev.filter((i) => i.id !== tempId);
			});
		};
		try {
			const res = await apiFetch<ShoppingCreateResponse>(`/api/wg/${encodedShareCode}/shopping`, {
				method: 'POST',
				memberId: identity.memberId,
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
				if (shouldReleaseIdempotencyKey(res.status, res.error)) addIdempotencyKeyRef.current = null;
				if (res.status === 0) {
					const queued = createQueuedShoppingItem({
						wgId: wg.id,
						shareCode: wg.shareCode,
						memberId: identity.memberId,
						idempotencyKey,
						name,
						quantity,
					});
					if ((await enqueueOfflineAction(queued)) === 0) {
						settleTemp(null);
						setAddError({ key: 'shopping.add.queueBlocked' });
						return;
					}
					addIdempotencyKeyRef.current = null;
					refreshCount();
					if (fromInput && !(await clearEditedQueueItem())) {
						setAddError({ key: 'shopping.add.draftCleanupFailedOffline' });
						return;
					}
					settleTemp({ ...tempItem, id: queued.id, createdAt: queued.createdAt });
					saved = true;
					if (fromInput) onAdded?.(queued.id);
					if (fromInput && nameValueRef.current === '') removeDraft(draftKey);
					setAddNotice({ key: 'shopping.add.savedOffline' });
					return;
				}
				settleTemp(null);
				const duplicate = res.status === 409 && res.error === 'shopping_item_duplicate';
				setAddError(
					duplicate
						? shoppingDuplicateError(name, Boolean(quantity))
						: // The middleware rejects 429 and read-only mode before any processing: nothing was saved.
							retryableResponse && res.status !== 429 && !isReadOnlyMode(res.error)
							? { key: 'shopping.add.retryHint' }
							: shoppingAddError(res.error),
				);
				// The message shows at once; the refresh behind it can be slow.
				if (duplicate) {
					await load(true);
					onDuplicate(name);
				}
				if (retryableResponse) await load(true);
				return;
			}
			addIdempotencyKeyRef.current = null;
			settleTemp(res.data.item ?? null);
			if (fromInput && !(await clearEditedQueueItem())) {
				setAddError({ key: 'shopping.add.draftCleanupFailed' });
				return;
			}
			saved = true;
			if (fromInput && res.data.item) onAdded?.(res.data.item.id);
			if (fromInput && nameValueRef.current === '') removeDraft(draftKey);
			const warning = res.data.warning;
			if (warning) {
				toast.info(
					render({
						key:
							warning === 'notification_delivery_failed'
								? 'shopping.add.deliveryFailed'
								: 'shopping.add.deliveryUnknown',
					}),
				);
				// Chips: the suggestion disappears, and the new row may lie outside the viewport.
			} else if (!fromInput)
				toast.success(render({ key: 'shopping.suggestions.added', values: { name } }));
			void load(true, true);
		} finally {
			// No placeholder row may stay behind, not even after an exception.
			if (pending.has(tempId)) settleTemp(null);
			if (fromInput && !saved && nameValueRef.current === '') {
				nameValueRef.current = submittedName;
				setNewName(submittedName);
			}
			addingRef.current = false;
			inFlightRef.current = null;
			inFlightTextRef.current = null;
			release();
			setAdding(false);
		}
	}

	function changeName(value: string): void {
		const next = value.replace(/^\s+/, '');
		nameValueRef.current = next;
		setNewName(next);
	}

	return { newName, changeName, adding, addError, add };
}
