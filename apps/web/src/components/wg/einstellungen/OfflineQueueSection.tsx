'use client';

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ItemGroup } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { Section } from '@/components/wg/einstellungen/Section';
import { apiFetch } from '@/core/infra/api-client';
import {
	type QueueEditDraft,
	buildDraftKey,
	buildQueueEditHref,
	isEmptyModuleDraft,
	readDraft,
	writeDraft,
} from '@/core/offline/drafts';
import {
	needsManualOfflineResolution,
	readOfflineQueue,
	syncOfflineActions,
	updateOfflineQueue,
} from '@/core/offline/offline-client';
import { formatOfflineQueueCount } from '@/core/offline/offline-copy';
import { isPendingImageToken, removePendingImage } from '@/core/offline/offline-images';
import {
	type OfflineAction,
	explainOfflineActionFailure,
	getOfflineActionSummary,
} from '@/core/offline/offline-queue';
import { cn } from '@/shared/lib/cn';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { OfflineQueueItem } from './OfflineQueueItem';
import { SERVER_CHECKS, offlineActionInspectHref } from './offline-queue-server-checks';

function discardSummary(item: OfflineAction): string {
	const summary = getOfflineActionSummary(item);
	return summary.detail || summary.title;
}

export function OfflineQueueSection({
	shareCode,
	memberId,
}: {
	shareCode: string;
	memberId: string;
}) {
	const [items, setItems] = useState<OfflineAction[]>([]);
	const [syncing, setSyncing] = useState(false);
	const [conflictNotes, setConflictNotes] = useState<Record<string, string>>({});
	const [checkingServerIds, setCheckingServerIds] = useState<Set<string>>(new Set());
	const [itemToDiscard, setItemToDiscard] = useState<OfflineAction | null>(null);
	const syncingRef = useRef(false);
	const checkingServerIdsRef = useRef<Set<string>>(new Set());
	const encodedShareCode = encodeURIComponent(shareCode);
	const isActiveMemberItem = useCallback(
		(item: OfflineAction): boolean => item.shareCode === shareCode && item.memberId === memberId,
		[memberId, shareCode],
	);
	const hasRetryableItems = items.some((item) => !needsManualOfflineResolution(item));

	const refresh = useCallback((): void => {
		setItems(readOfflineQueue().filter(isActiveMemberItem));
	}, [isActiveMemberItem]);

	useEffect(() => {
		refresh();
		window.addEventListener('manawg:offline-queue', refresh);
		return () => window.removeEventListener('manawg:offline-queue', refresh);
	}, [refresh]);

	async function remove(item: OfflineAction): Promise<void> {
		const id = item.id;
		const saved = await updateOfflineQueue((actions) =>
			actions.filter((item) => item.id !== id || !isActiveMemberItem(item)),
		);
		if (!saved) {
			setConflictNotes((current) => ({
				...current,
				[id]: 'Offline-Speicher ist blockiert. Die Aktion konnte nicht verworfen werden.',
			}));
			return;
		}
		// The queued photo only lives in IndexedDB; drop it with its action.
		dropPendingImage(item.payload.imageUrl);
		refresh();
	}

	function dropPendingImage(imageUrl: unknown): void {
		if (typeof imageUrl === 'string' && isPendingImageToken(imageUrl)) {
			void removePendingImage(imageUrl, memberId).catch(() => undefined);
		}
	}

	async function removeAttachment(id: string): Promise<void> {
		const imageUrl = items.find((item) => item.id === id)?.payload.imageUrl;
		const saved = await updateOfflineQueue((actions) =>
			actions.map((item) =>
				item.id === id && isActiveMemberItem(item)
					? { ...item, payload: { ...item.payload, imageUrl: null } }
					: item,
			),
		);
		if (!saved) {
			setConflictNotes((current) => ({
				...current,
				[id]: 'Offline-Speicher ist blockiert. Der Anhang konnte nicht entfernt werden.',
			}));
			return;
		}
		dropPendingImage(imageUrl);
		setConflictNotes((current) => ({
			...current,
			[id]: 'Anhang entfernt. Die Offline-Aktion kann wieder synchronisiert werden.',
		}));
		refresh();
	}

	// The page that reads the draft is derived from the draft's own module, so
	// the draft key and the opened form can never disagree.
	function editHref(item: OfflineAction, draft: QueueEditDraft): string {
		return buildQueueEditHref(shareCode, draft.module, {
			openAbsencesPanel: item.type === 'absence.create',
		});
	}

	function edit(item: OfflineAction, draft: QueueEditDraft): void {
		const key = buildDraftKey(shareCode, memberId, draft.module);
		// Never clobber an unsaved form draft with queue-edit data — it would
		// be lost without any hint. Ask the user to resolve the form first.
		const existing = readDraft<Record<string, unknown>>(key);
		if (
			existing &&
			!isEmptyModuleDraft(draft.module, existing, memberId) &&
			JSON.stringify(existing) !== JSON.stringify(draft.draft)
		) {
			setConflictNotes((current) => ({
				...current,
				[item.id]:
					'Es existiert bereits ein anderer ungespeicherter Formular-Entwurf für dieses Modul. Öffne das Formular, speichere oder verwerfe ihn, und bearbeite dann den Eintrag in der Warteschlange.',
			}));
			return;
		}
		const saved = writeDraft(key, draft.draft);
		if (!saved) {
			setConflictNotes((current) => ({
				...current,
				[item.id]:
					'Offline-Speicher ist blockiert. Der Entwurf konnte nicht zum Bearbeiten geöffnet werden.',
			}));
			return;
		}
		window.location.assign(editHref(item, draft));
	}

	function setConflictNote(id: string, note: string): void {
		setConflictNotes((current) => ({ ...current, [id]: note }));
	}

	function setServerCheckError(id: string, status: number, error: string): void {
		if (
			error === 'not_a_member' ||
			error === 'member_id_required' ||
			error === 'member_id_invalid' ||
			error === 'wg_not_found' ||
			error === 'invalid_share_code'
		) {
			const failure = explainOfflineActionFailure(status, error);
			setConflictNote(id, `${failure.title}: ${failure.detail}`);
			return;
		}
		setConflictNote(
			id,
			'Server-Vergleich konnte nicht geladen werden. Versuche es erneut, bevor du diese Aktion sendest.',
		);
	}

	async function checkServer(item: OfflineAction): Promise<void> {
		if (checkingServerIdsRef.current.has(item.id)) return;
		checkingServerIdsRef.current = new Set(checkingServerIdsRef.current).add(item.id);
		setCheckingServerIds(new Set(checkingServerIdsRef.current));
		try {
			await checkServerInner(item);
		} finally {
			const next = new Set(checkingServerIdsRef.current);
			next.delete(item.id);
			checkingServerIdsRef.current = next;
			setCheckingServerIds(next);
		}
	}

	async function checkServerInner(item: OfflineAction): Promise<void> {
		const check = SERVER_CHECKS[item.type];
		if (!check) {
			setConflictNote(
				item.id,
				'Server-Vergleich bereit: bearbeite den Entwurf, wenn sich Inhalt oder Aufteilung geändert haben.',
			);
			return;
		}
		const res = await apiFetch<unknown>(`/api/wg/${encodedShareCode}/${check.path}`, { memberId });
		if (!res.ok) {
			setServerCheckError(item.id, res.status, res.error);
			return;
		}
		setConflictNote(item.id, check.note(item.payload, res.data as never));
	}

	async function retry(): Promise<void> {
		if (syncingRef.current || !hasRetryableItems) return;
		syncingRef.current = true;
		setSyncing(true);
		try {
			await syncOfflineActions(shareCode, { force: true, memberId });
			refresh();
		} finally {
			syncingRef.current = false;
			setSyncing(false);
		}
	}

	return (
		<Section title="Offline-Warteschlange">
			<div className="grid gap-2 p-3">
				<div
					className={cn(
						'flex flex-wrap items-center justify-between gap-3',
						hasRetryableItems && 'min-h-[44px]',
					)}
				>
					<p className="text-muted-foreground text-xs">{formatOfflineQueueCount(items.length)}</p>
					{hasRetryableItems && (
						<Button
							type="button"
							variant="outline"
							onClick={() => void retry()}
							disabled={syncing}
							aria-label={
								syncing
									? 'Offline-Warteschlange wird synchronisiert'
									: 'Offline-Warteschlange erneut synchronisieren'
							}
						>
							{syncing && <Spinner aria-hidden />}
							Erneut versuchen
						</Button>
					)}
				</div>
				{items.length > 0 && (
					<ItemGroup className="gap-2">
						{items.map((item) => (
							<OfflineQueueItem
								key={item.id}
								item={item}
								inspectHref={offlineActionInspectHref(shareCode, item)}
								conflictNote={conflictNotes[item.id]}
								syncing={syncing}
								checkingServer={checkingServerIds.has(item.id)}
								onCheckServer={() => void checkServer(item)}
								onEdit={(draft) => edit(item, draft)}
								onRemoveAttachment={() => void removeAttachment(item.id)}
								onRemove={() => setItemToDiscard(item)}
							/>
						))}
					</ItemGroup>
				)}
			</div>
			<AlertDialog
				open={itemToDiscard !== null}
				onOpenChange={(open) => {
					if (!open) setItemToDiscard(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia>
							<Trash2 aria-hidden />
						</AlertDialogMedia>
						<AlertDialogTitle>Offline-Aktion verwerfen?</AlertDialogTitle>
						<AlertDialogDescription>
							{itemToDiscard &&
								`„${discardSummary(itemToDiscard)}“ wurde noch nicht gesendet und lässt sich nach dem Verwerfen nicht wiederherstellen.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel autoFocus>Behalten</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (itemToDiscard) void remove(itemToDiscard);
								setItemToDiscard(null);
							}}
						>
							Verwerfen
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Section>
	);
}
