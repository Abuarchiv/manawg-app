import { recordAuditEvent } from '@/core/audit';
import { getAuthenticatedUser } from '@/core/auth/server';
import { db, wgMembers, wgs } from '@/core/db';
import { assertAccountCanAcquireMembership } from '@/core/db/account-deletion';
import { type WriteOutcome, responseCodec, withIdempotentWrite } from '@/core/db/idempotent-write';
import { LIMITS } from '@/core/db/schema';
import { type DbTransaction, TransactionAbort, withTransaction } from '@/core/db/transaction';
import { isWgAdmin } from '@/core/guards/admin';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { shareCodeMissResponse } from '@/core/guards/share-code-miss';
import { withWgRoute } from '@/core/guards/with-wg-route';
import {
	HTTP,
	conflict,
	forbidden,
	notFound,
	serviceUnavailable,
	tooMany,
	unauthorized,
} from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import { readIdempotencyKey } from '@/core/idempotency-store';
import { logApiError } from '@/core/infra/observability';
import { checkRateLimit, clientIpKey, wgWriteLimiter } from '@/core/rate-limit';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const MAX_MEMBERS_PER_WG = 20;
// GET pagination: WG member counts are small, but the listing must never
// degenerate into an unbounded SELECT. Default high enough that existing
// clients keep receiving the full roster; explicit limit/offset enables
// paging for WGs that predate the join cap.
const MEMBERS_PAGE_LIMIT_DEFAULT = 100;
const MEMBERS_PAGE_LIMIT_MAX = 500;

function readPageParams(req: NextRequest): { limit: number; offset: number } {
	const params = req.nextUrl.searchParams;
	const rawLimit = Number.parseInt(params.get('limit') ?? '', 10);
	const rawOffset = Number.parseInt(params.get('offset') ?? '', 10);
	const limit = Number.isFinite(rawLimit)
		? Math.min(Math.max(rawLimit, 1), MEMBERS_PAGE_LIMIT_MAX)
		: MEMBERS_PAGE_LIMIT_DEFAULT;
	const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
	return { limit, offset };
}

export const GET = withWgRoute('members GET', async (req, { code }) => {
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;

	// Display-only listing for every member of the WG, including deactivated
	// ("moved-out") ones — they still need to resolve names/balances in
	// history, and choice UIs (identity picker, split/payer dropdowns, chore
	// rotation) filter on the `active` flag instead of the server dropping
	// rows here.
	const { limit, offset } = readPageParams(req);
	const [rows, totalRows] = await Promise.all([
		db
			.select({
				id: wgMembers.id,
				name: wgMembers.name,
				color: wgMembers.color,
				paypalMerchantId: wgMembers.paypalMerchantId,
				deactivatedAt: wgMembers.deactivatedAt,
			})
			.from(wgMembers)
			.where(eq(wgMembers.wgId, wgId))
			.orderBy(asc(wgMembers.createdAt), asc(wgMembers.id))
			.limit(limit)
			.offset(offset),
		db.select({ total: count() }).from(wgMembers).where(eq(wgMembers.wgId, wgId)),
	]);

	const members = rows.map(({ deactivatedAt, ...member }) => ({
		...member,
		active: deactivatedAt === null,
	}));
	// Client-side UI gating only (deactivate/reactivate buttons, chat
	// admin-delete) — every actual mutation re-checks the admin role
	// server-side, so a stale value here can't grant real access.
	const viewerIsAdmin = await isWgAdmin(wgId, auth.member.memberId);

	return NextResponse.json({
		members,
		viewerIsAdmin,
		pagination: { total: totalRows[0]?.total ?? 0, limit, offset },
	});
});

const joinMemberSchema = z.object({
	name: z.string().trim().min(1).max(LIMITS.NAME_MAX),
	color: z.string().trim().max(16).nullish(),
});

type JoinRejection =
	| 'limit'
	| 'name_taken'
	| 'already_joined'
	| 'member_deactivated'
	| 'not_found'
	| 'joining_disabled';

const joinCodec = responseCodec();

function isUniqueMemberNameViolation(err: unknown): boolean {
	if (!err || typeof err !== 'object' || !('code' in err)) return false;
	if ((err as { code?: unknown }).code !== '23505') return false;
	const constraint = (err as { constraint?: unknown }).constraint;
	return constraint === undefined || constraint === 'wg_members_unique_name_per_wg';
}

function joinRejectionResponse(reason: JoinRejection): NextResponse {
	if (reason === 'not_found') return notFound('wg_not_found');
	if (reason === 'joining_disabled') return forbidden('joining_disabled', 'joining_disabled');
	if (reason === 'limit') return conflict('member_limit_reached', 'member_limit_reached');
	if (reason === 'member_deactivated') return forbidden('member_deactivated', 'member_deactivated');
	if (reason === 'already_joined') return conflict('already_joined', 'already_joined');
	return conflict('name_taken', 'name_taken');
}

/**
 * The share code is the invite key. The per-WG member cap and unique names keep a leaked code
 * from flooding the WG; count check and insert run behind a row lock on the WG, because two
 * concurrent joins would otherwise both pass the cap check.
 */
async function insertJoiningMember(
	tx: DbTransaction,
	input: { wgId: string; code: string; authUserId: string; name: string; color: string | null },
): Promise<
	WriteOutcome<unknown, { member: typeof wgMembers.$inferSelect } | { reason: JoinRejection }>
