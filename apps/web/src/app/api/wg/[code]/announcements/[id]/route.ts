import { and, eq, type SQL, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/core/audit';
import { announcementReactions, announcements, db, wgMembers } from '@/core/db';
import { lockActiveAccountMember } from '@/core/db/account-deletion';
import { revokePrivateImageIfUnreferenced } from '@/core/db/private-image-deletions';
import { rowHoldsPatch } from '@/core/db/row-holds-patch';
import { lockExpensePayments, withTransaction } from '@/core/db/transaction';
import { isWgAdmin, requireOwnerOrAdmin } from '@/core/guards/admin';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import {
	badRequest,
	conflict,
	forbidden,
	notFound,
	rateLimitResponse,
	unauthorized,
} from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import {
	dispatchNotificationSafely,
	type NotificationDispatchWarning,
} from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { announcementPushTitle } from '@/features/announcements/announcement-push-title';
import { patchAnnouncementSchema } from '@/features/announcements/server/announcement-patch-schema';

export const PATCH = withWgRoute<{ id: string }>(
	'announcement PATCH',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

		const parsed = await parseBody(req, patchAnnouncementSchema, {
			fieldErrors: {
				status: 'status_invalid',
				pinned: 'pinned_invalid',
				kind: 'kind_invalid',
				content: 'content_invalid',
				expectedUpdatedAt: 'expected_state_invalid',
			},
		});
		if (!parsed.ok) return parsed.response;
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;
		const limited = rateLimitResponse(
			await checkRateLimit(wgWriteLimiter, `announcement-patch:${wg.id}:${auth.member.memberId}`),
		);
		if (limited) return limited;

		const existing = await db
			.select({
				id: announcements.id,
				authorMemberId: announcements.authorMemberId,
				content: announcements.content,
				status: announcements.status,
				source: announcements.source,
			})
			.from(announcements)
			.where(and(eq(announcements.id, id), eq(announcements.wgId, wg.id)))
			.limit(1);
		const row = existing[0];
		if (!row) return notFound('announcement_not_found');

		// Posts generated from a chore or an expense carry system text; only manual posts are editable.
		if (parsed.data.content !== undefined && row.source !== 'manual') {
			return forbidden('content_locked', 'content_locked');
		}

		const changesModeratedFields =
			parsed.data.kind !== undefined ||
			parsed.data.pinned !== undefined ||
			parsed.data.content !== undefined;
		const isAuthor = row.authorMemberId === auth.member.memberId;
		if (changesModeratedFields) {
			const denied = await requireOwnerOrAdmin(wg.id, auth.member, row.authorMemberId);
			if (denied) return denied;
		}

		const now = new Date();
		const patch: {
			content?: string;
			kind?: string;
			pinnedAt?: Date | null;
			status?: string;
			resolvedAt?: Date | null;
			resolvedByMemberId?: string | null;
			updatedAt: SQL;
		} = {
			updatedAt: sql`greatest(clock_timestamp(), ${announcements.updatedAt} + interval '1 millisecond')`,
		};
		if (parsed.data.kind) patch.kind = parsed.data.kind;
		if (parsed.data.content !== undefined) patch.content = parsed.data.content;
		if (typeof parsed.data.pinned === 'boolean') {
			patch.pinnedAt = parsed.data.pinned ? now : null;
		}
		if (parsed.data.status) {
			const hasTaken = await db
				.select({ id: announcementReactions.id })
				.from(announcementReactions)
				.where(
					and(
						eq(announcementReactions.announcementId, id),
						eq(announcementReactions.memberId, auth.member.memberId),
						eq(announcementReactions.reaction, 'take'),
					),
				)
				.limit(1);
			// Admins close posts nobody owns anymore, e.g. open asks of members who moved out.
			if (!isAuthor && hasTaken.length === 0 && !(await isWgAdmin(wg.id, auth.member.memberId))) {
				return forbidden('status_change_not_allowed', 'status_change_not_allowed');
			}
			patch.status = parsed.data.status;
			patch.resolvedAt = parsed.data.status === 'resolved' ? now : null;
			patch.resolvedByMemberId = parsed.data.status === 'resolved' ? auth.member.memberId : null;
		}

		// The caller is read again with the write: a member who moved out since the request began
		// cannot save, and moving out waits for this write.
		const outcome = await withTransaction(async (tx) => {
			const [caller] = await tx
				.select({ deactivatedAt: wgMembers.deactivatedAt, role: wgMembers.role })
				.from(wgMembers)
				.where(and(eq(wgMembers.id, auth.member.memberId), eq(wgMembers.wgId, wg.id)))
				.limit(1)
				.for('share');
			if (!caller || caller.deactivatedAt) return 'member_deactivated' as const;
			// The owner-or-admin decision is repeated with the role as it is now.
			if (changesModeratedFields && !isAuthor && caller.role !== 'admin') {
				return 'not_allowed' as const;
			}
			const [current] = await tx
				.select({ status: announcements.status })
				.from(announcements)
				.where(and(eq(announcements.id, id), eq(announcements.wgId, wg.id)))
				.limit(1)
				.for('update');
			if (!current) return null;
			if (patch.status !== undefined && !isAuthor && caller.role !== 'admin') {
				const [take] = await tx
					.select({ id: announcementReactions.id })
					.from(announcementReactions)
					.where(
						and(
							eq(announcementReactions.announcementId, id),
							eq(announcementReactions.memberId, auth.member.memberId),
							eq(announcementReactions.reaction, 'take'),
						),
					)
					.limit(1);
				if (!take) return 'status_change_not_allowed' as const;
			}
			// A repeated resolve (stale board, retry) keeps who resolved the post and when.
			const statusChanged = patch.status !== undefined && patch.status !== current.status;
			const [saved] = await tx
				.update(announcements)
				.set(
					statusChanged
						? patch
						: { ...patch, status: undefined, resolvedAt: undefined, resolvedByMemberId: undefined },
				)
				.where(
					and(
						eq(announcements.id, id),
						eq(announcements.wgId, wg.id),
						parsed.data.expectedUpdatedAt
							? sql`date_trunc('milliseconds', ${announcements.updatedAt}) = ${new Date(parsed.data.expectedUpdatedAt)}`
							: undefined,
					),
				)
				.returning();
			return saved ? { saved, statusChanged } : null;
		});
		if (outcome === 'member_deactivated') return unauthorized('member_deactivated');
		if (outcome === 'not_allowed') return forbidden('not_owner', 'not_owner');
		if (outcome === 'status_change_not_allowed') {
			return forbidden('status_change_not_allowed', 'status_change_not_allowed');
		}
		if (!outcome) {
			const [stored] = await db
				.select()
				.from(announcements)
				.where(and(eq(announcements.id, id), eq(announcements.wgId, wg.id)))
				.limit(1);
			if (!stored) return notFound('announcement_not_found');
			// The retry of a save whose answer got lost finds its own values in place.
			const requested = {
				content: patch.content,
				kind: patch.kind,
				status: patch.status,
				pinned: parsed.data.pinned,
			};
			if (rowHoldsPatch({ ...stored, pinned: stored.pinnedAt !== null }, requested)) {
				return NextResponse.json({ announcement: stored, warning: null });
			}
			return conflict('announcement_changed');
		}
		const updated = outcome.saved;
		await recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'announcement.updated',
			entityType: 'announcement',
			entityId: updated.id,
			actorName: auth.member.name,
			metadata: {
				status: updated.status,
				kind: updated.kind,
				pinned: updated.pinnedAt !== null,
				statusChanged: outcome.statusChanged,
			},
		});
		let warning: NotificationDispatchWarning = null;
		// Decided under the row lock, so a double tap or two concurrent resolves push once.
		if (parsed.data.status === 'resolved' && outcome.statusChanged) {
			const takers = await db
				.select({ memberId: announcementReactions.memberId })
				.from(announcementReactions)
				.where(
					and(
						eq(announcementReactions.announcementId, id),
						eq(announcementReactions.reaction, 'take'),
					),
				);
			const targetMemberIds = Array.from(
				new Set([row.authorMemberId, ...takers.map((taker) => taker.memberId)]),
			);
			const delivery = await dispatchNotificationSafely({
				wg,
				event: 'announcement.resolved',
				payload: {
					announcementId: id,
					title: announcementPushTitle(row.content),
					actorName: auth.member.name,
				},
				targetMemberIds,
				excludeMemberId: auth.member.memberId,
			});
			warning = delivery.warning;
		}
		return NextResponse.json({ announcement: updated, warning });
	},
);

