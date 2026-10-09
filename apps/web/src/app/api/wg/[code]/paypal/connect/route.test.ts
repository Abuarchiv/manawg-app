import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const code = 'MTE8PZAT';
const wgId = '1bc67a5a-5c08-4c0d-8eaf-520def98021a';
const memberId = '2bc67a5a-5c08-4c0d-8eaf-520def98021a';
const authUserId = '3bc67a5a-5c08-4c0d-8eaf-520def98021a';
const merchantId = '2B23456789ABC';
const cookieName = 'manawg_paypal_connection';
const stableTrackingId = 'stable-opaque-customer-tracking-id';
const callbackNonce = '9f3e7a22-11ab-4b13-9d1e-d3a42fd7b6c0';

// The real cookie signing/parsing stays in place; the provider-facing calls are faked below.
const realOnboarding = await import('@/core/infra/paypal-onboarding');
const { readPayPalConnectionCookie, createPayPalConnectionCookie } = realOnboarding;

interface CookieState {
	nonce: string;
	code: string;
	trackingId: string;
	expectedPreviousMerchantId: string | null;
}

interface Options {
	savedMerchantId?: string | null;
	cookieExpectedPreviousMerchantId?: string | null;
	providerReady?: boolean;
	inactive?: boolean;
	activePayment?: boolean;
	cookieTrackingId?: string;
	lookupMerchantId?: string | null;
	onReadiness?: (state: Scenario['state']) => void;
	realCookie?: boolean;
}

interface Scenario {
	options: Required<Omit<Options, 'onReadiness'>> & {
		onReadiness: Options['onReadiness'] | undefined;
	};
	state: {
		updates: Record<string, unknown>[];
		referral: { trackingId: string; nonce: string; returnUrl: string } | null;
		readinessCalls: { id: string; trackingId: string }[];
		lookupCalls: string[];
		cookieState: CookieState;
		memberId: string | null;
		expectedPreviousMerchantId: string | null;
	};
}

function scenario({
	savedMerchantId = null,
	cookieExpectedPreviousMerchantId = savedMerchantId,
	providerReady = true,
	inactive = false,
	activePayment = false,
	cookieTrackingId = stableTrackingId,
	lookupMerchantId = merchantId,
	onReadiness,
	realCookie = false,
}: Options = {}): Scenario {
	return {
		options: {
			savedMerchantId,
			cookieExpectedPreviousMerchantId,
			providerReady,
			inactive,
			activePayment,
			cookieTrackingId,
			lookupMerchantId,
			onReadiness,
			realCookie,
		},
		state: {
			updates: [],
			referral: null,
			readinessCalls: [],
			lookupCalls: [],
			cookieState: {} as CookieState,
			memberId: savedMerchantId,
			expectedPreviousMerchantId: cookieExpectedPreviousMerchantId,
		},
	};
}

// Every route call runs against the scenario of the harness that issued it.
let current = scenario();

const tables = { wgMembers: { id: 'id', wgId: 'wgId', paypalMerchantId: 'paypalMerchantId' } };
const member = () => ({ id: memberId, paypalMerchantId: current.state.memberId });
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
		set: (values: { paypalMerchantId?: string }) => ({
			where: async () => {
				current.state.updates.push(values);
				current.state.memberId = values.paypalMerchantId ?? current.state.memberId;
			},
		}),
	}),
};

