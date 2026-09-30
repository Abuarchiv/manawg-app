import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const code = 'MTE8PZAT';
const wgId = '1bc67a5a-5c08-4c0d-8eaf-520def98021a';
const memberId = '2bc67a5a-5c08-4c0d-8eaf-520def98021a';
const authUserId = '3bc67a5a-5c08-4c0d-8eaf-520def98021a';
const merchantId = '2B23456789ABC';
const cookieName = 'manawg_paypal_connection';
const stableTrackingId = 'stable-opaque-customer-tracking-id';
const callbackNonce = '9f3e7a22-11ab-4b13-9d1e-d3a42fd7b6c0';

function loadTs(file, overrides = {}) {
	const source = readFileSync(file, 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

function responseError(error, status = 400) {
	return Response.json({ error }, { status });
}

function harness({
	savedMerchantId = null,
	cookieExpectedPreviousMerchantId = savedMerchantId,
	providerReady = true,
	inactive = false,
	activePayment = false,
} = {}) {
	const state = {
		updates: [],
		referral: null,
		readinessCalls: [],
		cookieState: null,
		memberId: savedMerchantId,
		expectedPreviousMerchantId: cookieExpectedPreviousMerchantId,
	};
	const tables = { wgMembers: { id: 'id', wgId: 'wgId', paypalMerchantId: 'paypalMerchantId' } };
	const member = () => ({ id: memberId, paypalMerchantId: state.memberId });
	const db = {
		select: () => {
			const query = {
				from: () => query,
				where: () => query,
				limit: async () => [member()],
			};
			return query;
		},
	};
	const tx = {
		select: () => {
			const query = {
				from: () => query,
				where: () => query,
				for: async () => [member()],
			};
			return query;
		},
		update: () => ({
			set: (values) => ({
				where: async () => {
					state.updates.push(values);
					state.memberId = values.paypalMerchantId ?? state.memberId;
				},
			}),
		}),
	};
	const payPal = {
		PAYPAL_CONNECTION_COOKIE_NAME: cookieName,
		getPayPalOnboardingConfig: () => ({
			environment: 'sandbox',
			clientId: 'client',
			partnerMerchantId: 'partner',
			appOrigin: 'https://manawg.example',
		}),
		getPayPalEnvironment: () => 'sandbox',
		getTrustedPayPalAppOrigin: () => 'https://manawg.example',
		getPayPalTrackingId: () => stableTrackingId,
		isPayPalMerchantId: (value) => value === merchantId,
		createPayPalPartnerReferral: async (input) => {
			state.referral = input;
			return 'https://www.sandbox.paypal.com/partnerexp/appEntry?referralToken=generated';
		},
		isPayPalMerchantReady: async (id, trackingId) => {
			state.readinessCalls.push({ id, trackingId });
			return providerReady;
		},
		createPayPalConnectionCookie: (value) => {
			state.cookieState = value;
			return 'signed-cookie';
		},
		verifyPayPalConnectionCookie: (value, expected) =>
			value === 'signed-cookie' || value === 'valid-cookie'
				? {
						trackingId: stableTrackingId,
						nonce: callbackNonce,
						wgId,
						memberId,
						authUserId,
						code,
						environment: expected.environment,
						expiresAt: 2_000_000_000,
						expectedPreviousMerchantId: state.expectedPreviousMerchantId,
					}
				: null,
	};
	const auth = {
		ok: true,
		wg: { id: wgId },
		member: { memberId, name: 'Abu', verified: true },
		authUserId,
	};
	const errors = {
		apiError: responseError,
		badRequest: (error) => responseError(error, 400),
		conflict: (error) => responseError(error, 409),
		forbidden: (error) => responseError(error, 403),
		notFound: (error) => responseError(error, 404),
		requireVerifiedMember: () => null,
		serverError: (error) => responseError(error, 500),
		tooMany: () => new Response(null, { status: 429 }),
	};
	const overrides = {
		'@/core/db': { db, ...tables },
		'@/core/db/account-deletion': {
			lockActiveAccountMember: async () => (inactive ? null : { id: memberId }),
		},
		'@/core/errors': errors,
		'@/core/guards/require-wg-member': { requireWgMember: async () => auth },
		'@/core/guards/with-wg-route': { withWgRoute: (_name, handler) => handler },
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/infra/paypal-onboarding': payPal,
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/features/expenses/expense-payments': {
			hasActiveExpensePayment: async () => activePayment,
			withExpensePaymentLock: async (_wgId, operation) => operation(tx),
		},
		'drizzle-orm': { and: () => null, eq: () => null },
		'next/server': { NextResponse: Response },
	};
	const connect = loadTs('src/app/api/wg/[code]/paypal/connect/route.ts', overrides);
	return { state, connect };
}

test('GET exposes only provider readiness and returns no-store', async () => {
	const { connect } = harness({ savedMerchantId: merchantId });
	const response = await connect.GET(new Request('https://manawg.example/api/connect'), { code });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { available: true, connected: true });
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('start requires affirmative consent and fixes the callback to the configured generic URL', async () => {
	const { state, connect } = harness({ savedMerchantId: merchantId });
	const invalid = await connect.POST(
		new Request('https://manawg.example/api/connect', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'start', consent: false, returnUrl: 'https://attacker.test' }),
		}),
		{ code },
	);
	assert.equal(invalid.status, 400);
	assert.equal(state.referral, null);

	const response = await connect.POST(
		new Request('https://manawg.example/api/connect', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'start', consent: true }),
		}),
		{ code },
	);
	assert.equal(response.status, 200);
	assert.deepEqual(state.referral, {
		trackingId: stableTrackingId,
		nonce: state.cookieState.nonce,
		returnUrl: `https://manawg.example/api/paypal/return?state=${state.cookieState.nonce}`,
	});
	assert.equal(state.cookieState.code, code);
	assert.equal(state.cookieState.trackingId, stableTrackingId);
	assert.equal(state.cookieState.expectedPreviousMerchantId, merchantId);
	assert.match(
		response.headers.get('set-cookie'),
		new RegExp(`${cookieName}=signed-cookie; Path=/api; Max-Age=1800; HttpOnly; SameSite=Lax`),
	);
	assert.match(response.headers.get('set-cookie'), /; Secure$/);
	const firstNonce = state.cookieState.nonce;
	const secondStart = await connect.POST(
		new Request('https://manawg.example/api/connect', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'start', consent: true }),
		}),
		{ code },
	);
	assert.equal(secondStart.status, 200);
	assert.equal(state.referral.trackingId, stableTrackingId);
	assert.notEqual(state.referral.nonce, firstNonce);
});

