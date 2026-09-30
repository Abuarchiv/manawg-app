import {
	announcementReactions,
	announcements,
	auditEvents,
	chores,
	db,
	expensePayments,
	expenseSplits,
	expenses,
	memberAbsences,
	recurringExpenses,
	shoppingItems,
	wgMembers,
} from '@/core/db';
import { captureException } from '@/core/infra/observability';
import {
	berlinDayKey,
	nextBerlinDayStart,
	prevBerlinDayStart,
	startOfBerlinDay,
} from '@/core/utils/berlin-day';
import { getAbsentMemberIds } from '@/features/chores/absence';
import { computeNetBalances } from '@/features/expenses/debt-reduction';
import type { ExpensePaymentInput } from '@/features/expenses/expense-payments';
import { getDueRecurringExpenses } from '@/features/expenses/recurring-expenses';
import { and, desc, eq } from 'drizzle-orm';
import { type ActivityKind, formatAuditActivityText } from './activity';
import { type WgHealth, getWgHealth } from './dashboard-insights';
import {
	getDashboardActivityHref,
	getDashboardAuditHref,
	getDashboardAuditKind,
} from './dashboard-links';

const SPARKLINE_DAYS = 14;
const ACTIVITY_LIMIT = 6;
const AUDIT_DEDUPE_WINDOW_MS = 60_000;

function normalizeCurrency(currency: string | undefined): string {
	return currency?.trim().toUpperCase() || 'EUR';
}

function addCurrencyTotal(totals: CurrencyTotals, currency: string, cents: number): void {
	totals[currency] = (totals[currency] ?? 0) + cents;
}

function singleCurrencyTotal(totals: Readonly<CurrencyTotals>): number | null {
	const currencies = Object.keys(totals).filter((currency) => totals[currency] !== 0);
	return currencies.length <= 1 ? (currencies[0] ? (totals[currencies[0]] ?? 0) : 0) : null;
}

export interface MemberBalance {
	memberId: string;
	memberName: string;
	color: string | null;
	currency: string;
	paidCents: number;
	owedCents: number;
	balanceCents: number;
}

export interface DaySpend {
	date: string;
	currency: string;
	cents: number;
}

export type CurrencyTotals = Record<string, number>;

export interface DashboardSpendSummary {
	spendByDay: DaySpend[];
	totalSpendByCurrency: CurrencyTotals;
	weekSpendByCurrency: CurrencyTotals;
	monthSpendByCurrency: CurrencyTotals;
	totalSpendCents: number | null;
	weekSpendCents: number | null;
	monthSpendCents: number | null;
}

export interface ActivityItem {
	kind: 'expense' | 'shopping' | 'announcement' | 'chore' | 'recurring' | 'absence' | 'audit';
	timestamp: string;
	/** Damit die Oberfläche eigene Einträge als „Du …“ zeigen kann. */
	memberId?: string | null;
	memberName: string;
	text: string;
	amountCents?: number;
	currency?: string;
	href?: string;
}

export interface ChoreDue {
	id: string;
	title: string;
	assignedMemberId: string | null;
	assignedMemberName: string | null;
	assignedColor: string | null;
	nextDueAt: string;
	overdue: boolean;
}

export interface DashboardSetup {
	choreCount: number;
	hasExpense: boolean;
	hasShoppingItem: boolean;
	hasAnnouncement: boolean;
	notificationsEnabled: boolean;
}

export interface DashboardData {
	balances: MemberBalance[];
	spendByDay: DaySpend[];
	totalSpendByCurrency: CurrencyTotals;
	weekSpendByCurrency: CurrencyTotals;
	monthSpendByCurrency: CurrencyTotals;
	/** Legacy scalar fields are null when more than one currency is present. */
	totalSpendCents: number | null;
	weekSpendCents: number | null;
	monthSpendCents: number | null;
	openShoppingCount: number;
	openShoppingTop: string[];
	dueChores: ChoreDue[];
	activity: ActivityItem[];
	latestAnnouncement: {
		id?: string;
		content: string;
		authorName: string;
		createdAt: string;
	} | null;
	myOpenAnnouncements: Array<{ id: string; kind: string; content: string; createdAt: string }>;
	wgHealth: WgHealth;
	dueRecurringExpenses: Array<{
		id: string;
		description: string;
		amountCents: number;
		currency: string;
		nextDueAt: string;
	}>;
	absentMembers: Array<{
		id: string;
		memberId: string;
		name: string;
		endDate: string;
		isCurrentMember: boolean;
	}>;
	setup: DashboardSetup;
}

