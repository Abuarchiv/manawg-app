import { recordAuditEvent } from '@/core/audit';
import { CHORE_RECURRENCE_TYPES, chores, db, wgMembers } from '@/core/db';
import type { ChoreRecurrenceType } from '@/core/db';
import { isWgAdmin } from '@/core/guards/admin';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { badRequest, conflict, forbidden, notFound, tooMany } from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { MS_PER_DAY } from '@/core/utils/time';
import { buildChorePatchUpdate } from '@/features/chores/chore-patch';
import { resolveChoreSwapRequest } from '@/features/chores/server/resolve-swap-request';
import { type SQL, and, eq, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const TITLE_MIN = 1;
const TITLE_MAX = 120;
const INTERVAL_MIN = 1;
const INTERVAL_MAX_DAYS = 365;
const INTERVAL_MAX_MONTHS = 60;

const patchSchema = z
	.object({
		title: z.string().trim().min(TITLE_MIN).max(TITLE_MAX).optional(),
		assignedMemberId: z.string().uuid().nullable().optional(),
		nextDueAt: z.string().datetime({ offset: true }).optional(),
		intervalDays: z.number().int().min(INTERVAL_MIN).optional(),
		// z.enum requires a mutable tuple; spread the readonly schema constant.
		recurrenceType: z.enum([...CHORE_RECURRENCE_TYPES]).optional(),
	})
	.superRefine((data, ctx) => {
		// Only validate the interval cap when intervalDays is being changed;
		// recurrenceType-only updates inherit the existing intervalDays.
		if (data.intervalDays === undefined) return;
		// Use the most permissive cap if recurrenceType is not provided in the
		// patch (the existing column value may be either). The cap mainly
		// guards against absurd values like intervalDays=999999.
		const cap = data.recurrenceType === 'months' ? INTERVAL_MAX_MONTHS : INTERVAL_MAX_DAYS;
		if (data.intervalDays > cap) {
			ctx.addIssue({
				code: z.ZodIssueCode.too_big,
				maximum: cap,
				inclusive: true,
				type: 'number',
				path: ['intervalDays'],
				message: `intervalDays must be <= ${cap}`,
			});
		}
	});

export const GET = withWgRoute<{ id: string }>('chores GET id', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const rows = await db
		.select()
		.from(chores)
		.where(and(eq(chores.id, id), eq(chores.wgId, auth.wg.id)))
		.limit(1);
	const chore = rows[0];
	if (!chore) return notFound('chore_not_found');
	return NextResponse.json({ chore });
});

