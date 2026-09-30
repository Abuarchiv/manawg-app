import { postSystemNotice } from '@/core/activity-feed';
import { recordAuditEvent } from '@/core/audit';
import { getAuthenticatedUser } from '@/core/auth/server';
import { db, wgMembers, wgs } from '@/core/db';
import { assertAccountCanAcquireMembership } from '@/core/db/account-deletion';
import { LIMITS } from '@/core/db/schema';
import { TransactionAbort, withTransaction } from '@/core/db/transaction';
import { HTTP, apiError, badRequest, forbidden, notFound, tooMany } from '@/core/errors';
import { isVerifiedWgAdmin } from '@/core/guards/admin';
import { withIdempotentJsonResponse } from '@/core/guards/idempotency';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { shareCodeMissResponse } from '@/core/guards/share-code-miss';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { logApiError } from '@/core/infra/observability';
import { checkRateLimit, clientIpKey, wgWriteLimiter } from '@/core/rate-limit';
import { and, asc, count, eq } from 'drizzle-orm';
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

export const GET = withWgRoute(
	'members GET',
	async (req, { code }) => {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;

		// Display-only listing for every member of the WG, including deactivated
		// ("moved-out") ones — they still need to resolve names/balances in
		// history, and choice UIs (identity picker, split/payer dropdowns, chore
		// rotation) filter on the `active` flag instead of the server dropping
		// rows here. Deliberately never includes a token field — a member's
		// session token must only ever be returned to that member themselves
		// (see POST below and GET /api/wg/[code] currentMember), never to other
		// joined members who could otherwise use it to impersonate them on
		// admin-gated routes.
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
		// admin-delete) — every actual mutation re-checks isVerifiedWgAdmin
		// server-side, so a stale/spoofed value here can't grant real access.
		const viewerIsAdmin = await isVerifiedWgAdmin(wgId, auth.member.memberId, auth.member.verified);

		return NextResponse.json({
			members,
			viewerIsAdmin,
			pagination: { total: totalRows[0]?.total ?? 0, limit, offset },
		});
	},
	{
		fixture: (fixture) => {
			return NextResponse.json({ members: fixture.members });
		},
	},
);

