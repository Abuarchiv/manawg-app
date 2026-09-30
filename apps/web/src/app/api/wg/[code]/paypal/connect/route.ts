import { randomUUID } from 'node:crypto';
import { db, wgMembers } from '@/core/db';
import { lockActiveAccountMember } from '@/core/db/account-deletion';
import {
	apiError,
	badRequest,
	conflict,
	notFound,
	requireVerifiedMember,
	serverError,
	tooMany,
} from '@/core/errors';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { logApiError } from '@/core/infra/observability';
import {
	PAYPAL_CONNECTION_COOKIE_NAME,
	createPayPalConnectionCookie,
	createPayPalPartnerReferral,
	getPayPalOnboardingConfig,
	getPayPalTrackingId,
	isPayPalMerchantId,
	isPayPalMerchantReady,
	verifyPayPalConnectionCookie,
} from '@/core/infra/paypal-onboarding';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import {
	hasActiveExpensePayment,
	withExpensePaymentLock,
} from '@/features/expenses/expense-payments';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const COOKIE_MAX_AGE = 30 * 60;
const startSchema = z.object({ action: z.literal('start'), consent: z.literal(true) }).strict();
const confirmSchema = z
	.object({ action: z.literal('confirm'), merchantId: z.string().refine(isPayPalMerchantId) })
	.strict();

function cookieValue(req: Request): string | undefined {
	const cookie = req.headers.get('cookie');
	if (!cookie) return undefined;
	for (const part of cookie.split(';')) {
		const separator = part.indexOf('=');
		if (separator >= 0 && part.slice(0, separator).trim() === PAYPAL_CONNECTION_COOKIE_NAME) {
			return part.slice(separator + 1).trim();
		}
	}
	return undefined;
}