export const DELETE = withWgRoute<{ id: string }>(
	'announcement DELETE',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;
		const limited = rateLimitResponse(
			await checkRateLimit(wgWriteLimiter, `announcement-delete:${wgId}:${auth.member.memberId}`),
		);
		if (limited) return limited;

		// Author OR admin may delete an announcement. Authors own their own posts; the WG admin
		// can moderate stale or inappropriate content, e.g. posts of members who moved out.
		const deletion = await withTransaction(async (tx) => {
			await lockExpensePayments(tx, wgId);
			const actor = await lockActiveAccountMember(tx, wgId, auth.member.memberId, auth.authUserId);
			if (!actor) {
				return { ok: false as const, response: unauthorized('member_deactivated') };
			}
			const [row] = await tx
				.select({
					authorMemberId: announcements.authorMemberId,
					imageUrl: announcements.imageUrl,
				})
				.from(announcements)
				.where(and(eq(announcements.id, id), eq(announcements.wgId, wgId)))
				.limit(1)
				.for('update');
			if (!row) return { ok: false as const, response: notFound('announcement_not_found') };
			const denied = await requireOwnerOrAdmin(wgId, auth.member, row.authorMemberId);
			if (denied) return { ok: false as const, response: denied };

			const deleted = await tx
				.delete(announcements)
				.where(and(eq(announcements.id, id), eq(announcements.wgId, wgId)))
				.returning({ id: announcements.id });
			if (deleted.length === 0) {
				return { ok: false as const, response: notFound('announcement_not_found') };
			}
			await revokePrivateImageIfUnreferenced(tx, wgId, row.imageUrl);
			return { ok: true as const };
		});
		if (!deletion.ok) return deletion.response;
		await recordAuditEvent({
			wgId,
			memberId: auth.member.memberId,
			eventType: 'announcement.deleted',
			entityType: 'announcement',
			entityId: id,
			actorName: auth.member.name,
		});
		return NextResponse.json({ deleted: true });
	},
);