mock.module('@/core/db', { namedExports: { db, ...tables } });
mock.module('@/core/db/account-deletion', {
	namedExports: {
		lockActiveAccountMember: async () => (current.options.inactive ? null : { id: memberId }),
	},
});
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: wgId },
			member: { memberId, name: 'Abu' },
			authUserId,
		}),
	},
});
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => undefined, logApiError: () => undefined },
});
mock.module('@/core/infra/paypal-onboarding', {
	namedExports: {
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
		isPayPalMerchantId: (value: string) => value === merchantId,
		createPayPalPartnerReferral: async (input: NonNullable<Scenario['state']['referral']>) => {
			current.state.referral = input;
			return 'https://www.sandbox.paypal.com/partnerexp/appEntry?referralToken=generated';
		},
		getPayPalMerchantIdByTracking: async (trackingId: string) => {
			current.state.lookupCalls.push(trackingId);
			return current.options.lookupMerchantId;
		},
		isPayPalMerchantReady: async (id: string, trackingId: string) => {
			current.state.readinessCalls.push({ id, trackingId });
			current.options.onReadiness?.(current.state);
			return current.options.providerReady;
		},
		createPayPalConnectionCookie: (value: CookieState) => {
			current.state.cookieState = value;
			return 'signed-cookie';
		},
		readPayPalConnectionCookie,
		verifyPayPalConnectionCookie: (
			value: string | undefined,
			expected: { environment: 'sandbox' | 'live' },
		) => {
			if (current.options.realCookie) {
				return realOnboarding.verifyPayPalConnectionCookie(value, expected);
			}
			return value === 'signed-cookie' || value === 'valid-cookie'
				? {
						trackingId: current.options.cookieTrackingId,
						nonce: callbackNonce,
						wgId,
						memberId,
						authUserId,
						code,
						environment: expected.environment,
						expiresAt: 2_000_000_000,
						expectedPreviousMerchantId: current.state.expectedPreviousMerchantId,
					}
				: null;
		},
	},
});
mock.module('@/core/rate-limit', {
	namedExports: { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
});
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: {
		hasActiveExpensePayment: async () => current.options.activePayment,
		withExpensePaymentLock: async (_wgId: string, operation: (tx: unknown) => unknown) =>
			operation(tx),
	},
});
mock.module('drizzle-orm', { namedExports: { and: () => null, eq: () => null } });

const route = await import('./route');
const returnRoute = await import('@/app/api/paypal/return/route');

function harness(options: Options = {}) {
	const own = scenario(options);
	const connect = {
		GET: (req: Request, ctx: { code: string }) => {
			current = own;
			return route.GET(req as never, { params: Promise.resolve(ctx) } as never);
		},
		POST: (req: Request, ctx: { code: string }) => {
			current = own;
			return route.POST(req as never, { params: Promise.resolve(ctx) } as never);
		},
	};
	return { state: own.state, connect };
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
		response.headers.get('set-cookie') as string,
		new RegExp(`${cookieName}=signed-cookie; Path=/api; Max-Age=1800; HttpOnly; SameSite=Lax`),
	);
	assert.match(response.headers.get('set-cookie') as string, /; Secure$/);
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
	assert.equal((state.referral as Scenario['state']['referral'])?.trackingId, stableTrackingId);
	assert.notEqual((state.referral as Scenario['state']['referral'])?.nonce, firstNonce);
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
	assert.match(connected.headers.get('set-cookie') as string, /Max-Age=0/);

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
	const next = { GET: (req: Request) => returnRoute.GET(req as never) };
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

function completionRequest(
	body: Record<string, unknown> = { action: 'complete' },
	cookie = 'valid-cookie',
) {
	return new Request('https://manawg.example/api/connect', {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: `${cookieName}=${cookie}` },
		body: JSON.stringify(body),
	});
}

