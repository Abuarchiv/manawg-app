import { tooMany } from '@/core/errors';
import { checkRateLimit, wgShareCodeMissLimiter } from '@/core/rate-limit';
import type { NextResponse } from 'next/server';

/**
 * Count a share-code miss (unknown code or a WG the caller does not belong
 * to) against the caller's account. Once the budget is spent every further
 * miss answers 429, so the 404/403 difference can no longer be used to
 * enumerate share codes through nested routes. An unavailable limiter keeps
 * the original answer: members are unaffected either way.
 */
export async function shareCodeMissResponse(
	authUserId: string,
	response: NextResponse,
): Promise<NextResponse> {
	const result = await checkRateLimit(wgShareCodeMissLimiter, authUserId, 'open');
	if (!result.success && !result.limiterUnavailable) {
		return tooMany('rate_limited', 'rate_limited');
	}
	return response;
}
