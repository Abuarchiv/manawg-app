import { recordAuditEvent } from '@/core/audit';
import {
	announcementComments,
	announcementReactions,
	announcements,
	db,
	wgMembers,
} from '@/core/db';
import { badRequest, notFound } from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { readJsonLimited } from '@/core/http/read-json';
import { logApiError } from '@/core/infra/observability';
import {
	type NotificationDispatchWarning,
	dispatchNotificationSafely,
} from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import {
	persistAnnouncementReplayWarning,
	withAnnouncementReplay,
} from '@/features/pinnwand/announcement-replay';
import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const COMMENT_MAX = 600;
const COMMENTS_LIST_LIMIT = 500;

const commentSchema = z.object({
	content: z.string().trim().min(1).max(COMMENT_MAX),
});

export const GET = withWgRoute<{ id: string }>(
	'announcement comments GET',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;

		const existingAnnouncement = await db
			.select({ id: announcements.id })
			.from(announcements)
			.where(and(eq(announcements.id, id), eq(announcements.wgId, wgId)))
			.limit(1);
		if (!existingAnnouncement[0]) return notFound('announcement_not_found');

		const comments = await db
			.select({
				id: announcementComments.id,
				announcementId: announcementComments.announcementId,
				memberId: announcementComments.memberId,
				content: announcementComments.content,
				createdAt: announcementComments.createdAt,
				authorName: wgMembers.name,
				authorColor: wgMembers.color,
			})
			.from(announcementComments)
			.innerJoin(wgMembers, eq(announcementComments.memberId, wgMembers.id))
			.where(eq(announcementComments.announcementId, id))
			.orderBy(asc(announcementComments.createdAt))
			.limit(COMMENTS_LIST_LIMIT);

		return NextResponse.json({ comments });
	},
	{
		fixture: () => {
			return NextResponse.json({ comments: [] });
		},
	},
);

export const POST = withWgRoute<{ id: string }>(
	'announcement comments POST',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

		let raw: unknown;
		try {
			raw = await readJsonLimited(req);
		} catch {
			return badRequest('invalid_json');
		}
		const parsed = commentSchema.safeParse(raw);
		if (!parsed.success) return badRequest('comment_invalid');
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;
		const scope = `announcement-comment:${wg.id}:${auth.member.memberId}:${id}`;
		const outcome = await withAnnouncementReplay(req, scope, async (tx) => {
			const limited = await checkRateLimit(
				wgWriteLimiter,
				`comment:${wg.id}:${auth.member.memberId}`,
			);
			if (!limited.success) {
				return { response: { status: 429, body: { error: 'too_many_requests' } }, effect: null };
			}

			const [announcement] = await tx
				.select({ id: announcements.id, authorMemberId: announcements.authorMemberId })
				.from(announcements)
				.where(and(eq(announcements.id, id), eq(announcements.wgId, wg.id)))
				.limit(1)
				// Held until commit: a concurrent DELETE would otherwise slip in between
				// this check and the insert and turn the FK violation into a 500.
				.for('share');
			if (!announcement) {
				return {
					response: { status: 404, body: { error: 'announcement_not_found' } },
					effect: null,
				};
			}

			const [comment] = await tx
				.insert(announcementComments)
				.values({
					announcementId: id,
					memberId: auth.member.memberId,
					content: parsed.data.content,
				})
				.returning();
			if (!comment) throw new Error('announcement_comment_insert_failed');

			const body = {
				comment: {
					...comment,
					authorName: auth.member.name,
					authorColor:
						'color' in auth.member && typeof auth.member.color === 'string'
							? auth.member.color
							: null,
				},
				warning: null,
			};
			return {
				response: { status: 200, body, entityId: comment.id },
				effect: { comment, authorMemberId: announcement.authorMemberId },
			};
		});
		if (!outcome.effect) {
			return NextResponse.json(outcome.response.body, { status: outcome.response.status });
		}

		const { comment, authorMemberId } = outcome.effect;
		void recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'announcement.comment.created',
			entityType: 'announcement_comment',
			entityId: comment.id,
			summary: `${auth.member.name} hat einen Kommentar geschrieben.`,
			metadata: {
				announcementId: id,
				contentPreview: parsed.data.content.slice(0, 120),
			},
		}).catch(() => undefined);

		let warning: NotificationDispatchWarning = null;
		try {
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
				new Set([authorMemberId, ...takers.map((taker) => taker.memberId)]),
			);
			if (targetMemberIds.length > 0) {
				const delivery = await dispatchNotificationSafely({
					wg,
					event: 'announcement.commented',
					payload: {
						announcementId: id,
						title: parsed.data.content.slice(0, 120),
						actorName: auth.member.name,
					},
					targetMemberIds,
					excludeMemberId: auth.member.memberId,
				});
				warning = delivery.warning;
			}
		} catch (err) {
			logApiError('[announcement/comments] post-commit notification failed', err);
		}

		if (warning && outcome.key) {
			try {
				if (!(await persistAnnouncementReplayWarning(scope, outcome.key, comment.id, warning))) {
					logApiError(
						'[announcement/comments] replay warning persistence failed',
						new Error('replay_row_missing'),
					);
					warning = null;
				}
			} catch (err) {
				logApiError('[announcement/comments] replay warning persistence failed', err);
				warning = null;
			}
		}
		return NextResponse.json({ ...(outcome.response.body as { comment: unknown }), warning });
	},
);
