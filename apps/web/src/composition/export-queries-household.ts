import {
	choreCompletions,
	chores,
	db,
	memberAbsences,
	shoppingItems,
	wgInventoryItems,
	wgMembers,
} from '@/core/db';
import { asc, desc, eq } from 'drizzle-orm';
import type { ExportPage } from './export-queries-types';

export async function fetchMemberRows(wgId: string) {
	// Always the FULL roster: members are join-capped (small) and double as
	// the name directory for every other section — paging is only applied to
	// the potentially unbounded sections below.
	return db
		.select({ id: wgMembers.id, name: wgMembers.name, createdAt: wgMembers.createdAt })
		.from(wgMembers)
		.where(eq(wgMembers.wgId, wgId))
		.orderBy(asc(wgMembers.createdAt), asc(wgMembers.id));
}
export type MemberRows = Awaited<ReturnType<typeof fetchMemberRows>>;

export function toMemberById(memberRows: MemberRows): Map<string, string> {
	return new Map(memberRows.map((member) => [member.id, member.name]));
}
export function mapMemberRows(memberRows: MemberRows) {
	return memberRows.map((member) => ({
		id: member.id,
		name: member.name,
		createdAt: member.createdAt.toISOString(),
	}));
}

export async function fetchShoppingRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: shoppingItems.id,
			name: shoppingItems.name,
			quantity: shoppingItems.quantity,
			addedByMemberId: shoppingItems.addedByMemberId,
			boughtByMemberId: shoppingItems.boughtByMemberId,
			boughtAt: shoppingItems.boughtAt,
			createdAt: shoppingItems.createdAt,
		})
		.from(shoppingItems)
		.where(eq(shoppingItems.wgId, wgId))
		.orderBy(desc(shoppingItems.createdAt), desc(shoppingItems.id))
		.limit(page.limit)
		.offset(page.offset);
}
export function mapShoppingRows(
	shoppingRows: Awaited<ReturnType<typeof fetchShoppingRows>>,
	memberById: Map<string, string>,
) {
	return shoppingRows.map((item) => ({
		id: item.id,
		name: item.name,
		quantity: item.quantity ?? '',
		status: item.boughtAt ? 'erledigt' : 'offen',
		addedBy: memberById.get(item.addedByMemberId) ?? '',
		boughtBy: item.boughtByMemberId ? (memberById.get(item.boughtByMemberId) ?? '') : '',
		boughtAt: item.boughtAt?.toISOString() ?? '',
		createdAt: item.createdAt.toISOString(),
	}));
}

export async function fetchChoreRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: chores.id,
			title: chores.title,
			assignedMemberId: chores.assignedMemberId,
			nextDueAt: chores.nextDueAt,
			intervalDays: chores.intervalDays,
			recurrenceType: chores.recurrenceType,
		})
		.from(chores)
		.where(eq(chores.wgId, wgId))
		.orderBy(desc(chores.nextDueAt), desc(chores.id))
		.limit(page.limit)
		.offset(page.offset);
}
export function mapChoreRows(
	choreRows: Awaited<ReturnType<typeof fetchChoreRows>>,
	memberById: Map<string, string>,
) {
	return choreRows.map((chore) => ({
		id: chore.id,
		title: chore.title,
		assignedName: chore.assignedMemberId ? (memberById.get(chore.assignedMemberId) ?? '') : '',
		nextDueAt: chore.nextDueAt.toISOString(),
		intervalDays: chore.intervalDays,
		recurrenceType: chore.recurrenceType,
	}));
}

export async function fetchAbsenceRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: memberAbsences.id,
			memberId: memberAbsences.memberId,
			startDate: memberAbsences.startDate,
			endDate: memberAbsences.endDate,
			reason: memberAbsences.reason,
			createdAt: memberAbsences.createdAt,
		})
		.from(memberAbsences)
		.where(eq(memberAbsences.wgId, wgId))
		.orderBy(desc(memberAbsences.startDate), desc(memberAbsences.id))
		.limit(page.limit)
		.offset(page.offset);
}
export function mapAbsenceRows(
	absenceRows: Awaited<ReturnType<typeof fetchAbsenceRows>>,
	memberById: Map<string, string>,
) {
	return absenceRows.map((absence) => ({
		id: absence.id,
		memberName: memberById.get(absence.memberId) ?? '',
		startDate: absence.startDate.toISOString(),
		endDate: absence.endDate.toISOString(),
		reason: absence.reason ?? '',
		createdAt: absence.createdAt.toISOString(),
	}));
}

export async function fetchChoreCompletionRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: choreCompletions.id,
			choreTitle: chores.title,
			completedByMemberId: choreCompletions.completedByMemberId,
			completedAt: choreCompletions.completedAt,
		})
		.from(choreCompletions)
		.innerJoin(chores, eq(choreCompletions.choreId, chores.id))
		.where(eq(chores.wgId, wgId))
		.orderBy(desc(choreCompletions.completedAt), desc(choreCompletions.id))
		.limit(page.limit)
		.offset(page.offset);
}
export function mapChoreCompletionRows(
	rows: Awaited<ReturnType<typeof fetchChoreCompletionRows>>,
	memberById: Map<string, string>,
) {
	return rows.map((row) => ({
		id: row.id,
		choreTitle: row.choreTitle,
		completedByName: memberById.get(row.completedByMemberId) ?? '',
		completedAt: row.completedAt.toISOString(),
	}));
}

export async function fetchInventoryRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: wgInventoryItems.id,
			name: wgInventoryItems.name,
			quantity: wgInventoryItems.quantity,
			unit: wgInventoryItems.unit,
			threshold: wgInventoryItems.threshold,
			category: wgInventoryItems.category,
			lastDecrementedAt: wgInventoryItems.lastDecrementedAt,
			createdAt: wgInventoryItems.createdAt,
		})
		.from(wgInventoryItems)
		.where(eq(wgInventoryItems.wgId, wgId))
		.orderBy(desc(wgInventoryItems.createdAt), desc(wgInventoryItems.id))
		.limit(page.limit)
		.offset(page.offset);
}
export function mapInventoryRows(rows: Awaited<ReturnType<typeof fetchInventoryRows>>) {
	return rows.map((item) => ({
		id: item.id,
		name: item.name,
		quantity: item.quantity,
		unit: item.unit,
		threshold: item.threshold,
		category: item.category,
		lastDecrementedAt: item.lastDecrementedAt?.toISOString() ?? '',
		createdAt: item.createdAt.toISOString(),
	}));
}
