import { recordAuditEvent } from '@/core/audit';
import { announcements, chores, db } from '@/core/db';
import { badRequest, notFound, tooMany } from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { logApiError } from '@/core/infra/observability';
import {
	type NotificationDispatchWarning,
	dispatchNotificationSafely,
} from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { getChoreStatus } from '@/features/chores/chore-status';
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

		const [chore] = await db
			.select({ id: chores.id, title: chores.title, nextDueAt: chores.nextDueAt })
			.from(chores)
			.where(and(eq(chores.id, id), eq(chores.wgId, wg.id)))
			.limit(1);
		if (!chore) return notFound('chore_not_found');

		const limited = await checkRateLimit(
			wgWriteLimiter,
			`announcement:${wg.id}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();

		const sourcePath = `/putzen?highlight=${encodeURIComponent(chore.id)}`;
		const status = getChoreStatus(chore.nextDueAt.toISOString());
		const content = `${auth.member.name} bittet um Tausch: "${chore.title}" ist ${status.label}. Nachholen, übernehmen oder kurz absprechen.`;

		const [item] = await db
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

		void recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'announcement.created',
			entityType: 'announcement',
			entityId: item.id,
			summary: `${auth.member.name} hat eine Tauschanfrage gestellt.`,
			metadata: {
				contentPreview: content.slice(0, CONTENT_PREVIEW_MAX),
				kind: 'request',
				source: 'chore_swap',
				choreId: chore.id,
			},
		}).catch(() => undefined);

		let warning: NotificationDispatchWarning = null;
		try {
			const delivery = await dispatchNotificationSafely({
				wg,
				event: 'announcement.posted',
				payload: {
					announcementId: item.id,
					title: content.slice(0, CONTENT_PREVIEW_MAX),
					actorName: auth.member.name,
				},
				excludeMemberId: auth.member.memberId,
			});
			warning = delivery.warning;
		} catch (err) {
			logApiError('[chore swap request POST] post-commit notification failed', err);
		}

		return NextResponse.json({ announcement: item, warning });
	},
);
