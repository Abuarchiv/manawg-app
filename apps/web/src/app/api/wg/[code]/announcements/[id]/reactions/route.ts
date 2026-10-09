import { recordAuditEvent } from '@/core/audit';
import { announcementReactions, announcements } from '@/core/db';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { badRequest } from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import { logApiError } from '@/core/infra/observability';
import {
	type NotificationDispatchWarning,
	dispatchNotificationSafely,
} from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { ANNOUNCEMENT_REACTIONS } from '@/features/pinnwand/announcement-workflow';
import {
	persistAnnouncementReplayWarning,
	withAnnouncementReplay,
} from '@/features/pinnwand/server/announcement-replay';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const reactionSchema = z.object({
	reaction: z.enum(ANNOUNCEMENT_REACTIONS),
	// New clients send the desired state so a lost response can be retried
	// safely. Omitting it preserves the legacy toggle contract.
	active: z.boolean().optional(),
});

type ReactionEffect =
	| { type: 'removed'; reactionId: string }
	| {
			type: 'added';
			reactionId: string;
			authorMemberId: string;
			announcementContent: string;
	  };

export const POST = withWgRoute<{ id: string }>(
	'announcement reaction POST',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

		const parsed = await parseBody(req, reactionSchema, {
			invalid: 'reaction_invalid',
		});
		if (!parsed.ok) return parsed.response;
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;
		const scope = `announcement-reaction:${wg.id}:${auth.member.memberId}:${id}:${parsed.data.reaction}`;
		const outcome = await withAnnouncementReplay<ReactionEffect>(req, scope, async (tx) => {
			const limited = await checkRateLimit(
				wgWriteLimiter,
				`reaction:${wg.id}:${auth.member.memberId}`,
			);
			if (!limited.success) {
				return { response: { status: 429, body: { error: 'too_many_requests' } }, effect: null };
			}

			// Lock the announcement while resolving a legacy toggle, so distinct
			// idempotency keys cannot both read the same old reaction state.
			const [announcement] = await tx
				.select({
					id: announcements.id,
					authorMemberId: announcements.authorMemberId,
					content: announcements.content,
					status: announcements.status,
				})
				.from(announcements)
				.where(and(eq(announcements.id, id), eq(announcements.wgId, wg.id)))
				.limit(1)
				.for('update');
			if (!announcement) {
				return {
					response: { status: 404, body: { error: 'announcement_not_found' } },
					effect: null,
				};
			}

			const existingReaction = await tx
				.select({ id: announcementReactions.id })
				.from(announcementReactions)
				.where(
					and(
						eq(announcementReactions.announcementId, id),
						eq(announcementReactions.memberId, auth.member.memberId),
						eq(announcementReactions.reaction, parsed.data.reaction),
					),
				)
				.limit(1);
			const wantActive = parsed.data.active ?? !existingReaction[0];
			if (wantActive && parsed.data.reaction === 'take' && announcement.status === 'resolved') {
				return {
					response: { status: 409, body: { error: 'announcement_resolved' } },
					effect: null,
				};
			}
			const response = (active: boolean) => ({
				status: 200,
				body: { reaction: parsed.data.reaction, active, warning: null },
			});

			if (!wantActive) {
				const [deleted] = await tx
					.delete(announcementReactions)
					.where(
						and(
							eq(announcementReactions.announcementId, id),
							eq(announcementReactions.memberId, auth.member.memberId),
							eq(announcementReactions.reaction, parsed.data.reaction),
						),
					)
					.returning({ id: announcementReactions.id });
				return deleted
					? {
							response: { ...response(false), entityId: deleted.id },
							effect: { type: 'removed' as const, reactionId: deleted.id },
						}
					: { response: response(false), effect: null };
			}

			const [reaction] = await tx
				.insert(announcementReactions)
				.values({
					announcementId: id,
					memberId: auth.member.memberId,
					reaction: parsed.data.reaction,
				})
				.onConflictDoNothing()
				.returning({ id: announcementReactions.id });
			return reaction
				? {
						response: { ...response(true), entityId: reaction.id },
						effect: {
							type: 'added' as const,
							reactionId: reaction.id,
							authorMemberId: announcement.authorMemberId,
							announcementContent: announcement.content,
						},
					}
				: { response: response(true), effect: null };
		});
		if (!outcome.effect) {
			return NextResponse.json(outcome.response.body, { status: outcome.response.status });
		}

		const effect = outcome.effect;
		if (effect.type === 'removed') {
			await recordAuditEvent({
				wgId: wg.id,
				memberId: auth.member.memberId,
				eventType: 'announcement.reaction.removed',
				entityType: 'announcement_reaction',
				entityId: effect.reactionId,
				summary: `${auth.member.name} hat eine Reaktion entfernt.`,
				metadata: { announcementId: id, reaction: parsed.data.reaction },
			});
			return NextResponse.json(outcome.response.body, { status: outcome.response.status });
		}

		await recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'announcement.reaction.added',
			entityType: 'announcement_reaction',
			entityId: effect.reactionId,
			summary: `${auth.member.name} hat mit ${parsed.data.reaction} reagiert.`,
			metadata: { announcementId: id, reaction: parsed.data.reaction },
		});
		let warning: NotificationDispatchWarning = null;
		if (effect.authorMemberId !== auth.member.memberId) {
			try {
				const delivery = await dispatchNotificationSafely({
					wg,
					event: 'announcement.reacted',
					payload: {
						announcementId: id,
						title: effect.announcementContent.slice(0, 120),
						actorName: auth.member.name,
					},
					targetMemberIds: [effect.authorMemberId],
					excludeMemberId: auth.member.memberId,
				});
				warning = delivery.warning;
			} catch (err) {
				logApiError('[announcement/reactions] post-commit notification failed', err);
			}
		}
		if (warning && outcome.key) {
			try {
				if (
					!(await persistAnnouncementReplayWarning(scope, outcome.key, effect.reactionId, warning))
				) {
					logApiError(
						'[announcement/reactions] replay warning persistence failed',
						new Error('replay_row_missing'),
					);
					warning = null;
				}
			} catch (err) {
				logApiError('[announcement/reactions] replay warning persistence failed', err);
				warning = null;
			}
		}
		return NextResponse.json({
			...(outcome.response.body as { reaction: string; active: boolean }),
			warning,
		});
	},
);