test('completion discovers only the signed tracking recipient and reuses canonical readiness', async () => {
	const { state, connect } = harness();
	const response = await connect.POST(completionRequest(), { code });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { connected: true });
	assert.deepEqual(state.lookupCalls, [stableTrackingId]);
	assert.deepEqual(state.readinessCalls, [{ id: merchantId, trackingId: stableTrackingId }]);
	assert.deepEqual(state.updates, [{ paypalMerchantId: merchantId }]);
	assert.match(response.headers.get('set-cookie') as string, /Max-Age=0/);
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('completion rejects missing state, changed client tracking, stale recipient, and caller hints before provider calls', async () => {
	const rejections: [Options, string, Record<string, unknown>, string][] = [
		[{}, '', { action: 'complete' }, 'paypal_connection_expired'],
		[
			{ cookieTrackingId: 'another-client-tracking' },
			'valid-cookie',
			{ action: 'complete' },
			'paypal_connection_expired',
		],
		[
			{ savedMerchantId: '2C23456789ABC', cookieExpectedPreviousMerchantId: null },
			'valid-cookie',
			{ action: 'complete' },
			'paypal_account_already_connected',
		],
		[{}, 'valid-cookie', { action: 'complete', merchantId }, 'paypal_request_invalid'],
		[
			{},
			'valid-cookie',
			{ action: 'complete', trackingId: stableTrackingId },
			'paypal_request_invalid',
		],
	];
	for (const [options, cookie, body, expected] of rejections) {
		const { state, connect } = harness(options);
		const response = await connect.POST(completionRequest(body, cookie), { code });
		assert.equal((await response.json()).error, expected);
		assert.deepEqual(state.lookupCalls, []);
		assert.deepEqual(state.readinessCalls, []);
		assert.deepEqual(state.updates, []);
		assert.equal(response.headers.get('set-cookie'), null);
	}
});

test('completion preserves pending state and previous recipient until canonical readiness and payment locks permit saving', async () => {
	for (const options of [
		{ lookupMerchantId: null },
		{ providerReady: false },
		{ activePayment: true },
		{ inactive: true },
	]) {
		const { state, connect } = harness({ savedMerchantId: '2C23456789ABC', ...options });
		const response = await connect.POST(completionRequest(), { code });
		assert.ok(response.status >= 400);
		assert.equal(state.memberId, '2C23456789ABC');
		assert.deepEqual(state.updates, []);
		assert.equal(response.headers.get('set-cookie'), null);
	}
});

test('completion followed by an overlapping callback cannot overwrite or duplicate the connected recipient', async () => {
	const { state, connect } = harness();
	assert.equal((await connect.POST(completionRequest(), { code })).status, 200);
	assert.equal((await connect.POST(completionRequest(), { code })).status, 409);
	const confirmation = await connect.POST(completionRequest({ action: 'confirm', merchantId }), {
		code,
	});
	assert.equal(confirmation.status, 200);
	assert.deepEqual(state.updates, [{ paypalMerchantId: merchantId }]);
});

test('completion validates real signed-cookie expiry and every current session binding before provider access', async () => {
	process.env.PAYPAL_CLIENT_SECRET = 'fixture-signing-secret';
	const cookieState = {
		trackingId: stableTrackingId,
		nonce: callbackNonce,
		wgId,
		memberId,
		authUserId,
		code,
		environment: 'sandbox',
		expiresAt: Math.floor(Date.now() / 1000) + 600,
		expectedPreviousMerchantId: null,
	};
	for (const binding of [
		{ wgId: 'other-wg' },
		{ memberId: 'other-member' },
		{ authUserId: 'other-user' },
		{ code: 'OTHER123' },
		{ environment: 'live' },
		{ expiresAt: 1 },
		{ nonce: 'invalid' },
	]) {
		const { state, connect } = harness({ realCookie: true });
		const response = await connect.POST(
			completionRequest(
				{ action: 'complete' },
				createPayPalConnectionCookie({ ...cookieState, ...binding } as never),
			),
			{ code },
		);
		assert.equal(response.status, 409);
		assert.equal((await response.json()).error, 'paypal_connection_expired');
		assert.deepEqual(state.lookupCalls, []);
		assert.deepEqual(state.readinessCalls, []);
		assert.deepEqual(state.updates, []);
	}
	const { state, connect } = harness({ realCookie: true });
	assert.equal(
		(
			await connect.POST(
				completionRequest(
					{ action: 'complete' },
					createPayPalConnectionCookie(cookieState as never),
				),
				{ code },
			)
		).status,
		200,
	);
	assert.equal(state.updates.length, 1);
});

test('completion rechecks recipient compare-and-set after provider work', async () => {
	const { state, connect } = harness({
		onReadiness: (s) => {
			s.memberId = '2C23456789ABC';
		},
	});
	const response = await connect.POST(completionRequest(), { code });
	assert.equal(response.status, 409);
	assert.equal((await response.json()).error, 'paypal_account_already_connected');
	assert.equal(state.memberId, '2C23456789ABC');
	assert.deepEqual(state.updates, []);
	assert.equal(response.headers.get('set-cookie'), null);
});

test('disconnect clears the stored merchant, but not while a payment is active', async () => {
	const post = (connect: ReturnType<typeof harness>['connect'], body: unknown) =>
		connect.POST(
			new Request('https://manawg.example/api/connect', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
			{ code },
		);

	const idle = harness({ savedMerchantId: merchantId });
	const ok = await post(idle.connect, { action: 'disconnect' });
	assert.equal(ok.status, 200);
	assert.deepEqual(await ok.json(), { connected: false });
	assert.deepEqual(idle.state.updates, [{ paypalMerchantId: null }]);

	const busy = harness({ savedMerchantId: merchantId, activePayment: true });
	const blocked = await post(busy.connect, { action: 'disconnect' });
	assert.equal(blocked.status, 409);
	assert.equal((await blocked.json()).error, 'paypal_payment_pending');
	assert.deepEqual(busy.state.updates, []);

	const extra = await post(harness().connect, { action: 'disconnect', merchantId });
	assert.equal(extra.status, 400);
});