function isPostBody(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const joinMemberSchema = z.object({
	name: z.string().trim().min(1).max(LIMITS.NAME_MAX),
	color: z.string().trim().max(16).nullish(),
});

function isUniqueMemberNameViolation(err: unknown): boolean {
	if (!err || typeof err !== 'object' || !('code' in err)) return false;
	if ((err as { code?: unknown }).code !== '23505') return false;
	const constraint = (err as { constraint?: unknown }).constraint;
	return constraint === undefined || constraint === 'wg_members_unique_name_per_wg';
}

export const POST = withWgRoute('members POST', async (req, { code }) => {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}
	if (!isPostBody(raw)) return badRequest('invalid_body');
	const parsed = joinMemberSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.flatten();
		if (issues.fieldErrors.name) return badRequest('name_invalid');
		return badRequest('invalid_body');
	}
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
		return apiError('db_error', 503);
	}
	if (!authUser) return apiError('auth_required', 401, 'auth_required');
	const user = authUser;
	const wg = await db.query.wgs.findFirst({
		where: (w, { eq }) => eq(w.shareCode, code),
		columns: { id: true, joiningEnabled: true },
	});
	if (!wg) return shareCodeMissResponse(user.id, notFound('wg_not_found'));
	const authenticatedUser = user;

	try {
		return await withIdempotentJsonResponse(
			req,
			`wg-join:${wg.id}:${authenticatedUser.id}`,
			async () => {
				// The share code is the invite key. Cap the per-WG member count and keep
				// names unique so a leaked code cannot flood the WG indefinitely. Count
				// check and insert run in one transaction behind a row lock on the WG —
				// two concurrent joins would otherwise both pass the cap check (TOCTOU).
				const joinResult = await withTransaction(
					async (
						tx,
					): Promise<
						| { ok: true; member: typeof wgMembers.$inferSelect }
						| {
								ok: false;
								reason:
									| 'limit'
									| 'name_taken'
									| 'already_joined'
									| 'not_found'
									| 'joining_disabled';
						  }
					> => {
						await assertAccountCanAcquireMembership(tx, authenticatedUser.id);
						// Same `select ... for update` row lock as before, expressed with
						// the query builder like every other read in this file: schema
						// column names and types instead of hand-aliased raw SQL that a
						// later edit could copy without the parameterization.
						const [lockedWg] = await tx
							.select({ shareCode: wgs.shareCode, joiningEnabled: wgs.joiningEnabled })
							.from(wgs)
							.where(eq(wgs.id, wg.id))
							.for('update');
						if (!lockedWg || lockedWg.shareCode !== code) return { ok: false, reason: 'not_found' };
						const existingForUser = await tx
							.select({ id: wgMembers.id })
							.from(wgMembers)
							.where(and(eq(wgMembers.wgId, wg.id), eq(wgMembers.authUserId, user.id)))
							.limit(1);
						if (existingForUser.length > 0) return { ok: false, reason: 'already_joined' };
						if (!lockedWg.joiningEnabled) return { ok: false, reason: 'joining_disabled' };
						const memberCount = await tx
							.select({ id: wgMembers.id })
							.from(wgMembers)
							.where(eq(wgMembers.wgId, wg.id));
						if (memberCount.length >= MAX_MEMBERS_PER_WG) {
							return { ok: false, reason: 'limit' };
						}

						const existing = await tx
							.select({ id: wgMembers.id, name: wgMembers.name, color: wgMembers.color })
							.from(wgMembers)
							.where(and(eq(wgMembers.wgId, wg.id), eq(wgMembers.name, name)))
							.limit(1);
						if (existing.length > 0) {
							return { ok: false, reason: 'name_taken' };
						}
						let inserted: typeof wgMembers.$inferSelect | undefined;
						try {
							[inserted] = await tx
								.insert(wgMembers)
								.values({ wgId: wg.id, name, color, role: 'member', authUserId: user.id })
								.onConflictDoNothing({ target: [wgMembers.wgId, wgMembers.name] })
								.returning();
						} catch (insertErr) {
							if (isUniqueMemberNameViolation(insertErr)) {
								return { ok: false, reason: 'name_taken' };
							}
							throw insertErr;
						}
						if (!inserted) return { ok: false, reason: 'name_taken' };
						return { ok: true, member: inserted };
					},
				);
				if (!joinResult.ok) {
					if (joinResult.reason === 'not_found') return notFound('wg_not_found');
					if (joinResult.reason === 'joining_disabled') {
						return forbidden('joining_disabled', 'joining_disabled');
					}
					if (joinResult.reason === 'limit') {
						return apiError('member_limit_reached', HTTP.CONFLICT, 'member_limit_reached');
					}
					if (joinResult.reason === 'already_joined') {
						return apiError('already_joined', HTTP.CONFLICT, 'already_joined');
					}
					return apiError('name_taken', HTTP.CONFLICT, 'name_taken');
				}
				const member = joinResult.member;
				await recordAuditEvent({
					wgId: wg.id,
					memberId: member.id,
					eventType: 'member.joined',
					entityType: 'member',
					entityId: member.id,
					summary: `${member.name} ist der WG beigetreten.`,
					metadata: { name: member.name },
				});
				await postSystemNotice({
					wgId: wg.id,
					authorMemberId: member.id,
					kind: 'info',
					source: 'system',
					sourcePath: '/',
					content: `${member.name} ist der WG beigetreten.`,
				});
				return NextResponse.json({ member });
			},
			async () => {
				try {
					await withTransaction((tx) =>
						assertAccountCanAcquireMembership(tx, authenticatedUser.id),
					);
					return null;
				} catch (err) {
					if (err instanceof TransactionAbort && err.code === 'account_deletion_pending') {
						return apiError('account_deletion_pending', HTTP.CONFLICT, 'account_deletion_pending');
					}
					throw err;
				}
			},
		);
	} catch (err) {
		if (err instanceof TransactionAbort && err.code === 'account_deletion_pending') {
			return apiError('account_deletion_pending', HTTP.CONFLICT, 'account_deletion_pending');
		}
		throw err;
	}
});
