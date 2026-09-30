'use client';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { BackLink } from '@/components/wg/BackLink';
import { DebtRow } from '@/components/wg/DebtRow';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { RemindButton } from '@/components/wg/RemindButton';
import { ReminderHistory, type ReminderHistoryItem } from '@/components/wg/ReminderHistory';
import { ThumbAction } from '@/components/wg/ThumbAction';
import { useWg } from '@/components/wg/WgContextProvider';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { formatRelativeTime } from '@/core/utils/time';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import {
	type DebtExpenseInput,
	computeBalances,
	computeOldestDebtAges,
} from '@/features/expenses/debts';
import type { ExpensePaymentInput } from '@/features/expenses/expense-payments';
import { REMINDER_COOLDOWN_HOURS, canSendReminder } from '@/features/expenses/reminders';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface ExpenseSplitDto {
	id: string;
	debtorMemberId: string;
	amountCents: number;
	settledAt: string | null;
}

interface ExpenseDto {
	id: string;
	paidByMemberId: string;
	currency: string;
	occurredAt: string;
	splits: ExpenseSplitDto[];
}

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function ErinnerungenPage() {
	const { wg, members, identity } = useWg();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const {
		data: cachedExpenses,
		error: expensesReadError,
		refresh: refreshExpenses,
	} = useCachedFetch<{ expenses: ExpenseDto[]; payments?: ExpensePaymentInput[] }>(
		`/api/wg/${encodedShareCode}/expenses`,
		{ memberId: identity.memberId },
	);
	const {
		data: cachedReminders,
		error: remindersReadError,
		refresh: refreshReminders,
		setData: setCachedReminders,
	} = useCachedFetch<{ reminders: ReminderHistoryItem[] }>(
		`/api/wg/${encodedShareCode}/reminders`,
		{ memberId: identity.memberId },
	);
	const wgBaseHref = `/wg/${encodedShareCode}`;

	const [expenses, setExpenses] = useState<ExpenseDto[]>(() => cachedExpenses?.expenses ?? []);
	const [payments, setPayments] = useState<ExpensePaymentInput[]>(
		() => cachedExpenses?.payments ?? [],
	);
	const [reminders, setReminders] = useState<ReminderHistoryItem[]>(
		() => cachedReminders?.reminders ?? [],
	);
	const [loading, setLoading] = useState(!cachedExpenses && !cachedReminders);
	const [refreshing, setRefreshing] = useState(false);
	const [loadErrors, setLoadErrors] = useState<{
		expenses: string | null;
		reminders: string | null;
	}>({ expenses: null, reminders: null });
	const [expensesLoadFailed, setExpensesLoadFailed] = useState(false);
	const [remindersLoadFailed, setRemindersLoadFailed] = useState(false);
	const [primaryReminderKey, setPrimaryReminderKey] = useState<string | null>(null);
	const hasPageCacheRef = useRef(Boolean(cachedExpenses || cachedReminders));

	function updateReminders(
		update: (current: ReminderHistoryItem[]) => ReminderHistoryItem[],
	): void {
		setReminders(update);
		setCachedReminders((current) => {
			const previous = current?.reminders ?? reminders;
			const next = update(previous);
			if (!current && next === previous) return current;
			return { ...(current ?? { reminders: previous }), reminders: next };
		});
	}

	const load = useCallback(
		async (initial: boolean): Promise<void> => {
			if (initial && !hasPageCacheRef.current) setLoading(true);
			else setRefreshing(true);

			const [expensesRes, remindersRes] = await Promise.all([
				refreshExpenses(),
				refreshReminders(),
			]);

			const nextErrors: { expenses: string | null; reminders: string | null } = {
				expenses: null,
				reminders: null,
			};
			if (expensesRes.ok) {
				setExpenses(expensesRes.data.expenses);
				setPayments(expensesRes.data.payments ?? []);
				setExpensesLoadFailed(false);
			} else {
				setExpensesLoadFailed(true);
				nextErrors.expenses = getWgLoadErrorMessage(
					'Ausgaben',
					expensesRes.status,
					expensesRes.error,
					{
						verb: 'konnten',
					},
				);
			}
			if (remindersRes.ok) {
				setReminders(remindersRes.data.reminders);
				setRemindersLoadFailed(false);
			} else {
				setRemindersLoadFailed(true);
				nextErrors.reminders = getWgLoadErrorMessage(
					'Erinnerungen',
					remindersRes.status,
					remindersRes.error,
					{
						verb: 'konnten',
					},
				);
			}
			setLoadErrors(nextErrors);
			setLoading(false);
			setRefreshing(false);
		},
		[refreshExpenses, refreshReminders],
	);
	useEffect(() => {
		if (cachedExpenses) {
			hasPageCacheRef.current = true;
			setExpenses(cachedExpenses.expenses);
			setPayments(cachedExpenses.payments ?? []);
			setExpensesLoadFailed(false);
			setLoadErrors((current) => ({ ...current, expenses: null }));
		}
		if (cachedReminders) {
			hasPageCacheRef.current = true;
			setReminders(cachedReminders.reminders);
			setRemindersLoadFailed(false);
			setLoadErrors((current) => ({ ...current, reminders: null }));
		}
		if (cachedExpenses || cachedReminders) setLoading(false);
		if (expensesReadError) {
			setExpensesLoadFailed(true);
			setLoadErrors((current) => ({
				...current,
				expenses: getWgLoadErrorMessage(
					'Ausgaben',
					expensesReadError.status,
					expensesReadError.error,
					{ verb: 'konnten' },
				),
			}));
		}
		if (remindersReadError) {
			setRemindersLoadFailed(true);
			setLoadErrors((current) => ({
				...current,
				reminders: getWgLoadErrorMessage(
					'Erinnerungen',
					remindersReadError.status,
					remindersReadError.error,
					{ verb: 'konnten' },
				),
			}));
		}
	}, [cachedExpenses, cachedReminders, expensesReadError, remindersReadError]);

	useEffect(() => {
		void load(true);
	}, [load]);
	// Auto-Refresh wie auf dem Dashboard — ersetzt den manuellen Reload-Button.
	useVisibilityPausedInterval(() => void load(false), 30_000);

	const memberName = useCallback(
		(id: string) => members.find((m) => m.id === id)?.name ?? '?',
		[members],
	);
	const memberColor = useCallback(
		(id: string) => members.find((m) => m.id === id)?.color ?? null,
		[members],
	);

	const debtExpenses = useMemo<DebtExpenseInput[]>(
		() =>
			expenses.map((expense) => ({
				paidByMemberId: expense.paidByMemberId,
				currency: expense.currency,
				occurredAt: expense.occurredAt,
				splits: expense.splits.map((split) => ({
					debtorMemberId: split.debtorMemberId,
					amountCents: split.amountCents,
					settledAt: split.settledAt,
				})),
			})),
		[expenses],
	);

	const balances = useMemo(() => computeBalances(debtExpenses, payments), [debtExpenses, payments]);

	const rows = useMemo(() => {
		const oldestAges = computeOldestDebtAges(balances, debtExpenses);
		return balances
			.map((pair, i) => ({ ...pair, oldestAge: oldestAges[i] ?? 0 }))
			.sort((a, b) => b.amountCents - a.amountCents);
	}, [balances, debtExpenses]);

	function cooldownFor(debtorId: string, creditorId: string, currency: string) {
		return canSendReminder(
			debtorId,
			creditorId,
			reminders.map((r) => ({
				debtorMemberId: r.debtorMemberId,
				creditorMemberId: r.creditorMemberId,
				currency: r.currency,
				sentAt: r.sentAt,
			})),
			undefined,
			currency,
		);
	}

	const reminderKey = (row: (typeof rows)[number]) =>
		`${row.currency}:${row.debtorId}:${row.creditorId}`;
	const primaryReminder =
		rows.find((row) => reminderKey(row) === primaryReminderKey) ??
		rows.find((row) => cooldownFor(row.debtorId, row.creditorId, row.currency).allowed) ??
		rows[0] ??
		null;

	function reminderButton(row: (typeof rows)[number], primary = false) {
		const cooldown = cooldownFor(row.debtorId, row.creditorId, row.currency);
		const cooldownLabel = cooldown.nextAllowedAt
			? `Wieder möglich ${formatRelativeTime(cooldown.nextAllowedAt.toISOString())}`
			: null;
		return (
			<RemindButton
				key={reminderKey(row)}
				shareCode={wg.shareCode}
				debtorMemberId={row.debtorId}
				creditorMemberId={row.creditorId}
				currency={row.currency}
				currentMemberId={identity.memberId}
				memberToken={identity.memberToken}
				cooldownActive={!cooldown.allowed}
				cooldownLabel={cooldownLabel}
				onSent={(reminderId) => {
					if (primary) {
						setPrimaryReminderKey(null);
						const pendingPrefix = `pending:${reminderKey(row)}:`;
						updateReminders((current) => {
							const optimistic = current.find((item) => item.id.startsWith(pendingPrefix));
							const withoutPending = current.filter((item) => !item.id.startsWith(pendingPrefix));
							if (withoutPending.some((item) => item.id === reminderId)) return withoutPending;
							return optimistic
								? [{ ...optimistic, id: reminderId, channel: 'push' }, ...withoutPending]
								: withoutPending;
						});
					}
					void load(false);
				}}
				onOptimistic={
					primary
						? () => {
								const key = reminderKey(row);
								const optimisticId = `pending:${key}:${Date.now()}`;
								const optimistic: ReminderHistoryItem = {
									id: optimisticId,
									debtorMemberId: row.debtorId,
									creditorMemberId: row.creditorId,
									amountCents: row.amountCents,
									currency: row.currency,
									channel: 'Wird gesendet',
									sentAt: new Date().toISOString(),
									oldestDebtAgeDays: row.oldestAge,
								};
								setPrimaryReminderKey(key);
								updateReminders((current) => [optimistic, ...current]);
								return () => {
									setPrimaryReminderKey(null);
									updateReminders((current) => current.filter((item) => item.id !== optimisticId));
								};
							}
						: undefined
				}
				primary={primary}
			/>
		);
	}

	return (
		<div data-finance-content className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
			<header className="flex min-w-0 items-center gap-3">
				<BackLink href={`${wgBaseHref}/ausgaben`} label="Ausgaben" />
				<div className="min-w-0 flex-1">
					<h1 className="font-heading text-lg font-semibold tracking-tight break-words">
						Erinnerungen
					</h1>
					<p className="mt-0.5 text-[12px] text-muted-foreground">
						Max. alle {REMINDER_COOLDOWN_HOURS} Stunden pro Person
					</p>
					<output aria-live="polite" aria-hidden={!refreshing} className="sr-only">
						<Spinner />
						Wird aktualisiert…
					</output>
				</div>
			</header>
			<section className="flex flex-col gap-3">
				<h2 className="text-base font-semibold">Offene Schulden</h2>
				{loadErrors.expenses && (
					<LoadErrorBanner
						message={loadErrors.expenses}
						onRetry={() => void load(true)}
						busy={loading || refreshing}
						retryLabel="Erneut laden"
					/>
				)}
				{loading ? (
					<div
						className="flex flex-col gap-3"
						aria-busy="true"
						aria-label="Offene Schulden werden geladen"
						// biome-ignore lint/a11y/useSemanticElements: role="status" names the loading region without swapping the wrapper element to <output>.
						role="status"
					>
						<Skeleton className="h-24 w-full" />
						<Skeleton className="h-24 w-full" />
					</div>
				) : expensesLoadFailed && rows.length === 0 ? null : rows.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>Alles ausgeglichen. Nichts offen.</EmptyTitle>
						</EmptyHeader>
					</Empty>
				) : (
					<ul className="flex flex-col gap-3">
						{rows.map((row) => {
							return (
								<DebtRow
									key={`${row.currency}:${row.debtorId}:${row.creditorId}`}
									debtor={{
										id: row.debtorId,
										name: memberName(row.debtorId),
										color: memberColor(row.debtorId),
									}}
									creditor={{
										id: row.creditorId,
										name: memberName(row.creditorId),
										color: memberColor(row.creditorId),
									}}
									amountCents={row.amountCents}
									currency={row.currency}
									oldestDebtAgeDays={row.oldestAge}
									currentMemberId={identity.memberId}
									action={row === primaryReminder ? null : reminderButton(row)}
								/>
							);
						})}
					</ul>
				)}
			</section>
			<section className="flex flex-col gap-3">
				<h2 className="text-base font-semibold">Letzte Erinnerungen (30 Tage)</h2>
				{loadErrors.reminders && (
					<LoadErrorBanner
						message={loadErrors.reminders}
						onRetry={() => void load(true)}
						busy={loading || refreshing}
						retryLabel="Erneut laden"
					/>
				)}
				{loading ? (
					<Skeleton className="h-20 w-full" />
				) : remindersLoadFailed && reminders.length === 0 ? null : (
					<ReminderHistory
						items={reminders}
						memberName={memberName}
						currentMemberId={identity.memberId}
					/>
				)}
			</section>
			{primaryReminder && <ThumbAction>{reminderButton(primaryReminder, true)}</ThumbAction>}
		</div>
	);
}