export function getLatestManualAnnouncement(
	announcementRows: Array<{
		id?: string;
		content: string;
		authorMemberId: string;
		source: string | null;
		createdAt: Date;
	}>,
	memberById: Map<string, { name: string }>,
): DashboardData['latestAnnouncement'] {
	const latestManual = announcementRows.find((item) => item.source === 'manual');
	return latestManual
		? {
				...(latestManual.id ? { id: latestManual.id } : {}),
				content: latestManual.content,
				authorName: memberById.get(latestManual.authorMemberId)?.name ?? '—',
				createdAt: latestManual.createdAt.toISOString(),
			}
		: null;
}

export function countOpenManualAnnouncements(
	announcementRows: Array<{ source: string | null; status: string }>,
): number {
	return announcementRows.filter((item) => item.source === 'manual' && item.status === 'open')
		.length;
}

export function getCurrentAbsenceRowsByMember<
	TRow extends { memberId: string; startDate: Date; endDate: Date },
>(absenceRows: TRow[], nowMs: number): Map<string, TRow> {
	const currentRows = absenceRows
		.filter((item) => item.startDate.getTime() <= nowMs && item.endDate.getTime() >= nowMs)
		.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
	const currentByMember = new Map<string, TRow>();
	for (const item of currentRows) {
		if (!currentByMember.has(item.memberId)) currentByMember.set(item.memberId, item);
	}
	return currentByMember;
}

function berlinDaysAgoStart(todayStart: Date, daysAgo: number): Date {
	let day = todayStart;
	for (let i = 0; i < daysAgo; i++) day = prevBerlinDayStart(day);
	return day;
}

export function summarizeDashboardSpend(
	expenses: ReadonlyArray<{
		amountCents: number;
		currency?: string;
		occurredAt: Date | string;
	}>,
	now = new Date(),
): DashboardSpendSummary {
	const todayStart = startOfBerlinDay(now);
	const sparklineStart = berlinDaysAgoStart(todayStart, SPARKLINE_DAYS - 1);
	const weekStart = berlinDaysAgoStart(todayStart, 6);
	const monthStart = berlinDaysAgoStart(todayStart, 29);
	const spendBuckets = new Map<string, CurrencyTotals>();
	let bucketDay = sparklineStart;
	for (let i = 0; i < SPARKLINE_DAYS; i++) {
		spendBuckets.set(berlinDayKey(bucketDay), {});
		bucketDay = nextBerlinDayStart(bucketDay);
	}
	const totalSpendByCurrency: CurrencyTotals = {};
	const weekSpendByCurrency: CurrencyTotals = {};
	const monthSpendByCurrency: CurrencyTotals = {};
	for (const expense of expenses) {
		const currency = normalizeCurrency(expense.currency);
		addCurrencyTotal(totalSpendByCurrency, currency, expense.amountCents);
		const occurredAt =
			expense.occurredAt instanceof Date ? expense.occurredAt : new Date(expense.occurredAt);
		if (occurredAt >= weekStart)
			addCurrencyTotal(weekSpendByCurrency, currency, expense.amountCents);
		if (occurredAt >= monthStart)
			addCurrencyTotal(monthSpendByCurrency, currency, expense.amountCents);
		const bucket = spendBuckets.get(berlinDayKey(occurredAt));
		if (bucket) addCurrencyTotal(bucket, currency, expense.amountCents);
	}
	const spendByDay: DaySpend[] = Array.from(spendBuckets.entries()).flatMap(([date, totals]) => {
		const entries = Object.entries(totals).sort(([left], [right]) => left.localeCompare(right));
		return entries.length > 0
			? entries.map(([currency, cents]) => ({ date, currency, cents }))
			: [{ date, currency: 'EUR', cents: 0 }];
	});
	return {
		spendByDay,
		totalSpendByCurrency,
		weekSpendByCurrency,
		monthSpendByCurrency,
		totalSpendCents: singleCurrencyTotal(totalSpendByCurrency),
		weekSpendCents: singleCurrencyTotal(weekSpendByCurrency),
		monthSpendCents: singleCurrencyTotal(monthSpendByCurrency),
	};
}

