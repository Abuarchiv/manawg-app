import { db, wgChatMessages, wgChatReads } from '@/core/db';
import { badRequest, notFound, tooMany } from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { chatReadLimiter, checkRateLimit } from '@/core/rate-limit';
import { buildChatReadMarkerSetWhere } from '@/features/chat/chat-read-query';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const postSchema = z.object({
	lastReadMessageId: z.string().uuid().nullable(),
});

export const POST = withWgRoute('chat read POST', async (req, { code }) => {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}
	const parsed = postSchema.safeParse(raw);
	if (!parsed.success) return badRequest('body_invalid');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;

	const limited = await checkRateLimit(
		chatReadLimiter,
		`chat-read:${wgId}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	const messageId = parsed.data.lastReadMessageId;
	if (messageId) {
		if (!UUID_PATTERN.test(messageId)) return badRequest('message_id_invalid');
		const messageRows = await db
			.select({ id: wgChatMessages.id })
			.from(wgChatMessages)
			.where(and(eq(wgChatMessages.id, messageId), eq(wgChatMessages.wgId, wgId)))
			.limit(1);
		if (!messageRows[0]) return notFound('message_not_found');
	}

	// A null marker (a "reset my read marker" request, reachable once the
	// referenced message row was deleted and the FK nulled) cannot ride the
	// guarded upsert: its `setWhere` starts with `candidate is not null`, so
	// `onConflictDoUpdate` would match zero rows while the response claimed
	// success. Reset and advance are therefore separate statements, and
	// `applied` reports whether either one actually changed stored state.
	let applied: boolean;
	if (messageId === null) {
		const deleted = await db
			.delete(wgChatReads)
			.where(and(eq(wgChatReads.wgId, wgId), eq(wgChatReads.memberId, auth.member.memberId)))
			.returning({ memberId: wgChatReads.memberId });
		applied = deleted.length > 0;
	} else {
		const updated = await db
			.insert(wgChatReads)
			.values({
				wgId,
				memberId: auth.member.memberId,
				lastReadMessageId: messageId,
			})
			.onConflictDoUpdate({
				target: [wgChatReads.wgId, wgChatReads.memberId],
				set: { lastReadMessageId: messageId, updatedAt: new Date() },
				setWhere: buildChatReadMarkerSetWhere(messageId, wgChatReads.lastReadMessageId),
			})
			.returning({ memberId: wgChatReads.memberId });
		// Zero rows means the stored marker is already newer — the request is
		// still fine, but nothing changed and the caller must not hear "saved".
		applied = updated.length > 0;
	}

	return NextResponse.json({ ok: true, applied });
});
