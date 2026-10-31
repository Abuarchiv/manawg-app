import { serverRenderContext } from '@/core/i18n/render-context';
import { getAbsentMemberIds } from '@/features/chores/absence';
import { getChoreStatus } from '@/features/chores/chore-status';
import { getDueRecurringExpenses } from '@/features/expenses/recurring-expenses';
import type { Locale } from '@/shared/i18n/locale';
import type { MemberBalance } from './dashboard-balances';
import { balanceTotalsFromRows, computeMemberBalances } from './dashboard-balances';
import { type ActivityItem, appendSecondaryActivity, buildPrimaryActivity } from './dashboard-feed';
import { ACTIVITY_LIMIT, loadPrimaryRows, loadSecondaryRows } from './dashboard-queries';
import {
	type CurrencyTotals,
	type DaySpend,
	dashboardSpendSince,
	summarizeDashboardSpend,
} from './dashboard-spend';

export { balanceTotalsFromRows, computeMemberBalances, summarizeDashboardSpend };

interface ChoreDue {
	id: string;
	title: string;
	assignedMemberId: string | null;
	assignedMemberName: string | null;
	assignedColor: string | null;
	nextDueAt: string;
	overdue: boolean;
}

interface DashboardSetup {
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

/** `announcementRows` holds manual posts only, newest first. */
function getLatestManualAnnouncement(
	announcementRows: Array<{
		id?: string;
		content: string;
		authorMemberId: string;
		createdAt: Date;
	}>,
	memberById: Map<string, { name: string }>,
): DashboardData['latestAnnouncement'] {
	const latestManual = announcementRows[0];
	return latestManual
		? {
				...(latestManual.id ? { id: latestManual.id } : {}),
				content: latestManual.content,
				authorName: memberById.get(latestManual.authorMemberId)?.name ?? '—',
				createdAt: latestManual.createdAt.toISOString(),
			}
		: null;
}

function getCurrentAbsenceRowsByMember<
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
				// Calendar-day based like the chore pages: due earlier today is not a gap yet.
				overdue: getChoreStatus(c.nextDueAt.toISOString(), now.getTime()).state === 'overdue',
			};
		})
		.sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

export async function loadDashboardData(
	wgId: string,
	currentMemberId?: string | null,
	shareCode = '',
	locale: Locale = 'de',
): Promise<DashboardData> {
	const now = new Date();
	const ctx = serverRenderContext(locale);

	const {
		memberRows,
		recentExpenses,
		openDebts,
		paymentRows,
		openShopping,
		recentShopping,
		choreRows,
		announcementRows,
		payerTotals,
		spendRows,
	} = await loadPrimaryRows(wgId, dashboardSpendSince(now));

	const memberById = new Map(memberRows.map((m) => [m.id, m]));

	const balances = computeMemberBalances(memberRows, payerTotals, openDebts, paymentRows);

	const spendSummary = summarizeDashboardSpend(spendRows, now, payerTotals);

	const openShoppingTop = openShopping
		.slice(0, 3)
		.map((s) => (s.quantity ? `${s.name} (${s.quantity})` : s.name));

	const allDueChores = buildDueChores(choreRows, memberById, now);
	const dueChores = allDueChores;

	const { activity, rawActivityByKey } = buildPrimaryActivity(
		recentExpenses,
		recentShopping,
		announcementRows,
		memberById,
		shareCode,
		ctx,
	);

	const latestAnnouncement = getLatestManualAnnouncement(announcementRows, memberById);
	const { myOpenAnnouncements, absenceRows, recurringRows, auditRows, currentMemberNotification } =
		await loadSecondaryRows(wgId, currentMemberId);
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
	appendSecondaryActivity(
		activity,
		rawActivityByKey,
		absenceRows,
		recurringRows,
		auditRows,
		memberById,
		shareCode,
		ctx,
	);
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
	const hasAnnouncement = announcementRows.length > 0;
	const currentMember = currentMemberId ? (memberById.get(currentMemberId) ?? null) : null;

	return {
		balances: [...balances].sort((a, b) => Math.abs(b.balanceCents) - Math.abs(a.balanceCents)),
		...spendSummary,
		openShoppingCount: openShopping.length,
		openShoppingTop,
		dueChores,
		activity: activity.slice(0, ACTIVITY_LIMIT),
		latestAnnouncement,
		myOpenAnnouncements: myOpenAnnouncements.map((item) => ({
			...item,
			createdAt: item.createdAt.toISOString(),
		})),
		dueRecurringExpenses,
		absentMembers,
		setup: {
			choreCount: choreRows.length,
			hasExpense: payerTotals.length > 0,
			hasShoppingItem: recentShopping.length > 0,
			hasAnnouncement,
			notificationsEnabled: Boolean(currentMember && currentMemberNotification?.pushOptIn),
		},
	};
}