export function computeMemberBalances(
	members: Array<{ id: string; name: string; color: string | null }>,
	expenses: Array<{
		id: string;
		paidByMemberId: string;
		amountCents: number;
		currency?: string;
	}>,
	splits: Array<{
		expenseId: string;
		debtorMemberId: string;
		amountCents: number;
		settledAt: Date | null;
	}>,
	payments: ExpensePaymentInput[] = [],
): MemberBalance[] {
	const splitsByExpense = new Map<
		string,
		Array<{ debtorMemberId: string; amountCents: number; settledAt: string | null }>
	>();
	for (const split of splits) {
		const expenseSplits = splitsByExpense.get(split.expenseId) ?? [];
		expenseSplits.push({
			debtorMemberId: split.debtorMemberId,
			amountCents: split.amountCents,
			settledAt: split.settledAt?.toISOString() ?? null,
		});
		splitsByExpense.set(split.expenseId, expenseSplits);
	}

	const normalizedExpenses = expenses.map((expense) => ({
		...expense,
		currency: normalizeCurrency(expense.currency),
	}));
	const netBalances = computeNetBalances(
		normalizedExpenses.map((expense) => ({
			paidByMemberId: expense.paidByMemberId,
			currency: expense.currency,
			splits: splitsByExpense.get(expense.id) ?? [],
		})),
		members,
		payments,
	);
	const grossByKey = new Map<string, { paidCents: number; owedCents: number }>();
	const currencies = new Set<string>(netBalances.map((balance) => balance.currency));
	for (const expense of normalizedExpenses) {
		currencies.add(expense.currency);
		const key = `${expense.currency}:${expense.paidByMemberId}`;
		const paid = grossByKey.get(key) ?? { paidCents: 0, owedCents: 0 };
		paid.paidCents += expense.amountCents;
		grossByKey.set(key, paid);
	}
	const currencyByExpenseId = new Map(
		normalizedExpenses.map((expense) => [expense.id, expense.currency]),
	);
	for (const split of splits) {
		if (split.settledAt) continue;
		const currency = currencyByExpenseId.get(split.expenseId) ?? 'EUR';
		const key = `${currency}:${split.debtorMemberId}`;
		const owed = grossByKey.get(key) ?? { paidCents: 0, owedCents: 0 };
		owed.owedCents += split.amountCents;
		grossByKey.set(key, owed);
	}
	for (const payment of payments) {
		const currency = payment.currency?.trim().toUpperCase() || 'EUR';
		currencies.add(currency);
		const paidKey = `${currency}:${payment.fromMemberId}`;
		const owedKey = `${currency}:${payment.toMemberId}`;
		const paid = grossByKey.get(paidKey) ?? { paidCents: 0, owedCents: 0 };
		const owed = grossByKey.get(owedKey) ?? { paidCents: 0, owedCents: 0 };
		paid.paidCents += payment.amountCents;
		owed.owedCents += payment.amountCents;
		grossByKey.set(paidKey, paid);
		grossByKey.set(owedKey, owed);
	}

	return [...currencies].sort().flatMap((currency) =>
		members.map((member) => {
			const net = netBalances.find(
				(balance) => balance.memberId === member.id && balance.currency === currency,
			);
			const gross = grossByKey.get(`${currency}:${member.id}`);
			return {
				memberId: member.id,
				memberName: member.name,
				color: member.color,
				currency,
				paidCents: gross?.paidCents ?? 0,
				owedCents: gross?.owedCents ?? 0,
				balanceCents: net?.cents ?? 0,
			};
		}),
	);
}

