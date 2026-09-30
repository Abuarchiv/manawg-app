import { getAuthenticatedUser } from '@/core/auth/server';
import { db, wgMembers } from '@/core/db';
import { apiError } from '@/core/errors';
import { verifyMemberToken } from '@/core/guards/member-token';
import { logApiError } from '@/core/infra/observability';
import { EXPECTED_MEMBER_ID_HEADER, MEMBER_TOKEN_HEADER } from '@/shared/lib/member-header';
import { and, eq } from 'drizzle-orm';
import type { NextRequest, NextResponse } from 'next/server';

const HTTP_SERVICE_UNAVAILABLE = 503;

const HTTP_UNAUTHORIZED = 401;

/**
 * Strict UUID v4 shape check: version nibble `4` plus the RFC 4122 variant
 * bits `8|9|a|b`. Every id this app validates is generated as v4
 * (`gen_random_uuid()`, `crypto.randomUUID()`, Supabase auth ids), so
 * requiring the version keeps predictable v1 ids — timestamp and node derived
 * — out of path params and body-supplied member ids, where a guessable id
 * would address another member's row. Garbage is still rejected before the
 * database.
 */
export const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

export interface VerifiedMember {
	memberId: string;
	name: string;
	/** True when the authenticated member also supplied a valid member token. */
	verified: boolean;
}

interface MemberOk {
	ok: true;
	member: VerifiedMember;
}

interface MemberFail {
	ok: false;
	response: NextResponse;
}

type RequireMemberResult = MemberOk | MemberFail;
type AuthenticatedUser = NonNullable<Awaited<ReturnType<typeof getAuthenticatedUser>>>;

function unauthorized(code: string): NextResponse {
	return apiError(code, HTTP_UNAUTHORIZED, code);
}

/**
 * Resolve the caller's active membership from their server-verified Supabase
 * identity. The server-side Supabase user-to-membership lookup is the
 * authoritative identity proof. The HMAC member token from
 * `x-manawg-member-token` grants the additional `verified` flag when valid.
 */
export async function requireMember(
	req: NextRequest,
	wgId: string,
	authenticatedUser?: AuthenticatedUser,
): Promise<RequireMemberResult> {
	try {
		const user = authenticatedUser ?? (await getAuthenticatedUser(req));
		if (!user) return { ok: false, response: unauthorized('auth_required') };
		const row = await db.query.wgMembers.findFirst({
			where: and(eq(wgMembers.wgId, wgId), eq(wgMembers.authUserId, user.id)),
			columns: { id: true, name: true, deactivatedAt: true },
		});
		if (!row) {
			return { ok: false, response: unauthorized('not_a_member') };
		}
		// Moved-out members lose API access even if their localStorage still
		// holds a valid member id.
		if (row.deactivatedAt) {
			return { ok: false, response: unauthorized('member_deactivated') };
		}
		const expectedMemberId = req.headers.get(EXPECTED_MEMBER_ID_HEADER);
		if (expectedMemberId !== null && expectedMemberId !== row.id) {
			return {
				ok: false,
				response: apiError('member_context_changed', 409, 'member_context_changed'),
			};
		}
		// Verify the HMAC member token when present. Fails closed: an absent,
		// malformed, or mismatched token yields `verified: false`, forcing the
		// caller through the legacy claim flow rather than trusting a bare
		// `x-manawg-member-id`.
		const memberToken = req.headers.get(MEMBER_TOKEN_HEADER);
		const verified = verifyMemberToken(wgId, row.id, memberToken);
		return { ok: true, member: { memberId: row.id, name: row.name, verified } };
	} catch (err) {
		logApiError('[requireMember] db error', err);
		return { ok: false, response: apiError('db_error', HTTP_SERVICE_UNAVAILABLE) };
	}
}