> {
	const reject = (reason: JoinRejection) => ({
		status: HTTP.CONFLICT,
		body: null,
		context: { reason },
	});
	await assertAccountCanAcquireMembership(tx, input.authUserId);
	const [lockedWg] = await tx
		.select({ shareCode: wgs.shareCode, joiningEnabled: wgs.joiningEnabled })
		.from(wgs)
		.where(eq(wgs.id, input.wgId))
		.for('update');
	if (!lockedWg || lockedWg.shareCode !== input.code) return reject('not_found');
	const existingForUser = await tx
		.select({ id: wgMembers.id, deactivatedAt: wgMembers.deactivatedAt })
		.from(wgMembers)
		.where(and(eq(wgMembers.wgId, input.wgId), eq(wgMembers.authUserId, input.authUserId)))
		.limit(1);
	// A moved-out member must not be sent into the WG (it would bounce them back to the
	// picker); an admin has to reactivate them.
	if (existingForUser[0]?.deactivatedAt) return reject('member_deactivated');
	if (existingForUser.length > 0) return reject('already_joined');
	if (!lockedWg.joiningEnabled) return reject('joining_disabled');
	const memberCount = await tx
		.select({ id: wgMembers.id })
		.from(wgMembers)
		.where(eq(wgMembers.wgId, input.wgId));
	if (memberCount.length >= MAX_MEMBERS_PER_WG) return reject('limit');

	const existing = await tx
		.select({ id: wgMembers.id, name: wgMembers.name, color: wgMembers.color })
		.from(wgMembers)
		// Case-insensitive: "anna" next to "Anna" could not be told apart in chat and balances.
		// The unique index stays exact and only catches the race.
		.where(
			and(eq(wgMembers.wgId, input.wgId), sql`lower(${wgMembers.name}) = lower(${input.name})`),
		)
		.limit(1);
	if (existing.length > 0) return reject('name_taken');
	let inserted: typeof wgMembers.$inferSelect | undefined;
	try {
		// A savepoint keeps the transaction usable when the unique index catches a race.
		[inserted] = await tx.transaction((savepoint) =>
			savepoint
				.insert(wgMembers)
				.values({
					wgId: input.wgId,
					name: input.name,
					color: input.color,
					role: 'member',
					authUserId: input.authUserId,
				})
				.onConflictDoNothing({ target: [wgMembers.wgId, wgMembers.name] })
				.returning(),
		);
	} catch (insertErr) {
		if (isUniqueMemberNameViolation(insertErr)) return reject('name_taken');
		throw insertErr;
	}
	if (!inserted) return reject('name_taken');
	return { status: 200, body: { member: inserted }, context: { member: inserted } };
}

async function accountDeletionReplayResponse(authUserId: string): Promise<NextResponse | null> {
	try {
		await withTransaction((tx) => assertAccountCanAcquireMembership(tx, authUserId));
		return null;
	} catch (err) {
		if (err instanceof TransactionAbort && err.code === 'account_deletion_pending') {
			return conflict('account_deletion_pending', 'account_deletion_pending');
		}
		throw err;
	}
}

export const POST = withWgRoute('members POST', async (req, { code }) => {
	const parsed = await parseBody(req, joinMemberSchema, { fieldErrors: { name: 'name_invalid' } });
	if (!parsed.ok) return parsed.response;
	const { name } = parsed.data;
	const color = parsed.data.color ?? null;
	const limit = await checkRateLimit(wgWriteLimiter, `join:${clientIpKey(req)}`);
	if (!limit.success) {
		return tooMany('join_rate_limited', 'join_rate_limited');
	}
	let authUser: Awaited<ReturnType<typeof getAuthenticatedUser>>;
	try {
		authUser = await getAuthenticatedUser(req);
	} catch (err) {
		// A transient Auth outage is retryable, not an unauthenticated caller.
		logApiError('[members POST] auth error', err);
		return serviceUnavailable('db_error');
	}
	if (!authUser) return unauthorized('auth_required', 'auth_required');
	const user = authUser;
	const wg = await db.query.wgs.findFirst({
		where: (w, { eq }) => eq(w.shareCode, code),
		columns: { id: true, joiningEnabled: true },
	});
	if (!wg) return shareCodeMissResponse(user.id, notFound('wg_not_found'));

	try {
		const result = await withIdempotentWrite(
			{
				scope: `wg-join:${wg.id}:${user.id}`,
				key: readIdempotencyKey(req),
				codec: joinCodec,
				beforeReplay: () => accountDeletionReplayResponse(user.id),
			},
			(tx) => insertJoiningMember(tx, { wgId: wg.id, code, authUserId: user.id, name, color }),
		);
		if (result.kind === 'stopped') return result.response;
		if (result.kind === 'replayed' || !result.context) {
			return NextResponse.json(result.body, { status: result.status });
		}
		if ('reason' in result.context) return joinRejectionResponse(result.context.reason);
		const { member } = result.context;
		await recordAuditEvent({
			wgId: wg.id,
			memberId: member.id,
			eventType: 'member.joined',
			entityType: 'member',
			entityId: member.id,
			summary: `${member.name} ist der WG beigetreten.`,
			metadata: { name: member.name },
		});
		return NextResponse.json({ member });
	} catch (err) {
		if (err instanceof TransactionAbort && err.code === 'account_deletion_pending') {
			return conflict('account_deletion_pending', 'account_deletion_pending');
		}
		throw err;
	}
});
