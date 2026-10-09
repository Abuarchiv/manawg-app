import {
	announcementComments,
	announcements,
	auditEvents,
	choreCompletions,
	chores,
	db,
	expensePayments,
	expenses,
	memberAbsences,
	recurringExpenses,
	shoppingItems,
	wgChatMessages,
	wgEvents,
	wgInventoryItems,
	wgMembers,
} from '@/core/db';
import { type SQL, count, eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { ExportRow, ExportSectionCounts, ExportSectionKey } from './export';
import {
	fetchAnnouncementCommentRows,
	fetchAnnouncementRows,
	fetchAuditRows,
	fetchChatMessageRows,
	fetchEventRows,
	mapAnnouncementCommentRows,
	mapAnnouncementRows,
	mapAuditRows,
	mapChatMessageRows,
	mapEventRows,
} from './export-queries-community';
import {
	completedPaymentsOf,
	fetchExpensePaymentRows,
	fetchExpenseRows,
	fetchRecurringRows,
	loadSplitsByExpense,
	mapExpensePaymentRows,
	mapExpenseRows,
	mapRecurringRows,
} from './export-queries-finance';
import {
	fetchAbsenceRows,
	fetchChoreCompletionRows,
	fetchChoreRows,
	fetchInventoryRows,
	fetchMemberRows,
	fetchShoppingRows,
	mapAbsenceRows,
	mapChoreCompletionRows,
	mapChoreRows,
	mapInventoryRows,
	mapMemberRows,
	mapShoppingRows,
} from './export-queries-household';
import type { ExportPage } from './export-queries-types';

export { type ExportPage, NO_EXPORT_LIMIT } from './export-queries-types';
export {
	type MemberRows,
	fetchMemberRows,
	mapMemberRows,
	toMemberById,
} from './export-queries-household';

/** Resolves member id -> name; rejects when the roster could not be read. */
export type MemberDirectory = () => Promise<Map<string, string>>;

/**
 * Sections that join member names. The JSON dump reads the roster once up
 * front, and a failed roster read must fail exactly these sections.
 */
export const MEMBER_NAME_SECTIONS: Exclude<ExportSectionKey, 'members'>[] = [
	'expenses',
	'expensePayments',
	'recurringExpenses',
	'shoppingItems',
	'chores',
	'choreCompletions',
	'absences',
	'announcements',
	'announcementComments',
	'events',
	'chatMessages',
	'auditEvents',
];

/**
 * One fetch + map per section, shared by the single-section CSV download and
 * the full JSON dump. Name-joining sections read their rows in parallel with
 * `memberDirectory`, so a failed roster fails each of them.
 */
export function buildSectionLoaders(
	wgId: string,
	page: ExportPage,
	memberDirectory: MemberDirectory,
): Record<ExportSectionKey, () => Promise<ExportRow[]>> {
	function withNames<R>(
		fetchRows: () => Promise<R>,
		mapRows: (rows: R, memberById: Map<string, string>) => ExportRow[],
	): () => Promise<ExportRow[]> {
		return async () => {
			const [memberById, rows] = await Promise.all([memberDirectory(), fetchRows()]);
			return mapRows(rows, memberById);
		};
	}

	return {
		members: async () => mapMemberRows(await fetchMemberRows(wgId)),
		expenses: async () => {
			const [memberById, expenseRows] = await Promise.all([
				memberDirectory(),
				fetchExpenseRows(wgId, page),
			]);
			const splitsByExpense = await loadSplitsByExpense(expenseRows.map((expense) => expense.id));
			return mapExpenseRows(expenseRows, memberById, splitsByExpense);
		},
		expensePayments: withNames(() => fetchExpensePaymentRows(wgId, page), mapExpensePaymentRows),
		recurringExpenses: withNames(() => fetchRecurringRows(wgId, page), mapRecurringRows),
		shoppingItems: withNames(() => fetchShoppingRows(wgId, page), mapShoppingRows),
		chores: withNames(() => fetchChoreRows(wgId, page), mapChoreRows),
		choreCompletions: withNames(() => fetchChoreCompletionRows(wgId, page), mapChoreCompletionRows),
		inventory: async () => mapInventoryRows(await fetchInventoryRows(wgId, page)),
		absences: withNames(() => fetchAbsenceRows(wgId, page), mapAbsenceRows),
		announcements: withNames(() => fetchAnnouncementRows(wgId, page), mapAnnouncementRows),
		announcementComments: withNames(
			() => fetchAnnouncementCommentRows(wgId, page),
			mapAnnouncementCommentRows,
		),
		events: withNames(() => fetchEventRows(wgId, page), mapEventRows),
		chatMessages: withNames(() => fetchChatMessageRows(wgId, page), mapChatMessageRows),
		auditEvents: withNames(() => fetchAuditRows(wgId, page), mapAuditRows),
	};
}

async function countRows(table: PgTable, where: SQL | undefined): Promise<number> {
	const [row] = await db.select({ value: count() }).from(table).where(where);
	return row?.value ?? 0;
}

/**
 * Row count per section with the same filters as the dump, for the settings
 * summary. Counting instead of downloading keeps the summary cheap for WGs with
 * a long chat history.
 */
export async function countExportSections(wgId: string): Promise<ExportSectionCounts> {
	const [
		members,
		expenseCount,
		expensePaymentCount,
		recurringExpenseCount,
		shoppingItemCount,
		choreCount,
		choreCompletionCount,
		inventoryCount,
		absenceCount,
		announcementCount,
		announcementCommentCount,
		eventCount,
		chatMessageCount,
		auditEventCount,
	] = await Promise.all([
		countRows(wgMembers, eq(wgMembers.wgId, wgId)),
		countRows(expenses, eq(expenses.wgId, wgId)),
		countRows(expensePayments, completedPaymentsOf(wgId)),
		countRows(recurringExpenses, eq(recurringExpenses.wgId, wgId)),
		countRows(shoppingItems, eq(shoppingItems.wgId, wgId)),
		countRows(chores, eq(chores.wgId, wgId)),
		db
			.select({ value: count() })
			.from(choreCompletions)
			.innerJoin(chores, eq(choreCompletions.choreId, chores.id))
			.where(eq(chores.wgId, wgId))
			.then(([row]) => row?.value ?? 0),
		countRows(wgInventoryItems, eq(wgInventoryItems.wgId, wgId)),
		countRows(memberAbsences, eq(memberAbsences.wgId, wgId)),
		countRows(announcements, eq(announcements.wgId, wgId)),
		db
			.select({ value: count() })
			.from(announcementComments)
			.innerJoin(announcements, eq(announcementComments.announcementId, announcements.id))
			.where(eq(announcements.wgId, wgId))
			.then(([row]) => row?.value ?? 0),
		countRows(wgEvents, eq(wgEvents.wgId, wgId)),
		countRows(wgChatMessages, eq(wgChatMessages.wgId, wgId)),
		countRows(auditEvents, eq(auditEvents.wgId, wgId)),
	]);
	return {
		members,
		expenses: expenseCount,
		expensePayments: expensePaymentCount,
		recurringExpenses: recurringExpenseCount,
		shoppingItems: shoppingItemCount,
		chores: choreCount,
		choreCompletions: choreCompletionCount,
		inventory: inventoryCount,
		absences: absenceCount,
		announcements: announcementCount,
		announcementComments: announcementCommentCount,
		events: eventCount,
		chatMessages: chatMessageCount,
		auditEvents: auditEventCount,
	};
}
