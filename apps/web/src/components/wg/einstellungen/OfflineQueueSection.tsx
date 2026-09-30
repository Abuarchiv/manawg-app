'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { Section } from '@/components/wg/einstellungen/Section';
import { apiFetch } from '@/core/infra/api-client';
import {
	type QueueEditDraft,
	buildDraftKey,
	buildQueueEditActionHref,
	buildQueueEditDraft,
	isEmptyModuleDraft,
	readDraft,
	writeDraft,
} from '@/core/offline/drafts';
import {
	readOfflineQueue,
	syncOfflineActions,
	writeOfflineQueue,
} from '@/core/offline/offline-client';
import {
	formatRecurringAdvanceConflictNote,
	formatRecurringTemplateConflictNote,
} from '@/core/offline/offline-conflicts';
import { formatOfflineQueueCount } from '@/core/offline/offline-copy';
import {
	type OfflineAction,
	explainOfflineActionFailure,
	getOfflineActionRisk,
	getOfflineActionSummary,
} from '@/core/offline/offline-queue';
import { useCallback, useEffect, useRef, useState } from 'react';

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
	const syncingRef = useRef(false);
	const checkingServerIdsRef = useRef<Set<string>>(new Set());
	const encodedShareCode = encodeURIComponent(shareCode);
	const isActiveMemberItem = useCallback(
		(item: OfflineAction): boolean => item.shareCode === shareCode && item.memberId === memberId,
		[memberId, shareCode],
	);

	const refresh = useCallback((): void => {
		setItems(readOfflineQueue().filter(isActiveMemberItem));
	}, [isActiveMemberItem]);

	useEffect(() => {
		refresh();
		window.addEventListener('manawg:offline-queue', refresh);
		return () => window.removeEventListener('manawg:offline-queue', refresh);
	}, [refresh]);

	function remove(id: string): void {
		const saved = writeOfflineQueue(
			readOfflineQueue().filter((item) => item.id !== id || !isActiveMemberItem(item)),
		);
		if (!saved) {
			setConflictNotes((current) => ({
				...current,
				[id]: 'Offline-Speicher ist blockiert. Die Aktion konnte nicht verworfen werden.',
			}));
			return;
		}
		refresh();
	}

	function removeAttachment(id: string): void {
		const saved = writeOfflineQueue(
			readOfflineQueue().map((item) =>
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
		setConflictNotes((current) => ({
			...current,
			[id]: 'Anhang entfernt. Die Offline-Aktion kann wieder synchronisiert werden.',
		}));
		refresh();
	}

	function edit(item: OfflineAction, draft: QueueEditDraft, href: string): void {
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
					'Es existiert bereits ein anderer ungespeicherter Formular-Entwurf für dieses Modul. Öffne das Formular, speichere oder verwerfe ihn, und bearbeite dann den Queue-Eintrag.',
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
		window.location.assign(href);
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
		if (item.type === 'shopping.create') {
			const name = String(item.payload.name ?? '').trim();
			const res = await apiFetch<{
				items: Array<{ name: string; quantity: string | null; boughtAt: string | null }>;
			}>(`/api/wg/${encodedShareCode}/shopping`, { memberId });
			if (!res.ok) {
				setServerCheckError(item.id, res.status, res.error);
				return;
			}
			const serverItem = res.data.items.find((shoppingItem) => shoppingItem.name.trim() === name);
			setConflictNote(
				item.id,
				serverItem
					? `Ähnlicher Einkaufsartikel existiert schon. Status dort: ${
							serverItem.boughtAt ? 'erledigt' : 'offen'
						}. Prüfe vor dem Senden, ob es ein Duplikat wäre.`
					: 'Kein gleichnamiger Einkaufsartikel auf dem Server gefunden.',
			);
			return;
		}
		if (item.type === 'shopping.update') {
			const itemId = String(item.payload.itemId ?? '');
			const res = await apiFetch<{
				items: Array<{ id: string; boughtAt: string | null }>;
			}>(`/api/wg/${encodedShareCode}/shopping`, { memberId });
			if (!res.ok) {
				setServerCheckError(item.id, res.status, res.error);
				return;
			}
			const serverItem = res.data.items.find((shoppingItem) => shoppingItem.id === itemId);
			setConflictNote(
				item.id,
				serverItem
					? `Server-Version gefunden. Status dort: ${
							serverItem.boughtAt ? 'erledigt' : 'offen'
						}. Prüfe vor dem erneuten Senden, ob das noch stimmt.`
					: 'Der Einkaufsartikel existiert serverseitig nicht mehr.',
			);
			return;
		}
		if (item.type === 'announcement.create') {
			const content = String(item.payload.content ?? '').trim();
			const res = await apiFetch<{
				announcements: Array<{ content: string; resolvedAt?: string | null }>;
			}>(`/api/wg/${encodedShareCode}/announcements`, { memberId });
			if (!res.ok) {
				setServerCheckError(item.id, res.status, res.error);
				return;
			}
			const serverPost = res.data.announcements.find(
				(announcement) => announcement.content.trim() === content,
			);
			setConflictNote(
				item.id,
				serverPost
					? `Gleicher Pinnwand-Beitrag existiert schon. Status dort: ${
							serverPost.resolvedAt ? 'geklärt' : 'offen'
						}. Prüfe vor dem Senden, ob es ein Duplikat wäre.`
					: 'Kein gleicher Pinnwand-Beitrag auf dem Server gefunden.',
			);
			return;
		}
		if (item.type === 'chore.complete') {
			const choreId = String(item.payload.choreId ?? '');
			const res = await apiFetch<{
				chores: Array<{ id: string; assignedMemberId: string | null }>;
			}>(`/api/wg/${encodedShareCode}/chores`, { memberId });
			if (!res.ok) {
				setServerCheckError(item.id, res.status, res.error);
				return;
			}
			const exists = res.data.chores.some((chore) => chore.id === choreId);
			setConflictNote(
				item.id,
				exists
					? 'Server-Version gefunden. Prüfe Zuständigkeit und Fälligkeit vor dem Senden.'
					: 'Die Aufgabe existiert serverseitig nicht mehr.',
			);
			return;
		}
		if (item.type === 'chore.create') {
			const title = String(item.payload.title ?? '').trim();
			const res = await apiFetch<{
				chores: Array<{ title: string; assignedMemberId: string | null; intervalDays: number }>;
			}>(`/api/wg/${encodedShareCode}/chores`, { memberId });
			if (!res.ok) {
				setServerCheckError(item.id, res.status, res.error);
				return;
			}
			const serverChore = res.data.chores.find((chore) => chore.title.trim() === title);
			setConflictNote(
				item.id,
				serverChore
					? `Gleiche Putzaufgabe existiert schon. Intervall dort: alle ${serverChore.intervalDays} Tage. Prüfe vor dem Senden, ob es ein Duplikat wäre.`
					: 'Keine gleichnamige Putzaufgabe auf dem Server gefunden.',
			);
			return;
		}
		if (item.type === 'absence.create') {
			const absenceMemberId = String(item.payload.memberId ?? '');
			const startDate = String(item.payload.startDate ?? '');
			const endDate = String(item.payload.endDate ?? '');
			const res = await apiFetch<{
				absences: Array<{ memberId: string; startDate: string; endDate: string }>;
			}>(`/api/wg/${encodedShareCode}/absences`, { memberId });
			if (!res.ok) {
				setServerCheckError(item.id, res.status, res.error);
				return;
			}
			const serverAbsence = res.data.absences.find(
				(absence) =>
					absence.memberId === absenceMemberId &&
					absence.startDate === startDate &&
					absence.endDate === endDate,
			);
			setConflictNote(
				item.id,
				serverAbsence
					? 'Gleiche Abwesenheit existiert schon auf dem Server.'
					: 'Keine gleiche Abwesenheit auf dem Server gefunden.',
			);
			return;
		}
		if (item.type === 'expense.create') {
			const description = String(item.payload.description ?? '').trim();
			const amountCents = Number(item.payload.amountCents ?? 0);
			const res = await apiFetch<{
				expenses: Array<{ description: string; amountCents: number }>;
			}>(`/api/wg/${encodedShareCode}/expenses`, { memberId });
			if (!res.ok) {
				setServerCheckError(item.id, res.status, res.error);
				return;
			}
			const serverExpense = res.data.expenses.find(
				(expense) =>
					expense.description.trim() === description && expense.amountCents === amountCents,
			);
			setConflictNote(
				item.id,
				serverExpense
					? 'Gleiche Ausgabe mit gleichem Betrag existiert schon. Prüfe vor dem Senden, ob es ein Duplikat wäre.'
					: 'Keine gleiche Ausgabe mit gleichem Betrag auf dem Server gefunden.',
			);
			return;
		}
		if (item.type === 'recurring.create') {
			const description = String(item.payload.description ?? '').trim();
			const amountCents = Number(item.payload.amountCents ?? 0);
			const res = await apiFetch<{
				recurringExpenses: Array<{ description: string; amountCents: number; nextDueAt: string }>;
			}>(`/api/wg/${encodedShareCode}/recurring-expenses`, { memberId });
			if (!res.ok) {
				setServerCheckError(item.id, res.status, res.error);
				return;
			}
			const serverTemplate = res.data.recurringExpenses.find(
				(template) =>
					template.description.trim() === description && template.amountCents === amountCents,
			);
			setConflictNote(
				item.id,
				serverTemplate
					? formatRecurringTemplateConflictNote(serverTemplate)
					: 'Keine gleiche Fixkosten-Vorlage auf dem Server gefunden.',
			);
			return;
		}
		if (item.type === 'recurring.advance') {
			const recurringExpenseId = String(item.payload.recurringExpenseId ?? '');
			const expectedNextDueAt = String(item.payload.expectedRecurringNextDueAt ?? '');
			const res = await apiFetch<{
				recurringExpenses: Array<{ id: string; nextDueAt: string }>;
			}>(`/api/wg/${encodedShareCode}/recurring-expenses`, { memberId });
			if (!res.ok) {
				setServerCheckError(item.id, res.status, res.error);
				return;
			}
			const serverTemplate = res.data.recurringExpenses.find(
				(template) => template.id === recurringExpenseId,
			);
			setConflictNote(
				item.id,
				serverTemplate
					? formatRecurringAdvanceConflictNote(serverTemplate, expectedNextDueAt)
					: 'Diese Fixkosten-Vorlage existiert serverseitig nicht mehr.',
			);
			return;
		}
		setConflictNote(
			item.id,
			'Server-Vergleich bereit: bearbeite den Entwurf, wenn sich Inhalt oder Aufteilung geändert haben.',
		);
	}

	async function retry(): Promise<void> {
		if (syncingRef.current || items.length === 0) return;
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
		<Section
			title="Offline-Warteschlange"
			hint="Aktionen, die ohne Netz vorgemerkt wurden und später synchronisiert werden."
		>
			<div className="grid gap-3 p-3">
				<div className="flex min-h-[44px] items-center justify-between gap-3">
					<p className="text-muted-foreground text-[13px]">
						{formatOfflineQueueCount(items.length)}
					</p>
					<Button
						type="button"
						variant="outline"
						onClick={() => void retry()}
						disabled={syncing || items.length === 0}
						aria-label={
							syncing
								? 'Offline-Warteschlange wird synchronisiert'
								: 'Offline-Warteschlange erneut synchronisieren'
						}
						className="shrink-0"
					>
						{syncing && <Spinner aria-hidden />}
						Erneut versuchen
					</Button>
				</div>
				{items.length > 0 && (
					<ItemGroup className="gap-2">
						{items.map((item) => {
							const summary = getOfflineActionSummary(item);
							const fallback = explainOfflineActionFailure(0);
							const risk = getOfflineActionRisk(item);
							const editDraft = buildQueueEditDraft(item);
							// Null → no page owns this draft; the button stays visible but
							// disabled instead of routing to an unrelated form.
							const editHref = buildQueueEditActionHref(shareCode, item.type);
							const serverCheckLabel = `Server prüfen: ${summary.detail || summary.title}`;
							const actionLabel = summary.detail || summary.title;
							const rowBusy = syncing || checkingServerIds.has(item.id);
							return (
								<Item key={item.id} variant="outline" className="items-start">
									<ItemContent className="min-w-0">
										<ItemTitle>
											<span className="min-w-0 flex-1 truncate">{summary.title}</span>
											{item.attempts ? <Badge variant="destructive">{item.attempts}x</Badge> : null}
										</ItemTitle>
										<ItemDescription className="line-clamp-none">{summary.detail}</ItemDescription>
										<p className="text-muted-foreground line-clamp-2 text-xs">
											{item.lastError ?? fallback.detail}
										</p>
										{risk && (
											<Alert className="mt-1">
												<AlertDescription>
													{risk.title}: {risk.detail}
												</AlertDescription>
											</Alert>
										)}
										{conflictNotes[item.id] && (
											<Alert className="mt-1">
												<AlertDescription>{conflictNotes[item.id]}</AlertDescription>
											</Alert>
										)}
										<div className="mt-2 flex flex-wrap gap-2">
											<Button
												type="button"
												variant="outline"
												size="sm"
												aria-label={serverCheckLabel}
												onClick={() => void checkServer(item)}
												disabled={rowBusy}
											>
												{checkingServerIds.has(item.id) && <Spinner aria-hidden />}
												{checkingServerIds.has(item.id) ? 'Prüft…' : 'Server prüfen'}
											</Button>
											{editDraft ? (
												<Button
													type="button"
													variant="ghost"
													size="sm"
													aria-label={`Offline-Aktion bearbeiten: ${actionLabel}`}
													onClick={() => {
														if (editHref) edit(item, editDraft, editHref);
													}}
													disabled={rowBusy || editHref === null}
													title={
														editHref === null
															? 'Für diese Aktion gibt es kein Formular zum Bearbeiten.'
															: undefined
													}
												>
													Bearbeiten
												</Button>
											) : null}
											{item.payload.imageUrl ? (
												<Button
													type="button"
													variant="ghost"
													size="sm"
													aria-label={`Anhang entfernen: ${actionLabel}`}
													onClick={() => removeAttachment(item.id)}
													disabled={rowBusy}
												>
													Anhang weg
												</Button>
											) : null}
											<Button
												type="button"
												variant="destructive"
												size="sm"
												aria-label={`Offline-Aktion verwerfen: ${actionLabel}`}
												onClick={() => remove(item.id)}
												disabled={rowBusy}
											>
												Verwerfen
											</Button>
										</div>
									</ItemContent>
								</Item>
							);
						})}
					</ItemGroup>
				)}
			</div>
		</Section>
	);
}