export function buildDueChores(
	choreRows: Array<{
		id: string;
		title: string;
		nextDueAt: Date;
		assignedMemberId: string | null;
	}>,
	memberById: Map<string, { name: string; color: string | null }>,
	now: Date,
): ChoreDue[] {
	return choreRows
		.map((c) => {
			const assigned = c.assignedMemberId ? (memberById.get(c.assignedMemberId) ?? null) : null;
			return {
				id: c.id,
				title: c.title,
				assignedMemberId: c.assignedMemberId,
				assignedMemberName: assigned?.name ?? null,
				assignedColor: assigned?.color ?? null,
				nextDueAt: c.nextDueAt.toISOString(),
				overdue: c.nextDueAt.getTime() <= now.getTime(),
			};
		})
		.sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

export function isDuplicateAuditActivity(
	rawByKey: Map<string, number>,
	kind: ActivityKind,
	entityId: string | null | undefined,
	timestampMs: number,
): boolean {
	if (!entityId) return false;
	const rawMs = rawByKey.get(`${kind}:${entityId}`);
	return rawMs !== undefined && Math.abs(timestampMs - rawMs) <= AUDIT_DEDUPE_WINDOW_MS;
}

// Reads that drive household counts must succeed; falling back to an empty
// list would report a false zero. Optional activity sections may still degrade.
// Financial reads must all succeed or balances would be fabricated.
function withFallback<T>(label: string, query: Promise<T>, fallback: () => T): Promise<T> {
	return query.catch((err: unknown) => {
		captureException(err, { action: 'loadDashboardData', query: label });
		return fallback();
	});
}

export async function loadDashboardData(
	wgId: string,
	currentMemberId?: string | null,
	shareCode = '',
): Promise<DashboardData> {
	const now = new Date();

	const [
		memberRows,
		expenseRows,
		splitRows,
		paymentRows,
		shoppingRows,
		choreRows,
		announcementRows,
	] = await Promise.all([
		db
			.select({ id: wgMembers.id, name: wgMembers.name, color: wgMembers.color })
			.from(wgMembers)
			.where(eq(wgMembers.wgId, wgId)),
		db
			.select({
				id: expenses.id,
				paidByMemberId: expenses.paidByMemberId,
				amountCents: expenses.amountCents,
				currency: expenses.currency,
				description: expenses.description,
				occurredAt: expenses.occurredAt,
			})
			.from(expenses)
			.where(eq(expenses.wgId, wgId))
			.orderBy(desc(expenses.occurredAt)),
		db
			.select({
				expenseId: expenseSplits.expenseId,
				debtorMemberId: expenseSplits.debtorMemberId,
				amountCents: expenseSplits.amountCents,
				settledAt: expenseSplits.settledAt,
			})
			.from(expenseSplits)
			.innerJoin(expenses, eq(expenseSplits.expenseId, expenses.id))
			.where(eq(expenses.wgId, wgId)),
		db
			.select({
				fromMemberId: expensePayments.fromMemberId,
				toMemberId: expensePayments.toMemberId,
				amountCents: expensePayments.amountCents,
				currency: expensePayments.currency,
			})
			.from(expensePayments)
			.where(and(eq(expensePayments.wgId, wgId), eq(expensePayments.status, 'completed'))),
		db
			.select({
				id: shoppingItems.id,
				name: shoppingItems.name,
				quantity: shoppingItems.quantity,
				addedByMemberId: shoppingItems.addedByMemberId,
				createdAt: shoppingItems.createdAt,
				boughtAt: shoppingItems.boughtAt,
			})
			.from(shoppingItems)
			.where(eq(shoppingItems.wgId, wgId))
			.orderBy(desc(shoppingItems.createdAt)),
		db
			.select({
				id: chores.id,
				title: chores.title,
				nextDueAt: chores.nextDueAt,
				assignedMemberId: chores.assignedMemberId,
			})
			.from(chores)
			.where(eq(chores.wgId, wgId)),
		withFallback(
			'announcements',
			db
				.select({
					id: announcements.id,
					content: announcements.content,
					authorMemberId: announcements.authorMemberId,
					source: announcements.source,
					status: announcements.status,
					createdAt: announcements.createdAt,
				})
				.from(announcements)
				.where(eq(announcements.wgId, wgId))
				.orderBy(desc(announcements.createdAt)),
			() => [],
		),
	]);

	const memberById = new Map(memberRows.map((m) => [m.id, m]));

	const balances = computeMemberBalances(memberRows, expenseRows, splitRows, paymentRows);

	const spendSummary = summarizeDashboardSpend(expenseRows, now);

	const openShopping = shoppingRows.filter((s) => !s.boughtAt);
	const openShoppingTop = openShopping
		.slice(0, 3)
		.map((s) => (s.quantity ? `${s.name} (${s.quantity})` : s.name));

	const allDueChores = buildDueChores(choreRows, memberById, now);
	const dueChores = allDueChores;

	const activity: ActivityItem[] = [];
	const rawActivityByKey = new Map<string, number>();
	for (const e of expenseRows.slice(0, ACTIVITY_LIMIT)) {
		activity.push({
			kind: 'expense',
			timestamp: e.occurredAt.toISOString(),
			memberId: e.paidByMemberId,
			memberName: memberById.get(e.paidByMemberId)?.name ?? '—',
			text: e.description,
			amountCents: e.amountCents,
			currency: e.currency,
			href: getDashboardActivityHref(shareCode, 'expense', e.id),
		});
		rawActivityByKey.set(`expense:${e.id}`, new Date(e.occurredAt).getTime());
	}
	for (const s of shoppingRows.slice(0, ACTIVITY_LIMIT)) {
		activity.push({
			kind: 'shopping',
			timestamp: (s.boughtAt ?? s.createdAt).toISOString(),
			memberId: s.addedByMemberId,
			memberName: memberById.get(s.addedByMemberId)?.name ?? '—',
			// Matches activity.ts's buildActivityTimeline wording for the same
			// event — these two feed builders are independently maintained
			// (dashboard-data.ts assembles a bounded per-category preview,
			// activity.ts the full chronicle), so their text must stay in sync
			// by hand until they're consolidated.
			text: s.boughtAt ? `${s.name} gekauft` : s.name,
			href: getDashboardActivityHref(shareCode, 'shopping', s.id),
		});
		rawActivityByKey.set(`shopping:${s.id}`, (s.boughtAt ?? s.createdAt).getTime());
	}
	for (const a of announcementRows
		.filter((item) => item.source === 'manual')
		.slice(0, ACTIVITY_LIMIT)) {
		activity.push({
			kind: 'announcement',
			timestamp: a.createdAt.toISOString(),
			memberId: a.authorMemberId,
			memberName: memberById.get(a.authorMemberId)?.name ?? '—',
			text: a.content.length > 80 ? `${a.content.slice(0, 80)}…` : a.content,
			href: getDashboardActivityHref(shareCode, 'announcement', a.id),
		});
		rawActivityByKey.set(`announcement:${a.id}`, a.createdAt.getTime());
	}
	activity.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

	const latestAnnouncement = getLatestManualAnnouncement(announcementRows, memberById);
	const [myOpenAnnouncements, absenceRows, recurringRows, auditRows, currentMemberNotification] =
		await Promise.all([
			withFallback(
				'myOpenAnnouncements',
				currentMemberId
					? db
							.select({
								id: announcements.id,
								kind: announcements.kind,
								content: announcements.content,
								createdAt: announcements.createdAt,
							})
							.from(announcements)
							.innerJoin(
								announcementReactions,
								eq(announcementReactions.announcementId, announcements.id),
							)
							.where(
								and(
									eq(announcements.wgId, wgId),
									eq(announcements.status, 'open'),
									eq(announcementReactions.memberId, currentMemberId),
									eq(announcementReactions.reaction, 'take'),
								),
							)
							.orderBy(desc(announcements.createdAt))
					: Promise.resolve([]),
				() => [],
			),
			withFallback(
				'memberAbsences',
				db
					.select({
						id: memberAbsences.id,
						memberId: memberAbsences.memberId,
						startDate: memberAbsences.startDate,
						endDate: memberAbsences.endDate,
					})
					.from(memberAbsences)
					.where(eq(memberAbsences.wgId, wgId)),
				() => [],
			),
			db
				.select({
					id: recurringExpenses.id,
					description: recurringExpenses.description,
					amountCents: recurringExpenses.amountCents,
					nextDueAt: recurringExpenses.nextDueAt,
					lastCreatedAt: recurringExpenses.lastCreatedAt,
					createdAt: recurringExpenses.createdAt,
					pausedAt: recurringExpenses.pausedAt,
				})
				.from(recurringExpenses)
				.where(eq(recurringExpenses.wgId, wgId)),
			withFallback(
				'auditEvents',
				db
					.select({
						id: auditEvents.id,
						memberId: auditEvents.memberId,
						eventType: auditEvents.eventType,
						entityType: auditEvents.entityType,
						entityId: auditEvents.entityId,
						metadataJson: auditEvents.metadataJson,
						summary: auditEvents.summary,
						createdAt: auditEvents.createdAt,
					})
					.from(auditEvents)
					.where(eq(auditEvents.wgId, wgId))
					.orderBy(desc(auditEvents.createdAt))
					.limit(ACTIVITY_LIMIT),
				() => [],
			),
			withFallback(
				'currentMemberPushOptIn',
				currentMemberId
					? db.query.wgMembers.findFirst({
							where: and(eq(wgMembers.id, currentMemberId), eq(wgMembers.wgId, wgId)),
							columns: { pushOptIn: true },
						})
					: Promise.resolve(null),
				() => null,
			),
		]);
	const filteredMyOpenAnnouncements = myOpenAnnouncements;
	const dueRecurringExpenses = getDueRecurringExpenses(
		recurringRows
			.filter((item) => item.pausedAt === null)
			.map((item) => ({
				id: item.id,
				description: item.description,
				amountCents: item.amountCents,
				currency: 'EUR',
				nextDueAt: item.nextDueAt.toISOString(),
			})),
		now.getTime(),
	);
	for (const absence of absenceRows.slice(0, ACTIVITY_LIMIT)) {
		activity.push({
			kind: 'absence',
			timestamp: absence.startDate.toISOString(),
			memberId: absence.memberId,
			memberName: memberById.get(absence.memberId)?.name ?? '—',
			text: 'Abwesenheit eingetragen',
			href: getDashboardActivityHref(shareCode, 'absence', absence.id),
		});
		rawActivityByKey.set(`absence:${absence.id}`, absence.startDate.getTime());
	}
	for (const recurring of recurringRows.slice(0, ACTIVITY_LIMIT)) {
		const recurringTs = (recurring.lastCreatedAt ?? recurring.createdAt).getTime();
		activity.push({
			kind: 'recurring',
			timestamp: new Date(recurringTs).toISOString(),
			memberName: 'System',
			text: recurring.lastCreatedAt
				? `${recurring.description} aus Vorlage erstellt`
				: `${recurring.description} als Vorlage angelegt`,
			amountCents: recurring.amountCents,
			currency: 'EUR',
			href: getDashboardActivityHref(shareCode, 'recurring', recurring.id),
		});
		rawActivityByKey.set(`recurring:${recurring.id}`, recurringTs);
	}
	for (const audit of auditRows) {
		const kind = getDashboardAuditKind(audit);
		if (isDuplicateAuditActivity(rawActivityByKey, kind, audit.entityId, audit.createdAt.getTime()))
			continue;
		const actorName = audit.memberId ? (memberById.get(audit.memberId)?.name ?? '—') : 'System';
		const href = getDashboardAuditHref(shareCode, audit);
		activity.push({
			kind,
			timestamp: audit.createdAt.toISOString(),
			memberId: audit.memberId ?? null,
			memberName: actorName,
			text: formatAuditActivityText(audit.summary, actorName),
			...(href ? { href } : {}),
		});
	}
	activity.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	const absentMemberIds = getAbsentMemberIds(
		absenceRows.map((item) => ({
			memberId: item.memberId,
			startDate: item.startDate.toISOString(),
			endDate: item.endDate.toISOString(),
		})),
		now.getTime(),
	);
	const currentAbsenceByMember = getCurrentAbsenceRowsByMember(absenceRows, now.getTime());
	const absentMembers = absentMemberIds
		.map((memberId) => {
			const absence = currentAbsenceByMember.get(memberId);
			const member = memberById.get(memberId);
			if (!absence || !member) return null;
			return {
				id: absence.id,
				memberId,
				name: member.name,
				endDate: absence.endDate.toISOString(),
				isCurrentMember: memberId === currentMemberId,
			};
		})
		.filter((item): item is NonNullable<typeof item> => item !== null);
	const openDebtByCurrency: CurrencyTotals = {};
	for (const balance of balances) {
		if (balance.balanceCents < 0) {
			addCurrencyTotal(openDebtByCurrency, balance.currency, -balance.balanceCents);
		}
	}
	const openDebtCents = singleCurrencyTotal(openDebtByCurrency);
	const openAnnouncementCount = countOpenManualAnnouncements(announcementRows);
	const hasAnnouncement = announcementRows.some((item) => item.source === 'manual');
	const overdueChoreCount = allDueChores.filter((item) => item.overdue).length;
	const currentMember = currentMemberId ? (memberById.get(currentMemberId) ?? null) : null;

	return {
		balances: [...balances].sort((a, b) => Math.abs(b.balanceCents) - Math.abs(a.balanceCents)),
		...spendSummary,
		openShoppingCount: openShopping.length,
		openShoppingTop,
		dueChores,
		activity: activity.slice(0, ACTIVITY_LIMIT),
		latestAnnouncement,
		myOpenAnnouncements: filteredMyOpenAnnouncements.map((item) => ({
			...item,
			createdAt: item.createdAt.toISOString(),
		})),
		wgHealth: getWgHealth({
			shareCode,
			openShoppingCount: openShopping.length,
			overdueChoreCount,
			openDebtCents: openDebtCents ?? 0,
			openDebtByCurrency,
			openAnnouncementCount,
			absentMemberCount: absentMemberIds.length,
			dueRecurringCount: dueRecurringExpenses.length,
		}),
		dueRecurringExpenses,
		absentMembers,
		setup: {
			choreCount: choreRows.length,
			hasExpense: expenseRows.length > 0,
			hasShoppingItem: shoppingRows.length > 0,
			hasAnnouncement,
			notificationsEnabled: Boolean(currentMember && currentMemberNotification?.pushOptIn),
		},
	};
}
