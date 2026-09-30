import { recordAuditEvent } from '@/core/audit';
import { announcements, chores } from '@/core/db';
import { badRequest } from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { readIdempotencyKey } from '@/core/idempotency';
import { logApiError } from '@/core/infra/observability';
import {
	type NotificationDispatchWarning,
	dispatchNotificationSafely,
} from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { getChoreStatus } from '@/features/chores/chore-status';
import {
	persistAnnouncementReplayWarning,
	withAnnouncementReplay,
} from '@/features/pinnwand/announcement-replay';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

const CONTENT_PREVIEW_MAX = 120;

/**
 * Post a chore swap request to the pinnwand.
 *
 * The public announcements POST can never set `source`/`sourcePath` (a member
 * post is always `manual`, #517), but the Putzplan's "Tausch auf der Pinnwand
 * anfragen" action needs a `chore_swap` post whose deep link names the exact
 * chore, so completing that chore can resolve exactly this announcement
 * (see `chores/[id]/complete`). Keeping that provenance server-generated here
 * is what makes the client's claim unnecessary: the chore must exist in the
 * caller's WG, and the link is built from the path segment, never from the
 * request body.
 */
export const POST = withWgRoute<{ id: string }>(
	'chore swap request POST',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;
		const idempotencyKey = readIdempotencyKey(req);
		if (!idempotencyKey) return badRequest('idempotency_key_required');

		const scope = `chore-swap-request:${wg.id}:${auth.member.memberId}:${id}`;
		const outcome = await withAnnouncementReplay(
			req,
			scope,
			async (tx) => {
				const limited = await checkRateLimit(
					wgWriteLimiter,
					`announcement:${wg.id}:${auth.member.memberId}`,
				);
				if (!limited.success) {
					return {
						response: { status: 429, body: { error: 'too_many_requests' } },
						effect: null,
					};
				}

				const [chore] = await tx
					.select({ id: chores.id, title: chores.title, nextDueAt: chores.nextDueAt })
					.from(chores)
					.where(and(eq(chores.id, id), eq(chores.wgId, wg.id)))
					.limit(1);
				if (!chore) {
					return {
						response: { status: 404, body: { error: 'chore_not_found' } },
						effect: null,
					};
				}

				const sourcePath = `/putzen?highlight=${encodeURIComponent(chore.id)}`;
				const status = getChoreStatus(chore.nextDueAt.toISOString());
				const content = `${auth.member.name} bittet um Tausch: "${chore.title}" ist ${status.label}. Nachholen, übernehmen oder kurz absprechen.`;
				const [item] = await tx
					.insert(announcements)
					.values({
						wgId: wg.id,
						authorMemberId: auth.member.memberId,
						kind: 'request',
						source: 'chore_swap',
						sourcePath,
						content,
					})
					.returning();
				if (!item) throw new Error('announcement_insert_failed');
				return {
					response: {
						status: 200,
						body: { announcement: item, warning: null },
						entityId: item.id,
					},
					effect: item,
				};
			},
			undefined,
			wg.id,
		);
		if (!outcome.effect) {
			return NextResponse.json(outcome.response.body, { status: outcome.response.status });
		}
		const item = outcome.effect;

		void recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'announcement.created',
			entityType: 'announcement',
			entityId: item.id,
			summary: `${auth.member.name} hat eine Tauschanfrage gestellt.`,
			metadata: {
				contentPreview: item.content.slice(0, CONTENT_PREVIEW_MAX),
				kind: 'request',
				source: 'chore_swap',
				choreId: id,
			},
		}).catch(() => undefined);

		let warning: NotificationDispatchWarning = null;
		try {
			const delivery = await dispatchNotificationSafely({
				wg,
				event: 'announcement.posted',
				payload: {
					announcementId: item.id,
					title: item.content.slice(0, CONTENT_PREVIEW_MAX),
					actorName: auth.member.name,
				},
				excludeMemberId: auth.member.memberId,
			});
			warning = delivery.warning;
		} catch (err) {
			logApiError('[chore swap request POST] post-commit notification failed', err);
		}

		if (warning && outcome.key) {
			try {
				if (!(await persistAnnouncementReplayWarning(scope, outcome.key, item.id, warning))) {
					logApiError(
						'[chore swap request POST] replay warning persistence failed',
						new Error('replay_row_missing'),
					);
					warning = null;
				}
			} catch (err) {
				logApiError('[chore swap request POST] replay warning persistence failed', err);
				warning = null;
			}
		}

		return NextResponse.json({ announcement: item, warning });
	},
);