export const PATCH = withWgRoute<{ id: string }>('chores PATCH', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

	const parsed = await parseBody(req, patchSchema, {
		fieldErrors: {
			title: 'title_invalid',
			assignedMemberId: 'member_id_invalid',
			nextDueAt: 'due_date_invalid',
			intervalDays: 'interval_invalid',
			recurrenceType: 'recurrence_type_invalid',
		},
	});
	if (!parsed.ok) return parsed.response;
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;

	const limited = await checkRateLimit(wgWriteLimiter, `chore:${wgId}:${auth.member.memberId}`);
	if (!limited.success) return tooMany();

	if (parsed.data.assignedMemberId) {
		const member = await db
			.select({ id: wgMembers.id })
			.from(wgMembers)
			.where(
				and(
					eq(wgMembers.id, parsed.data.assignedMemberId),
					eq(wgMembers.wgId, wgId),
					isNull(wgMembers.deactivatedAt),
				),
			)
			.limit(1);
		if (member.length === 0) return badRequest('member_not_in_wg');
	}
	// Read before the update: a changed assignee closes the swap request and
	// notifies the new one, a re-saved one does nothing.
	let previousAssigneeId: string | null = null;
	if (parsed.data.assignedMemberId !== undefined) {
		const [previous] = await db
			.select({ assignedMemberId: chores.assignedMemberId })
			.from(chores)
			.where(and(eq(chores.id, id), eq(chores.wgId, wgId)))
			.limit(1);
		if (!previous) return notFound('chore_not_found');
		previousAssigneeId = previous.assignedMemberId;
	}
	const cadenceChanged =
		parsed.data.intervalDays !== undefined || parsed.data.recurrenceType !== undefined;
	const needsCurrentChore = cadenceChanged || parsed.data.nextDueAt !== undefined;
	let currentChore: {
		intervalDays: number;
		recurrenceType: ChoreRecurrenceType;
		nextDueAt: Date;
	} | null = null;
	if (needsCurrentChore) {
		const existing = await db
			.select({
				intervalDays: chores.intervalDays,
				recurrenceType: chores.recurrenceType,
				nextDueAt: chores.nextDueAt,
			})
			.from(chores)
			.where(and(eq(chores.id, id), eq(chores.wgId, wgId)))
			.limit(1);
		const row = existing[0];
		if (!row) return notFound('chore_not_found');
		currentChore = row;
	}
	const recurrencePatch = currentChore ? buildChorePatchUpdate(currentChore, parsed.data) : null;
	if (cadenceChanged && recurrencePatch && !recurrencePatch.validCadence) {
		return badRequest('interval_invalid');
	}

	const update: {
		title?: string;
		assignedMemberId?: string | null;
		nextDueAt?: Date;
		anchorAt?: Date;
		intervalDays?: number;
		recurrenceType?: ChoreRecurrenceType;
		lastReminderAt?: SQL;
		updatedAt: Date;
	} = {
		updatedAt: new Date(),
	};
	if (recurrencePatch) Object.assign(update, recurrencePatch.update);
	if (parsed.data.title !== undefined) update.title = parsed.data.title;
	if (parsed.data.assignedMemberId !== undefined) {
		const nextAssignee = parsed.data.assignedMemberId;
		update.assignedMemberId = nextAssignee;
		// A new assignee starts with a fresh reminder throttle, as on completion
		// and move-out; re-saving the same assignee keeps it.
		update.lastReminderAt = sql`case when ${chores.assignedMemberId} is distinct from ${nextAssignee}::uuid then null else ${chores.lastReminderAt} end`;
	}

	const currentMatch = currentChore
		? and(
				eq(chores.intervalDays, currentChore.intervalDays),
				eq(chores.recurrenceType, currentChore.recurrenceType),
				eq(chores.nextDueAt, currentChore.nextDueAt),
			)
		: undefined;
	const [updated] = await db
		.update(chores)
		.set(update)
		.where(and(eq(chores.id, id), eq(chores.wgId, wgId), currentMatch))
		.returning();

	if (!updated) {
		if (currentChore) {
			const stillExists = await db
				.select({ id: chores.id })
				.from(chores)
				.where(and(eq(chores.id, id), eq(chores.wgId, wgId)))
				.limit(1);
			if (stillExists.length > 0) return conflict('chore_changed');
		}
		return notFound('chore_not_found');
	}
	await recordAuditEvent({
		wgId,
		memberId: auth.member.memberId,
		eventType: 'chore.updated',
		entityType: 'chore',
		entityId: updated.id,
		summary: `${auth.member.name} hat ${updated.title} aktualisiert.`,
		metadata: {
			nextDueAt: updated.nextDueAt.toISOString(),
			assignedMemberId: updated.assignedMemberId,
			intervalDays: updated.intervalDays,
			recurrenceType: updated.recurrenceType,
		},
	});
	const assigneeChanged =
		parsed.data.assignedMemberId !== undefined && previousAssigneeId !== updated.assignedMemberId;
	if (assigneeChanged) await resolveChoreSwapRequest(wgId, id, auth.member.memberId);
	// Taking over a chore yourself needs no push; handing a due chore to someone else does.
	if (
		assigneeChanged &&
		updated.assignedMemberId &&
		updated.assignedMemberId !== auth.member.memberId &&
		updated.nextDueAt.getTime() <= Date.now() + MS_PER_DAY
	) {
		await dispatchNotificationSafely({
			wg: auth.wg,
			event: 'chore.due',
			payload: {
				title: updated.title,
				choreId: updated.id,
				nextDueAt: updated.nextDueAt.toISOString(),
			},
			targetMemberIds: [updated.assignedMemberId],
		});
	}
	return NextResponse.json({ chore: updated });
});

export const DELETE = withWgRoute<{ id: string }>('chores DELETE', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;

	// Admin-only gate: chores are shared infrastructure for the whole WG,
	// so any member can edit/reassign (PATCH stays open for collaboration),
	// but only the admin may permanently remove a chore from the plan.
	// Without this check, any member could wipe the chore plan (P1 audit
	// finding).
	if (!(await isWgAdmin(wgId, auth.member.memberId))) {
		return forbidden('admin_required', 'admin_required');
	}

	const limited = await checkRateLimit(wgWriteLimiter, `chore:${wgId}:${auth.member.memberId}`);
	if (!limited.success) return tooMany();

	const existing = await db
		.select({ title: chores.title })
		.from(chores)
		.where(and(eq(chores.id, id), eq(chores.wgId, wgId)))
		.limit(1);
	const row = existing[0];
	if (!row) return notFound('chore_not_found');

	const result = await db
		.delete(chores)
		.where(and(eq(chores.id, id), eq(chores.wgId, wgId)))
		.returning({ id: chores.id });

	if (result.length === 0) return notFound('chore_not_found');
	await resolveChoreSwapRequest(wgId, id, auth.member.memberId);
	await recordAuditEvent({
		wgId,
		memberId: auth.member.memberId,
		eventType: 'chore.deleted',
		entityType: 'chore',
		entityId: id,
		summary: `${auth.member.name} hat ${row.title} aus dem Putzplan entfernt.`,
		metadata: { title: row.title },
	});
	return NextResponse.json({ deleted: result[0]?.id });
});