test('unready or forged provider return never writes a recipient ID', async () => {
	const { state, connect } = harness({ providerReady: false });
	const response = await connect.POST(
		new Request('https://manawg.example/api/connect', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `${cookieName}=valid-cookie` },
			body: JSON.stringify({ action: 'confirm', merchantId }),
		}),
		{ code },
	);
	assert.equal(response.status, 409);
	assert.equal((await response.json()).error, 'paypal_onboarding_pending');
	assert.deepEqual(state.readinessCalls, [{ id: merchantId, trackingId: stableTrackingId }]);
	assert.deepEqual(state.updates, []);
});

test('verified onboarding can replace the signed previous recipient and rejects concurrent account changes', async () => {
	const first = harness();
	const connected = await first.connect.POST(
		new Request('https://manawg.example/api/connect', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `${cookieName}=valid-cookie` },
			body: JSON.stringify({ action: 'confirm', merchantId }),
		}),
		{ code },
	);
	assert.equal(connected.status, 200);
	assert.deepEqual(await connected.json(), { connected: true });
	assert.deepEqual(first.state.updates, [{ paypalMerchantId: merchantId }]);
	assert.match(connected.headers.get('set-cookie'), /Max-Age=0/);

	const second = harness({ savedMerchantId: '2C23456789ABC' });
	const correctedLegacyId = await second.connect.POST(
		new Request('https://manawg.example/api/connect', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `${cookieName}=valid-cookie` },
			body: JSON.stringify({ action: 'confirm', merchantId }),
		}),
		{ code },
	);
	assert.equal(correctedLegacyId.status, 200);
	assert.deepEqual(second.state.updates, [{ paypalMerchantId: merchantId }]);

	const changed = harness({
		savedMerchantId: '2C23456789ABC',
		cookieExpectedPreviousMerchantId: null,
	});
	const repeatedConfirmation = await second.connect.POST(
		new Request('https://manawg.example/api/connect', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `${cookieName}=valid-cookie` },
			body: JSON.stringify({ action: 'confirm', merchantId }),
		}),
		{ code },
	);
	assert.equal(repeatedConfirmation.status, 200);
	assert.deepEqual(second.state.updates, [{ paypalMerchantId: merchantId }]);

	const conflict = await changed.connect.POST(
		new Request('https://manawg.example/api/connect', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `${cookieName}=valid-cookie` },
			body: JSON.stringify({ action: 'confirm', merchantId }),
		}),
		{ code },
	);
	assert.equal(conflict.status, 409);
	assert.equal((await conflict.json()).error, 'paypal_account_already_connected');
	assert.deepEqual(changed.state.updates, []);
});

