import { getAuthenticatedUser } from '@/core/auth/server';
import { apiError, notFound } from '@/core/errors';
import { type VerifiedMember, requireMember } from '@/core/guards/api-auth';
import { type ResolvedWg, resolveWg } from '@/core/guards/resolve';
import { shareCodeMissResponse } from '@/core/guards/share-code-miss';
import { logApiError } from '@/core/infra/observability';
import type { NextRequest, NextResponse } from 'next/server';

interface WgMemberOk {
	ok: true;
	wg: ResolvedWg;
	member: VerifiedMember;
	authUserId: string;
}

interface WgMemberFail {
	ok: false;
	response: NextResponse;
}

type RequireWgMemberResult = WgMemberOk | WgMemberFail;

const HTTP_UNAUTHORIZED = 401;

/**
 * Resolve a share code to its WG and verify the caller is a member — the
 * standard guard for every `/api/wg/[code]/...` route handler.
 *
 * Expects `code` to already be normalized and validated via
 * {@link normalizeShareCode} / {@link isValidShareCode}; routes keep that
 * cheap check before parsing the body so error precedence stays stable.
 *
 * Returns either:
 *   - `{ ok: true, wg, member }` — full WG row plus the verified caller
 *   - `{ ok: false, response }` — a 404 (`wg_not_found`) or the 401 from
 *     {@link requireMember}, ready to be returned as-is
 *
 * Only server-verified users reach the WG lookup, so a forged auth header
 * cannot reveal whether a share code exists.
 *
 * Database errors from the WG lookup are thrown, so callers keep their
 * existing try/catch → `serverError` handling.
 */
export async function requireWgMember(
	req: NextRequest,
	code: string,
): Promise<RequireWgMemberResult> {
	let user: Awaited<ReturnType<typeof getAuthenticatedUser>>;
	try {
		user = await getAuthenticatedUser(req);
	} catch (err) {
		logApiError('[requireWgMember] auth error', err);
		return { ok: false, response: apiError('db_error', 503) };
	}
	if (!user) {
		return {
			ok: false,
			response: apiError('auth_required', HTTP_UNAUTHORIZED, 'auth_required'),
		};
	}

	const wg = await resolveWg(code);
	if (!wg) {
		return { ok: false, response: await shareCodeMissResponse(user.id, notFound('wg_not_found')) };
	}
	const auth = await requireMember(req, wg.id, user);
	if (!auth.ok) {
		const body = (await auth.response
			.clone()
			.json()
			.catch(() => null)) as { error?: unknown } | null;
		const response =
			body?.error === 'not_a_member'
				? await shareCodeMissResponse(user.id, auth.response)
				: auth.response;
		return { ok: false, response };
	}
	return { ok: true, wg, member: auth.member, authUserId: user.id };
}
