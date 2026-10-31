import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recordAuditEvent } from '@/core/audit';
import { announcementReactions, announcements } from '@/core/db';
import { lockActiveAccountMember } from '@/core/db/account-deletion';
import { withIdempotentReplay } from '@/core/db/with-replay';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { badRequest, rateLimitedReplayResponse } from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { ANNOUNCEMENT_REACTIONS } from '@/features/announcements/announcement-workflow';

const reactionSchema = z.object({
	reaction: z.enum(ANNOUNCEMENT_REACTIONS),
	// The desired state, so a lost response can be retried safely.
	active: z.boolean(),
});

type ReactionEffect = { type: 'added' | 'removed'; reactionId: string };

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
		const outcome = await withIdempotentReplay<ReactionEffect>(
			req,
			scope,
			async (tx) => {
				const limited = rateLimitedReplayResponse(
					await checkRateLimit(wgWriteLimiter, `reaction:${wg.id}:${auth.member.memberId}`),
				);
				if (limited) return { response: limited, effect: null };
				const actor = await lockActiveAccountMember(
					tx,
					wg.id,
					auth.member.memberId,
					auth.authUserId,
				);
				if (!actor) {
					return {
						response: { status: 401, body: { error: 'member_deactivated' } },
						effect: null,
					};
				}

				// Lock the announcement so a take cannot race a concurrent resolve.
				const [announcement] = await tx
					.select({ status: announcements.status })
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

				const wantActive = parsed.data.active;
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
							effect: { type: 'added' as const, reactionId: reaction.id },
						}
					: { response: response(true), effect: null };
			},
			wg.id,
		);
		if (!outcome.effect) {
			return NextResponse.json(outcome.response.body, { status: outcome.response.status });
		}

		// Reactions notify nobody: the author sees them on the board.
		await recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType:
				outcome.effect.type === 'added'
					? 'announcement.reaction.added'
					: 'announcement.reaction.removed',
			entityType: 'announcement_reaction',
			entityId: outcome.effect.reactionId,
			actorName: auth.member.name,
			metadata: { announcementId: id, reaction: parsed.data.reaction },
		});
		return NextResponse.json(outcome.response.body, { status: outcome.response.status });
	},
);