test('replacement waits until every active WG payment has settled or expired', async () => {
	const { state, connect } = harness({ savedMerchantId: '2C23456789ABC', activePayment: true });
	const response = await connect.POST(
		new Request('https://manawg.example/api/connect', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `${cookieName}=valid-cookie` },
			body: JSON.stringify({ action: 'confirm', merchantId }),
		}),
		{ code },
	);
	assert.equal(response.status, 409);
	assert.equal((await response.json()).error, 'paypal_payment_pending');
	assert.deepEqual(state.updates, []);
});

test('generic PayPal return ignores caller destinations and malformed merchant hints', async () => {
	const next = loadTs('src/app/api/paypal/return/route.ts', {
		'@/core/infra/paypal-onboarding': {
			PAYPAL_CONNECTION_COOKIE_NAME: cookieName,
			getPayPalEnvironment: () => 'sandbox',
			getTrustedPayPalAppOrigin: () => 'https://manawg.example',
			isPayPalMerchantId: (value) => value === merchantId,
			verifyPayPalConnectionCookie: (value) =>
				value === 'valid-cookie' ? { environment: 'sandbox', code, nonce: callbackNonce } : null,
		},
		'next/server': { NextResponse: Response },
	});
	const response = await next.GET(
		new Request(
			`https://manawg.example/api/paypal/return?state=${callbackNonce}&code=EVILCODE&next=https%3A%2F%2Fevil.test&merchantIdInPayPal=${merchantId}`,
			{ headers: { cookie: `${cookieName}=valid-cookie` } },
		),
	);
	assert.equal(response.status, 303);
	assert.equal(
		response.headers.get('location'),
		`https://manawg.example/wg/${code}/einstellungen?paypal=return&merchantIdInPayPal=${merchantId}`,
	);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal(response.headers.get('referrer-policy'), 'no-referrer');

	const invalidHint = await next.GET(
		new Request(
			`https://manawg.example/api/paypal/return?state=${callbackNonce}&merchantIdInPayPal=javascript%3Aalert(1)`,
			{
				headers: { cookie: `${cookieName}=valid-cookie` },
			},
		),
	);
	assert.equal(
		invalidHint.headers.get('location'),
		`https://manawg.example/wg/${code}/einstellungen?paypal=return`,
	);
	const mismatchedState = await next.GET(
		new Request('https://manawg.example/api/paypal/return?state=other', {
			headers: { cookie: `${cookieName}=valid-cookie` },
		}),
	);
	assert.equal(mismatchedState.headers.get('location'), 'https://manawg.example/');
});
