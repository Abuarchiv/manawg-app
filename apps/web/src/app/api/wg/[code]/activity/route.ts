import {
	REMINDER_ANNOUNCEMENT_KINDS,
	buildActivityTimeline,
	getActivityReminders,
} from '@/composition/activity';
import {
	announcements,
	auditEvents,
	choreCompletions,
	chores,
	db,
	expenses,
	memberAbsences,
	recurringExpenses,
	shoppingItems,
	wgMembers,
} from '@/core/db';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { MEMBER_ANNOUNCEMENT_SOURCES } from '@/features/pinnwand/announcement-workflow';
import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export const GET = withWgRoute('activity GET', async (req, { code }) => {
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;

	const [
		members,
		expenseRows,
		shoppingRows,
		announcementRows,
		choreRows,
		recurringRows,
		absenceRows,
		auditRows,
		openShoppingRows,
		openAnnouncementRows,
	] = await Promise.all([
		db
			.select({ id: wgMembers.id, name: wgMembers.name })
			.from(wgMembers)
			.where(eq(wgMembers.wgId, wg.id)),
		db
			.select({
				id: expenses.id,
				paidByMemberId: expenses.paidByMemberId,
				description: expenses.description,
				amountCents: expenses.amountCents,
				currency: expenses.currency,
				occurredAt: expenses.occurredAt,
			})
			.from(expenses)
			.where(eq(expenses.wgId, wg.id))
			.orderBy(desc(expenses.occurredAt))
			.limit(120),
		db
			.select({
				id: shoppingItems.id,
				addedByMemberId: shoppingItems.addedByMemberId,
				name: shoppingItems.name,
				createdAt: shoppingItems.createdAt,
				boughtAt: shoppingItems.boughtAt,
			})
			.from(shoppingItems)
			.where(eq(shoppingItems.wgId, wg.id))
			.orderBy(desc(shoppingItems.createdAt))
			.limit(120),
		db
			.select({
				id: announcements.id,
				authorMemberId: announcements.authorMemberId,
				content: announcements.content,
				kind: announcements.kind,
				status: announcements.status,
				createdAt: announcements.createdAt,
				source: announcements.source,
			})
			.from(announcements)
			.where(
				and(
					eq(announcements.wgId, wg.id),
					inArray(announcements.source, MEMBER_ANNOUNCEMENT_SOURCES),
				),
			)
			.orderBy(desc(announcements.createdAt))
			.limit(120),
		db
			.select({
				id: chores.id,
				title: chores.title,
				nextDueAt: chores.nextDueAt,
				assignedMemberId: chores.assignedMemberId,
			})
			.from(chores)
			// Only overdue chores feed the reminders; oldest first so the cap
			// never drops the ones that have been hanging the longest.
			.where(and(eq(chores.wgId, wg.id), lte(chores.nextDueAt, new Date())))
			.orderBy(asc(chores.nextDueAt))
			.limit(120),
		db
			.select({
				id: recurringExpenses.id,
				description: recurringExpenses.description,
				amountCents: recurringExpenses.amountCents,
				paidByMemberId: recurringExpenses.paidByMemberId,
				createdAt: recurringExpenses.createdAt,
				lastCreatedAt: recurringExpenses.lastCreatedAt,
			})
			.from(recurringExpenses)
			.where(eq(recurringExpenses.wgId, wg.id))
			.orderBy(desc(recurringExpenses.createdAt))
			.limit(120),
		db
			.select({
				id: memberAbsences.id,
				memberId: memberAbsences.memberId,
				startDate: memberAbsences.startDate,
				endDate: memberAbsences.endDate,
				reason: memberAbsences.reason,
				createdAt: memberAbsences.createdAt,
			})
			.from(memberAbsences)
			.where(eq(memberAbsences.wgId, wg.id))
			.orderBy(desc(memberAbsences.createdAt))
			.limit(120),
		db
			.select({
				id: auditEvents.id,
				memberId: auditEvents.memberId,
				eventType: auditEvents.eventType,
				entityType: auditEvents.entityType,
				entityId: auditEvents.entityId,
				summary: auditEvents.summary,
				metadataJson: auditEvents.metadataJson,
				createdAt: auditEvents.createdAt,
			})
			.from(auditEvents)
			.where(eq(auditEvents.wgId, wg.id))
			.orderBy(desc(auditEvents.createdAt))
			.limit(120),
		// Reminders read their own open rows, oldest first, so bought items
		// and system notices in the newest timeline rows never hide them.
		db
			.select({
				id: shoppingItems.id,
				name: shoppingItems.name,
				createdAt: shoppingItems.createdAt,
			})
			.from(shoppingItems)
			.where(and(eq(shoppingItems.wgId, wg.id), isNull(shoppingItems.boughtAt)))
			.orderBy(asc(shoppingItems.createdAt))
			.limit(120),
		db
			.select({
				id: announcements.id,
				content: announcements.content,
				kind: announcements.kind,
				createdAt: announcements.createdAt,
			})
			.from(announcements)
			.where(
				and(
					eq(announcements.wgId, wg.id),
					eq(announcements.status, 'open'),
					inArray(announcements.kind, [...REMINDER_ANNOUNCEMENT_KINDS]),
					inArray(announcements.source, MEMBER_ANNOUNCEMENT_SOURCES),
				),
			)
			.orderBy(asc(announcements.createdAt))
			.limit(120),
	]);

	const completionRows = await db
		.select({
			id: choreCompletions.id,
			choreId: choreCompletions.choreId,
			choreTitle: chores.title,
			completedByMemberId: choreCompletions.completedByMemberId,
			completedAt: choreCompletions.completedAt,
		})
		.from(choreCompletions)
		.innerJoin(chores, eq(choreCompletions.choreId, chores.id))
		.where(eq(chores.wgId, wg.id))
		.orderBy(desc(choreCompletions.completedAt))
		.limit(120);
	const memberById = new Map(members.map((member) => [member.id, member]));

	return NextResponse.json({
		items: buildActivityTimeline({
			members,
			expenses: expenseRows.map((item) => ({
				...item,
				occurredAt: item.occurredAt.toISOString(),
			})),
			shoppingItems: shoppingRows.map((item) => ({
				...item,
				createdAt: item.createdAt.toISOString(),
				boughtAt: item.boughtAt?.toISOString() ?? null,
			})),
			announcements: announcementRows.map((item) => ({
				...item,
				createdAt: item.createdAt.toISOString(),
			})),
			choreCompletions: completionRows.map((item) => ({
				...item,
				completedAt: item.completedAt.toISOString(),
			})),
			recurringExpenses: recurringRows.map((item) => ({
				...item,
				currency: 'EUR',
				createdAt: item.createdAt.toISOString(),
				lastCreatedAt: item.lastCreatedAt?.toISOString() ?? null,
			})),
			absences: absenceRows.map((item) => ({
				...item,
				startDate: item.startDate.toISOString(),
				endDate: item.endDate.toISOString(),
				createdAt: item.createdAt.toISOString(),
			})),
			auditEvents: auditRows.map((item) => ({
				...item,
				createdAt: item.createdAt.toISOString(),
			})),
			limit: 80,
		}),
		reminders: getActivityReminders({
			openShoppingItems: openShoppingRows.map((item) => ({
				id: item.id,
				name: item.name,
				createdAt: item.createdAt.toISOString(),
			})),
			dueChores: choreRows.map((item) => ({
				id: item.id,
				title: item.title,
				nextDueAt: item.nextDueAt.toISOString(),
				assignedName: item.assignedMemberId
					? (memberById.get(item.assignedMemberId)?.name ?? null)
					: null,
			})),
			openAnnouncements: openAnnouncementRows.map((item) => ({
				id: item.id,
				content: item.content,
				kind: item.kind,
				createdAt: item.createdAt.toISOString(),
			})),
		}),
	});
});
