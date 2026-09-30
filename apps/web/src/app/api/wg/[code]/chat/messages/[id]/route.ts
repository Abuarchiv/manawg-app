import { recordAuditEvent } from '@/core/audit';
import { db, wgChatMessages } from '@/core/db';
import { revokePrivateImageIfUnreferenced } from '@/core/db/private-image-deletions';
import { lockExpensePayments, withTransaction } from '@/core/db/transaction';
import { badRequest, forbidden, notFound, requireVerifiedMember, tooMany } from '@/core/errors';
import { requireOwnerOrAdmin } from '@/core/guards/admin';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { canEditMessage, sanitizeMessageBody } from '@/features/chat/chat-pure';
import { and, eq, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const BODY_MAX = 4000;

const patchSchema = z.object({
	body: z.string().min(1).max(BODY_MAX),
});

export const PATCH = withWgRoute<{ id: string }>(
	'chat message PATCH',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

		let raw: unknown;
		try {
			raw = await req.json();
		} catch {
			return badRequest('invalid_json');
		}
		const parsed = patchSchema.safeParse(raw);
		if (!parsed.success) return badRequest('body_invalid');
		const cleanBody = sanitizeMessageBody(parsed.data.body, BODY_MAX);
		if (!cleanBody) return badRequest('body_invalid');
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;
		// Owner check trusts the caller identity claimed by the spoofable
		// x-manawg-member-id header, so require a verified HMAC token before
		// trusting it (same pattern as comment/expense mutations).
		const unverified = requireVerifiedMember(auth.member);
		if (unverified) return unverified;
		const limited = await checkRateLimit(
			wgWriteLimiter,
			`chat-edit:${wgId}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();

		const existing = await db
			.select()
			.from(wgChatMessages)
			.where(and(eq(wgChatMessages.id, id), eq(wgChatMessages.wgId, wgId)))
			.limit(1);
		const row = existing[0];
		if (!row) return notFound('message_not_found');

		if (!canEditMessage(row, { id: auth.member.memberId })) {
			return forbidden('edit_not_allowed', 'edit_not_allowed');
		}

		const now = new Date();
		const [updated] = await db
			.update(wgChatMessages)
			.set({ body: cleanBody, editedAt: now })
			.where(and(eq(wgChatMessages.id, id), eq(wgChatMessages.wgId, wgId)))
			.returning();
		if (!updated) return notFound('message_not_found');

		void recordAuditEvent({
			wgId,
			memberId: auth.member.memberId,
			eventType: 'chat.message.edited',
			entityType: 'chat_message',
			entityId: id,
			summary: `${auth.member.name} hat eine Chat-Nachricht bearbeitet.`,
			metadata: {
				previewBefore: row.body?.slice(0, 80) ?? null,
				previewAfter: updated.body?.slice(0, 80) ?? null,
			},
		}).catch(() => undefined);

		return NextResponse.json({ message: updated });
	},
);

export const DELETE = withWgRoute<{ id: string }>(
	'chat message DELETE',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;
		// Owner check trusts the caller identity claimed by the spoofable
		// x-manawg-member-id header, so require a verified HMAC token before
		// trusting it (same pattern as comment/expense mutations).
		const unverified = requireVerifiedMember(auth.member);
		if (unverified) return unverified;
		const limited = await checkRateLimit(
			wgWriteLimiter,
			`chat-delete:${wgId}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();

		const deletion = await withTransaction(async (tx) => {
			await lockExpensePayments(tx, wgId);
			const [row] = await tx
				.select({
					senderMemberId: wgChatMessages.senderMemberId,
					deletedAt: wgChatMessages.deletedAt,
					body: wgChatMessages.body,
					kind: wgChatMessages.kind,
					imageUrl: wgChatMessages.imageUrl,
				})
				.from(wgChatMessages)
				.where(and(eq(wgChatMessages.id, id), eq(wgChatMessages.wgId, wgId)))
				.limit(1)
				.for('update');
			if (!row) return { ok: false as const, response: notFound('message_not_found') };
			if (row.deletedAt) return { ok: true as const, deleted: false as const, row };

			// auth.member.verified is already guaranteed by the check above; kept
			// explicit here to match requireOwnerOrAdmin's own isOwner shape.
			const isAuthor = auth.member.verified && row.senderMemberId === auth.member.memberId;
			const denied = isAuthor
				? null
				: await requireOwnerOrAdmin(wgId, auth.member, row.senderMemberId);
			if (denied) return { ok: false as const, response: denied };

			const [updated] = await tx
				.update(wgChatMessages)
				.set({ deletedAt: new Date() })
				.where(
					and(
						eq(wgChatMessages.id, id),
						eq(wgChatMessages.wgId, wgId),
						isNull(wgChatMessages.deletedAt),
					),
				)
				.returning({ id: wgChatMessages.id });
			if (!updated) return { ok: false as const, response: notFound('message_not_found') };
			await revokePrivateImageIfUnreferenced(tx, wgId, row.imageUrl);
			return { ok: true as const, deleted: true as const, row, isAuthor };
		});
		if (!deletion.ok) return deletion.response;
		if (!deletion.deleted) return NextResponse.json({ deleted: true });
		const { row, isAuthor } = deletion;

		void recordAuditEvent({
			wgId,
			memberId: auth.member.memberId,
			eventType: 'chat.message.deleted',
			entityType: 'chat_message',
			entityId: id,
			summary: `${auth.member.name} hat eine Chat-Nachricht gelöscht.`,
			metadata: {
				preview: row.body?.slice(0, 80) ?? null,
				kind: row.kind,
				adminOverride: !isAuthor,
			},
		}).catch(() => undefined);

		return NextResponse.json({ deleted: true });
	},
);