function cookieHeader(value: string, maxAge: number, secureCookie: boolean): string {
	const secure = secureCookie ? '; Secure' : '';
	return `${PAYPAL_CONNECTION_COOKIE_NAME}=${value}; Path=/api; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function noStoreResponse(body: unknown, init?: ResponseInit): NextResponse {
	const headers = new Headers(init?.headers);
	headers.set('Cache-Control', 'no-store');
	return NextResponse.json(body, { ...init, headers });
}

export const GET = withWgRoute<{ code: string }>('paypal connect GET', async (req, { code }) => {
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const verified = requireVerifiedMember(auth.member);
	if (verified) return verified;
	const config = getPayPalOnboardingConfig();
	if (!config) return noStoreResponse({ available: false, connected: false });

	try {
		const [member] = await db
			.select({ paypalMerchantId: wgMembers.paypalMerchantId })
			.from(wgMembers)
			.where(and(eq(wgMembers.id, auth.member.memberId), eq(wgMembers.wgId, auth.wg.id)))
			.limit(1);
		if (!member) return notFound('member_not_found');
		const connected = member.paypalMerchantId
			? await isPayPalMerchantReady(member.paypalMerchantId)
			: false;
		return noStoreResponse({ available: true, connected });
	} catch (err) {
		logApiError('[paypal connect status]', err);
		return serverError('paypal_status_failed');
	}
});

export const POST = withWgRoute<{ code: string }>('paypal connect POST', async (req, { code }) => {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}
	const start = startSchema.safeParse(raw);
	const confirm = confirmSchema.safeParse(raw);
	if (!start.success && !confirm.success) {
		const error =
			raw &&
			typeof raw === 'object' &&
			'action' in raw &&
			raw.action === 'start' &&
			(!('consent' in raw) || raw.consent !== true)
				? 'paypal_consent_required'
				: 'paypal_request_invalid';
		return badRequest(error);
	}

	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const verified = requireVerifiedMember(auth.member);
	if (verified) return verified;
	const limited = await checkRateLimit(
		wgWriteLimiter,
		`paypal-connect:${auth.wg.id}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();
	const config = getPayPalOnboardingConfig();
	if (!config) return conflict('paypal_not_configured');

	if (start.success) {
		const nonce = randomUUID();
		const trackingId = getPayPalTrackingId(auth.authUserId, config.clientId, config.environment);
		const returnUrl = new URL('/api/paypal/return', config.appOrigin);
		returnUrl.searchParams.set('state', nonce);
		try {
			const [member] = await db
				.select({ paypalMerchantId: wgMembers.paypalMerchantId })
				.from(wgMembers)
				.where(and(eq(wgMembers.id, auth.member.memberId), eq(wgMembers.wgId, auth.wg.id)))
				.limit(1);
			if (!member) return notFound('member_not_found');
			const url = await createPayPalPartnerReferral({
				trackingId,
				nonce,
				returnUrl: returnUrl.toString(),
			});
			const cookie = createPayPalConnectionCookie({
				trackingId,
				nonce,
				wgId: auth.wg.id,
				memberId: auth.member.memberId,
				authUserId: auth.authUserId,
				code,
				environment: config.environment,
				expiresAt: Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE,
				expectedPreviousMerchantId: member.paypalMerchantId ?? null,
			});
			const response = noStoreResponse({ url });
			response.headers.append(
				'Set-Cookie',
				cookieHeader(cookie, COOKIE_MAX_AGE, new URL(config.appOrigin).protocol === 'https:'),
			);
			return response;
		} catch (err) {
			logApiError('[paypal connect start]', err);
			return serverError('paypal_onboarding_start_failed');
		}
	}
	if (!confirm.success) return badRequest('paypal_request_invalid');
	const confirmation = confirm.data;

	const state = verifyPayPalConnectionCookie(cookieValue(req), {
		wgId: auth.wg.id,
		memberId: auth.member.memberId,
		authUserId: auth.authUserId,
		code,
		environment: config.environment,
	});
	if (!state) return conflict('paypal_connection_expired');
	if (!confirm.success) return badRequest('paypal_request_invalid');

	let ready: boolean;
	try {
		ready = await isPayPalMerchantReady(confirmation.merchantId, state.trackingId);
	} catch (err) {
		logApiError('[paypal connect verification]', err);
		return serverError('paypal_verification_failed');
	}
	if (!ready) return conflict('paypal_onboarding_pending');

	try {
		const result = await withExpensePaymentLock(auth.wg.id, async (tx) => {
			const actor = await lockActiveAccountMember(
				tx,
				auth.wg.id,
				auth.member.memberId,
				auth.authUserId,
			);
			if (!actor) return 'member_deactivated' as const;
			const [member] = await tx
				.select({ id: wgMembers.id, paypalMerchantId: wgMembers.paypalMerchantId })
				.from(wgMembers)
				.where(and(eq(wgMembers.id, auth.member.memberId), eq(wgMembers.wgId, auth.wg.id)))
				.for('update');
			if (!member) return 'member_not_found' as const;
			if (member.paypalMerchantId !== confirmation.merchantId) {
				if ((member.paypalMerchantId ?? null) !== state.expectedPreviousMerchantId) {
					return 'paypal_account_already_connected' as const;
				}
				if (await hasActiveExpensePayment(tx, auth.wg.id)) {
					return 'paypal_payment_pending' as const;
				}
				await tx
					.update(wgMembers)
					.set({ paypalMerchantId: confirmation.merchantId })
					.where(and(eq(wgMembers.id, auth.member.memberId), eq(wgMembers.wgId, auth.wg.id)));
			}
			return 'connected' as const;
		});
		if (result === 'member_deactivated') return apiError('member_deactivated', 401);
		if (result === 'member_not_found') return notFound('member_not_found');
		if (result === 'paypal_account_already_connected') return conflict(result);
		if (result === 'paypal_payment_pending') return conflict(result);
		const response = noStoreResponse({ connected: true });
		response.headers.append(
			'Set-Cookie',
			cookieHeader('', 0, new URL(config.appOrigin).protocol === 'https:'),
		);
		return response;
	} catch (err) {
		logApiError('[paypal connect save]', err);
		return serverError('paypal_connection_save_failed');
	}
});
