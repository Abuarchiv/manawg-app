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
import { and, count, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';

import { CHAT_AUDIT_EVENT_TYPES } from './activity-audit';

export const ACTIVITY_LIMIT = 6;

// Reads that drive household counts must succeed; falling back to an empty
// list would report a false zero. Optional activity sections may still degrade.
// Financial reads must all succeed or balances would be fabricated.
function withFallback<T>(label: string, query: Promise<T>, fallback: () => T): Promise<T> {
	return query.catch((err: unknown) => {
		captureException(err, { action: 'loadDashboardData', query: label });
		return fallback();
	});
}

export function loadPrimaryRows(wgId: string) {
	return Promise.all([
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
		// Bought items accumulate forever; the dashboard only needs the open list
		// (count and top entries) plus the latest few for the activity preview.
		db
			.select({ name: shoppingItems.name, quantity: shoppingItems.quantity })
			.from(shoppingItems)
			.where(and(eq(shoppingItems.wgId, wgId), isNull(shoppingItems.boughtAt)))
			.orderBy(desc(shoppingItems.createdAt)),
		db
			.select({
				id: shoppingItems.id,
				name: shoppingItems.name,
				addedByMemberId: shoppingItems.addedByMemberId,
				boughtByMemberId: shoppingItems.boughtByMemberId,
				createdAt: shoppingItems.createdAt,
				boughtAt: shoppingItems.boughtAt,
			})
			.from(shoppingItems)
			.where(eq(shoppingItems.wgId, wgId))
			// Same instant the feed uses, so a long-open item bought just now is not cut off.
			.orderBy(desc(sql`coalesce(${shoppingItems.boughtAt}, ${shoppingItems.createdAt})`))
			.limit(ACTIVITY_LIMIT),
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
					createdAt: announcements.createdAt,
				})
				.from(announcements)
				.where(and(eq(announcements.wgId, wgId), eq(announcements.source, 'manual')))
				.orderBy(desc(announcements.createdAt))
				.limit(ACTIVITY_LIMIT),
			() => [],
		),
		withFallback(
			'openAnnouncementCount',
			db
				.select({ value: count() })
				.from(announcements)
				.where(
					and(
						eq(announcements.wgId, wgId),
						eq(announcements.source, 'manual'),
						eq(announcements.status, 'open'),
					),
				),
			() => [],
		),
	]);
}

export type PrimaryRows = Awaited<ReturnType<typeof loadPrimaryRows>>;

export function loadSecondaryRows(wgId: string, currentMemberId: string | null | undefined) {
	return Promise.all([
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
					createdAt: memberAbsences.createdAt,
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
				// Chat audits carry no content worth a feed row and would crowd out real events.
				.where(
					and(
						eq(auditEvents.wgId, wgId),
						notInArray(auditEvents.eventType, [...CHAT_AUDIT_EVENT_TYPES]),
					),
				)
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
}

export type SecondaryRows = Awaited<ReturnType<typeof loadSecondaryRows>>;
