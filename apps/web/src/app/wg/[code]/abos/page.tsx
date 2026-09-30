'use client';

import { useToast } from '@/components/ui/Toast';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Item, ItemContent, ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { AboCreateModal } from '@/components/wg/AboCreateModal';
import { AboEditModal } from '@/components/wg/AboEditModal';
import type { AboFormValues } from '@/components/wg/AboForm';
import { AbosList } from '@/components/wg/AbosList';
import {
	type ActionNotice,
	ActionNoticeBanner,
	type ActionNoticeTone,
} from '@/components/wg/ActionNoticeBanner';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { SubNav } from '@/components/wg/SubNav';
import { ThumbAction } from '@/components/wg/ThumbAction';
import { useWg } from '@/components/wg/WgContextProvider';
import type { Abo, AboFilter } from '@/components/wg/abos-types';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { formatEuroCents } from '@/core/utils/money';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { getDueRecurringExpenses } from '@/features/expenses/recurring-expenses';
import { cn } from '@/shared/lib/cn';
import { haptic } from '@/shared/lib/haptics';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface RecurringExpensesResponse {
	recurringExpenses: Abo[];
}

interface RecurringExpenseResponse {
	recurringExpense: Abo;
}

function sortByNextDue(abos: Abo[]): Abo[] {
	return [...abos].sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

function upsertAbo(current: Abo[], next: Abo): Abo[] {
	const existing = current.some((abo) => abo.id === next.id);
	return sortByNextDue(
		existing ? current.map((abo) => (abo.id === next.id ? next : abo)) : [...current, next],
	);
}

const RETRYABLE_ERRORS = new Set(['unexpected_error', 'server_error', 'db_error']);
const MEMBERSHIP_ERRORS = new Set(['not_a_member', 'member_id_required', 'member_id_invalid']);

function aboSaveErrorMessage(error: string, action: 'angelegt' | 'aktualisiert'): string {
	const prefix = `Fixkosten konnten nicht ${action} werden`;
	if (RETRYABLE_ERRORS.has(error)) {
		return `${prefix}: Versuche es gleich erneut.`;
	}
	if (error === 'wg_not_found') {
		return `${prefix}: Öffne die WG über den aktuellen Link erneut.`;
	}
	if (error === 'invalid_share_code') {
		return `${prefix}: Der WG-Code ist ungültig.`;
	}
	if (MEMBERSHIP_ERRORS.has(error)) {
		return `${prefix}: Tritt der WG erneut bei.`;
	}
	if (error === 'member_not_in_wg') {
		return `${prefix}: Mindestens ein Mitglied ist nicht mehr in dieser WG.`;
	}
	if (error === 'recurring_expense_not_found') {
		return 'Diese Fixkosten existieren nicht mehr. Lade die Liste neu.';
	}
	if (error === 'amount_invalid') {
		return `${prefix}: Prüfe den Betrag.`;
	}
	if (error === 'recurring_currency_unsupported') {
		return `${prefix}: Fixkosten werden derzeit nur in Euro unterstützt.`;
	}
	if (error === 'description_invalid') {
		return `${prefix}: Gib eine Beschreibung ein.`;
	}
	if (error === 'interval_invalid') {
		return `${prefix}: Wähle ein gültiges Intervall.`;
	}
	if (error === 'due_date_invalid') {
		return `${prefix}: Prüfe das nächste Fälligkeitsdatum.`;
	}
	if (error === 'splits_invalid' || error === 'splits_sum_mismatch') {
		return 'Beträge stimmen nicht überein: Summe muss exakt dem Gesamtbetrag entsprechen.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return `${prefix}: Die Anfrage war ungültig.`;
	}
	return `${prefix}.`;
}

function aboActionErrorMessage(error: string): string {
	if (error === 'Netzwerkfehler' || error === 'Failed to fetch') {
		return 'Fixkosten-Aktion fehlgeschlagen: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (RETRYABLE_ERRORS.has(error)) {
		return 'Fixkosten-Aktion fehlgeschlagen: Versuche es gleich erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Fixkosten-Aktion fehlgeschlagen: Öffne die WG über den aktuellen Link erneut.';
	}
	if (error === 'invalid_share_code') {
		return 'Fixkosten-Aktion fehlgeschlagen: Der WG-Code ist ungültig.';
	}
	if (MEMBERSHIP_ERRORS.has(error)) {
		return 'Fixkosten-Aktion fehlgeschlagen: Tritt der WG erneut bei.';
	}
	if (error === 'recurring_expense_not_found') {
		return 'Diese Fixkosten existieren nicht mehr. Lade die Liste neu.';
	}
	if (error === 'recurring_currency_unsupported') {
		return 'Fixkosten-Aktion fehlgeschlagen: Fixkosten werden derzeit nur in Euro unterstützt.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return 'Fixkosten-Aktion fehlgeschlagen: Die Anfrage war ungültig.';
	}
	return 'Fixkosten-Aktion fehlgeschlagen.';
}

function aboDeleteErrorMessage(error: string): string {
	if (error === 'Netzwerkfehler' || error === 'Failed to fetch') {
		return 'Fixkosten konnten nicht gelöscht werden: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (RETRYABLE_ERRORS.has(error)) {
		return 'Fixkosten konnten nicht gelöscht werden: Versuche es gleich erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Fixkosten konnten nicht gelöscht werden: Öffne die WG über den aktuellen Link erneut.';
	}
	if (error === 'invalid_share_code') {
		return 'Fixkosten konnten nicht gelöscht werden: Der WG-Code ist ungültig.';
	}
	if (MEMBERSHIP_ERRORS.has(error)) {
		return 'Fixkosten konnten nicht gelöscht werden: Tritt der WG erneut bei.';
	}
	if (error === 'id_invalid') {
		return 'Fixkosten konnten nicht gelöscht werden: Der Eintrag konnte nicht eindeutig zugeordnet werden.';
	}
	if (error === 'recurring_expense_not_found') {
		return 'Diese Fixkosten existieren nicht mehr. Lade die Liste neu.';
	}
	if (error === 'delete_failed') {
		return 'Fixkosten konnten nicht gelöscht werden: Lade die Liste neu und prüfe, ob der Eintrag noch existiert.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return 'Fixkosten konnten nicht gelöscht werden: Die Anfrage war ungültig.';
	}
	return 'Fixkosten konnten nicht gelöscht werden.';
}

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function AbosPage() {
	const { wg, members, identity } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const {
		data: cachedAbos,
		error: abosReadError,
		isLoading: abosReadLoading,
		refresh: refreshAbos,
		setData: setCachedAbos,
	} = useCachedFetch<RecurringExpensesResponse>(`/api/wg/${encodedShareCode}/recurring-expenses`, {
		memberId: identity.memberId,
	});
	const memberOptions = useMemo(
		() => members.map((member) => ({ ...member, color: member.color ?? null })),
		[members],
	);

	const [abos, setAbos] = useState<Abo[]>(() =>
		cachedAbos ? sortByNextDue(cachedAbos.recurringExpenses) : [],
	);
	const [filter, setFilter] = useState<AboFilter>('active');
	const [loading, setLoading] = useState(abosReadLoading);
	const [refreshing, setRefreshing] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [notice, setNotice] = useState<ActionNotice | null>(null);
	const [showCreate, setShowCreate] = useState(false);
	const [editing, setEditing] = useState<Abo | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [deleteCandidate, setDeleteCandidate] = useState<Abo | null>(null);
	const createRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const hasAbosDataRef = useRef(cachedAbos !== undefined);

	function updateAbos(update: (current: Abo[]) => Abo[]): void {
		setAbos(update);
		setCachedAbos((current) => {
			const previous = current?.recurringExpenses ?? abos;
			const next = update(previous);
			if (!current && next === previous) return current;
			return { ...(current ?? { recurringExpenses: previous }), recurringExpenses: next };
		});
	}

	const load = useCallback(
		async (initial: boolean): Promise<void> => {
			if (initial && !hasAbosDataRef.current) setLoading(true);
			else setRefreshing(true);
			const res = await refreshAbos();
			if (res.ok) {
				setAbos(sortByNextDue(res.data.recurringExpenses));
				setLoadError(null);
			} else {
				setLoadError(getWgLoadErrorMessage('Abos', res.status, res.error, { verb: 'konnten' }));
			}
			setLoading(false);
			setRefreshing(false);
		},
		[refreshAbos],
	);

	useEffect(() => {
		if (cachedAbos) {
			hasAbosDataRef.current = true;
			setAbos(sortByNextDue(cachedAbos.recurringExpenses));
			setLoadError(null);
		} else if (abosReadError) {
			setLoadError(
				getWgLoadErrorMessage('Abos', abosReadError.status, abosReadError.error, {
					verb: 'konnten',
				}),
			);
			setLoading(false);
		}
	}, [abosReadError, cachedAbos]);

	useEffect(() => {
		void load(true);
	}, [load]);
	// Auto-Refresh wie auf dem Dashboard — ersetzt den manuellen Reload-Button.
	useVisibilityPausedInterval(() => void load(false), 30_000);

	function setNoticeMessage(tone: ActionNoticeTone, message: string): void {
		setNotice({ tone, message });
	}

	async function handleCreate(values: AboFormValues): Promise<void> {
		setSubmitting(true);
		const fingerprint = JSON.stringify(values);
		const pendingRequest = createRequestRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setNoticeMessage(
				'error',
				'Fixkosten konnten nicht sicher gespeichert werden. Versuche es erneut.',
			);
			setSubmitting(false);
			return;
		}
		createRequestRef.current = { fingerprint, key: idempotencyKey };
		const optimisticId = `pending:${idempotencyKey}`;
		const optimisticAbo: Abo = {
			id: optimisticId,
			description: values.description,
			amountCents: values.amountCents,
			currency: 'EUR',
			paidByMemberId: values.paidByMemberId,
			intervalMonths: values.intervalMonths,
			nextDueAt: values.nextDueAt,
			lastCreatedAt: null,
			pausedAt: null,
			splits: values.splits,
		};
		updateAbos((current) => upsertAbo(current, optimisticAbo));
		const res = await apiFetch<RecurringExpenseResponse>(
			`/api/wg/${encodedShareCode}/recurring-expenses`,
			{
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(values),
			},
		);
		if (res.ok) {
			createRequestRef.current = null;
			haptic('medium');
			updateAbos((current) =>
				upsertAbo(
					current.filter((abo) => abo.id !== optimisticId),
					res.data.recurringExpense,
				),
			);
			setShowCreate(false);
			setNoticeMessage('success', 'Fixkosten angelegt.');
		} else {
			updateAbos((current) => current.filter((abo) => abo.id !== optimisticId));
			if (res.status > 0 && res.status < 500 && res.status !== 429) createRequestRef.current = null;
			const message = aboSaveErrorMessage(res.error, 'angelegt');
			setNoticeMessage('error', message);
			toast.error(message);
		}
		setSubmitting(false);
	}

	async function handleEdit(values: AboFormValues): Promise<void> {
		if (!editing) return;
		setSubmitting(true);
		const previousAbo = editing;
		updateAbos((current) =>
			upsertAbo(current, {
				...previousAbo,
				...values,
			}),
		);
		const res = await apiFetch<RecurringExpenseResponse>(
			`/api/wg/${encodedShareCode}/recurring-expenses/${encodeURIComponent(editing.id)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify(values),
			},
		);
		if (res.ok) {
			haptic('medium');
			updateAbos((current) => upsertAbo(current, res.data.recurringExpense));
			setEditing(null);
			setNoticeMessage('success', 'Fixkosten aktualisiert.');
		} else {
			updateAbos((current) => upsertAbo(current, previousAbo));
			const message = aboSaveErrorMessage(res.error, 'aktualisiert');
			setNoticeMessage('error', message);
			toast.error(message);
		}
		setSubmitting(false);
	}

	async function handleTogglePause(abo: Abo): Promise<void> {
		setPendingId(abo.id);
		const isPaused = abo.pausedAt !== null;
		updateAbos((current) =>
			upsertAbo(current, { ...abo, pausedAt: isPaused ? null : new Date().toISOString() }),
		);
		const res = await apiFetch<RecurringExpenseResponse>(
			`/api/wg/${encodedShareCode}/recurring-expenses/${encodeURIComponent(abo.id)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify({ paused: !isPaused }),
			},
		);
		if (res.ok) {
			updateAbos((current) => upsertAbo(current, res.data.recurringExpense));
			setNoticeMessage('success', isPaused ? 'Fixkosten fortgesetzt.' : 'Fixkosten pausiert.');
		} else {
			updateAbos((current) => upsertAbo(current, abo));
			const message = aboActionErrorMessage(res.error);
			setNoticeMessage('error', message);
			toast.error(message);
		}
		setPendingId(null);
	}

	async function handleDelete(abo: Abo): Promise<void> {
		setPendingId(abo.id);
		const previousAbo = abos.find((item) => item.id === abo.id) ?? abo;
		updateAbos((current) => current.filter((item) => item.id !== abo.id));
		const res = await apiFetch<{ deleted: true }>(
			`/api/wg/${encodedShareCode}/recurring-expenses/${encodeURIComponent(abo.id)}`,
			{ method: 'DELETE', memberId: identity.memberId, memberToken: identity.memberToken },
		);
		if (res.ok) {
			setNoticeMessage('success', 'Fixkosten gelöscht.');
		} else {
			updateAbos((current) => upsertAbo(current, previousAbo));
			const message = aboDeleteErrorMessage(res.error);
			setNoticeMessage('error', message);
			toast.error(message);
		}
		setPendingId(null);
	}

	const activeCount = abos.filter((abo) => abo.pausedAt === null).length;
	const dueCount = getDueRecurringExpenses(abos.filter((abo) => abo.pausedAt === null)).length;
	// Monatliche Last aktiver Fixkosten: jährliche Abos zählen mit 1/12.
	const monthly = new Map<string, { totalCents: number; mineCents: number }>();
	for (const abo of abos) {
		if (abo.pausedAt !== null) continue;
		const months = Math.max(1, abo.intervalMonths);
		const entry = monthly.get(abo.currency) ?? { totalCents: 0, mineCents: 0 };
		entry.totalCents += abo.amountCents / months;
		entry.mineCents +=
			(abo.splits.find((split) => split.debtorMemberId === identity.memberId)?.amountCents ?? 0) /
			months;
		monthly.set(abo.currency, entry);
	}

	return (
		<div data-finance-content className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
			<SubNav liveCount={!loading && !loadError ? dueCount : undefined} />
			{/* Der aktive Tab benennt die Seite schon; Titel und Zähler bleiben für Screenreader. */}
			<header className="sr-only">
				<div className="min-w-0 flex-1">
					<h1 className="font-heading text-[26px] leading-8 font-semibold tracking-tight break-words [overflow-wrap:anywhere]">
						Fixkosten
					</h1>
					<p className="text-sm text-muted-foreground" aria-live="polite">
						{loading ? '' : `${activeCount} aktiv · ${abos.length} insgesamt`}
					</p>
					<output
						aria-live="polite"
						aria-hidden={!refreshing}
						className={cn(
							'flex min-h-5 items-center gap-2 text-sm text-muted-foreground',
							!refreshing && 'invisible',
						)}
					>
						<Spinner />
						Wird aktualisiert…
					</output>
				</div>
			</header>
			{loadError && (
				<LoadErrorBanner
					message={loadError}
					onRetry={() => void load(true)}
					busy={loading || refreshing}
					retryLabel="Fixkosten erneut laden"
				/>
			)}
			{notice && <ActionNoticeBanner notice={notice} />}
			{!loading && monthly.size > 0 && (
				<Card size="sm">
					<CardContent className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,7.5rem),1fr))] gap-3">
						<div className="min-w-0">
							<p className="text-sm text-muted-foreground">Pro Monat</p>
							{[...monthly].map(([currency, { totalCents }]) => (
								<p
									key={currency}
									className="break-words font-mono text-lg font-semibold tabular-nums"
								>
									{formatEuroCents(Math.round(totalCents), currency)}
								</p>
							))}
						</div>
						<div className="min-w-0">
							<p className="text-sm text-muted-foreground">Dein Anteil</p>
							{[...monthly].map(([currency, { mineCents }]) => (
								<p
									key={currency}
									className="break-words font-mono text-lg font-semibold tabular-nums"
								>
									{formatEuroCents(Math.round(mineCents), currency)}
								</p>
							))}
						</div>
					</CardContent>
				</Card>
			)}
			{loading ? (
				<AbosSkeleton />
			) : (
				<AbosList
					abos={abos}
					members={memberOptions}
					filter={filter}
					pendingId={pendingId}
					loadError={loadError}
					onFilterChange={setFilter}
					onEdit={(abo) => {
						setNotice(null);
						setEditing(abo);
					}}
					onTogglePause={(abo) => void handleTogglePause(abo)}
					onDelete={setDeleteCandidate}
				/>
			)}
			{showCreate && (
				<AboCreateModal
					members={memberOptions}
					defaultPaidByMemberId={identity.memberId}
					submitting={submitting}
					saveError={notice?.tone === 'error' ? notice.message : null}
					onClose={() => setShowCreate(false)}
					onSubmit={(values) => void handleCreate(values)}
				/>
			)}
			{editing && (
				<AboEditModal
					abo={editing}
					members={memberOptions}
					submitting={submitting}
					saveError={notice?.tone === 'error' ? notice.message : null}
					onClose={() => setEditing(null)}
					onSubmit={(values) => void handleEdit(values)}
				/>
			)}
			<AlertDialog
				open={deleteCandidate !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteCandidate(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Fixkosten löschen?</AlertDialogTitle>
						<AlertDialogDescription>
							Abo „{deleteCandidate?.description}“ wird entfernt. Bereits erfasste Ausgaben bleiben
							erhalten.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel className="min-h-11">Abbrechen</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							className="min-h-11"
							disabled={pendingId !== null}
							onClick={() => {
								if (deleteCandidate) void handleDelete(deleteCandidate);
								setDeleteCandidate(null);
							}}
						>
							Löschen
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<ThumbAction>
				<Button
					type="button"
					className="min-h-11 w-full"
					onClick={() => {
						setNotice(null);
						setShowCreate(true);
					}}
				>
					<Plus data-icon="inline-start" aria-hidden />
					Neue Fixkosten
				</Button>
			</ThumbAction>
		</div>
	);
}

function AbosSkeleton() {
	return (
		<ItemGroup aria-busy="true" aria-label="Fixkosten werden geladen">
			{['s1', 's2', 's3', 's4'].map((key) => (
				<Item key={key} variant="outline" aria-hidden="true">
					<ItemContent>
						<Skeleton className="h-4 w-2/3" />
						<Skeleton className="h-3 w-1/3" />
					</ItemContent>
					<Skeleton className="h-4 w-16" />
				</Item>
			))}
		</ItemGroup>
	);
}
