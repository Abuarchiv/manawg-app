import { recordAuditEvent } from '@/core/audit';
import { announcementReactions, announcements, db } from '@/core/db';
import { revokePrivateImageIfUnreferenced } from '@/core/db/private-image-deletions';
import { lockExpensePayments, withTransaction } from '@/core/db/transaction';
import { badRequest, forbidden, notFound, tooMany } from '@/core/errors';
import { isVerifiedWgAdmin, requireOwnerOrAdmin } from '@/core/guards/admin';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import {
	type NotificationDispatchWarning,
	dispatchNotificationSafely,
} from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { ANNOUNCEMENT_KINDS } from '@/features/pinnwand/announcement-workflow';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const patchAnnouncementSchema = z.object({
	status: z.enum(['open', 'resolved']).optional(),
	pinned: z.boolean().optional(),
	kind: z.enum(ANNOUNCEMENT_KINDS).optional(),
});

export const PATCH = withWgRoute<{ id: string }>(
	'announcement PATCH',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

		let raw: unknown;
		try {
			raw = await req.json();
		} catch {
			return badRequest('invalid_json');
		}
		const parsed = patchAnnouncementSchema.safeParse(raw);
		if (!parsed.success) {
			const { fieldErrors } = parsed.error.flatten();
			if (fieldErrors.status) return badRequest('status_invalid');
			if (fieldErrors.pinned) return badRequest('pinned_invalid');
			if (fieldErrors.kind) return badRequest('kind_invalid');
			return badRequest('invalid_body');
		}
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;
		const limited = await checkRateLimit(
			wgWriteLimiter,
			`announcement-patch:${wg.id}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();

		const existing = await db
			.select({
				id: announcements.id,
				authorMemberId: announcements.authorMemberId,
				content: announcements.content,
			})
			.from(announcements)
			.where(and(eq(announcements.id, id), eq(announcements.wgId, wg.id)))
			.limit(1);
		const row = existing[0];
		if (!row) return notFound('announcement_not_found');

		const changesModeratedFields =
			parsed.data.kind !== undefined || parsed.data.pinned !== undefined;
		// A bare x-manawg-member-id is spoofable, so self-authorship only counts
		// when the request carries a verified HMAC token.
		const isAuthor = auth.member.verified && row.authorMemberId === auth.member.memberId;
		if (
			changesModeratedFields &&
			!isAuthor &&
			!(await isVerifiedWgAdmin(wg.id, auth.member.memberId, auth.member.verified))
		) {
			return forbidden('not_owner', 'not_owner');
		}

		const now = new Date();
		const patch: {
			kind?: string;
			pinnedAt?: Date | null;
			status?: string;
			resolvedAt?: Date | null;
			resolvedByMemberId?: string | null;
			updatedAt?: Date;
		} = {};
		patch.updatedAt = now;
		if (parsed.data.kind) patch.kind = parsed.data.kind;
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
			if (!isAuthor && hasTaken.length === 0) {
				return forbidden('status_change_not_allowed', 'status_change_not_allowed');
			}
			patch.status = parsed.data.status;
			patch.resolvedAt = parsed.data.status === 'resolved' ? now : null;
			patch.resolvedByMemberId = parsed.data.status === 'resolved' ? auth.member.memberId : null;
		}

		const [updated] = await db
			.update(announcements)
			.set(patch)
			.where(and(eq(announcements.id, id), eq(announcements.wgId, wg.id)))
			.returning();
		if (!updated) return notFound('announcement_not_found');
		await recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'announcement.updated',
			entityType: 'announcement',
			entityId: updated.id,
			summary: `${auth.member.name} hat einen Pinnwand-Beitrag aktualisiert.`,
			metadata: {
				status: updated.status,
				kind: updated.kind,
				pinned: updated.pinnedAt !== null,
			},
		});
		let warning: NotificationDispatchWarning = null;
		if (parsed.data.status === 'resolved') {
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
					title: row.content.slice(0, 120),
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
		const limited = await checkRateLimit(
			wgWriteLimiter,
			`announcement-delete:${wgId}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();

		// Author OR admin may delete an announcement. Authors own their own posts;
		// the WG admin gets an override so they can moderate
		// stale or inappropriate content when the author is unreachable.
		// Previously this was author-only, which left the WG with no way to
		// clean up posts from departed members (P1 audit finding).
		const deletion = await withTransaction(async (tx) => {
			await lockExpensePayments(tx, wgId);
			const [row] = await tx
				.select({
					authorMemberId: announcements.authorMemberId,
					content: announcements.content,
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
			return { ok: true as const, row };
		});
		if (!deletion.ok) return deletion.response;
		const { row } = deletion;
		await recordAuditEvent({
			wgId,
			memberId: auth.member.memberId,
			eventType: 'announcement.deleted',
			entityType: 'announcement',
			entityId: id,
			summary: `${auth.member.name} hat einen Pinnwand-Beitrag entfernt.`,
			metadata: { content: row.content.slice(0, 160) },
		});
		return NextResponse.json({ deleted: true });
	},
);
