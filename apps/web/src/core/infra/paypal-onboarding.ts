import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isPayPalConfigured, requestPayPalApi } from './paypal';

export type PayPalEnvironment = 'sandbox' | 'live';

export interface PayPalConnectionState {
	trackingId: string;
	nonce: string;
	wgId: string;
	memberId: string;
	authUserId: string;
	code: string;
	environment: PayPalEnvironment;
	expiresAt: number;
	expectedPreviousMerchantId: string | null;
}

const CONNECTION_COOKIE_DOMAIN = 'manawg:paypal-onboarding:v1\0';
const TRACKING_ID_DOMAIN = 'manawg:paypal-partner-customer:v1\0';
const MERCHANT_ID_PATTERN = /^[2-9A-HJ-NP-Z]{13}$/;
const SHARE_CODE_PATTERN = /^[A-Z0-9]{8}$/;
export const PAYPAL_CONNECTION_COOKIE_NAME = 'manawg_paypal_connection';
const PAYPAL_PAYMENT_SCOPES = [
	'https://uri.paypal.com/services/payments/payment/authcapture',
	'https://uri.paypal.com/services/payments/realtimepayment',
];

export function getPayPalEnvironment(): PayPalEnvironment | null {
	const environment = process.env.PAYPAL_ENV;
	return environment === 'sandbox' || environment === 'live' ? environment : null;
}

export function getPayPalTrackingId(
	authUserId: string,
	clientId: string,
	environment: PayPalEnvironment,
): string {
	return createHash('sha256')
		.update(`${TRACKING_ID_DOMAIN}${environment}\0${clientId}\0${authUserId}`)
		.digest('hex');
}

export function getPayPalOnboardingConfig(): {
	environment: PayPalEnvironment;
	clientId: string;
	partnerMerchantId: string;
	appOrigin: string;
} | null {
	const environment = getPayPalEnvironment();
	const clientId = process.env.PAYPAL_CLIENT_ID;
	const partnerMerchantId = process.env.PAYPAL_PARTNER_MERCHANT_ID;
	const appOrigin = getTrustedPayPalAppOrigin(environment);
	if (!environment || !clientId || !partnerMerchantId || !appOrigin || !isPayPalConfigured()) {
		return null;
	}
	return { environment, clientId, partnerMerchantId, appOrigin };
}

export function getTrustedPayPalAppOrigin(
	environment: PayPalEnvironment | null = getPayPalEnvironment(),
): string | null {
	const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
	if (!configuredUrl || !environment) return null;
	try {
		const url = new URL(configuredUrl);
		const localHttp =
			environment === 'sandbox' &&
			url.protocol === 'http:' &&
			['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
		if (
			(url.protocol !== 'https:' && !localHttp) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			return null;
		}
		return url.origin;
	} catch {
		return null;
	}
}

export function isPayPalMerchantId(value: unknown): value is string {
	return typeof value === 'string' && MERCHANT_ID_PATTERN.test(value);
}

export function createPayPalConnectionCookie(state: PayPalConnectionState): string {
	const secret = process.env.PAYPAL_CLIENT_SECRET;
	if (!secret) throw new Error('paypal_not_configured');
	const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
	const signature = createHmac('sha256', secret)
		.update(CONNECTION_COOKIE_DOMAIN + payload)
		.digest('base64url');
	return `${payload}.${signature}`;
}

export function verifyPayPalConnectionCookie(
	value: string | undefined,
	expected: Partial<
		Pick<PayPalConnectionState, 'wgId' | 'memberId' | 'authUserId' | 'code' | 'environment'>
	>,
	now = Math.floor(Date.now() / 1000),
): PayPalConnectionState | null {
	const secret = process.env.PAYPAL_CLIENT_SECRET;
	if (!secret || !value || value.length > 4_096) return null;
	const parts = value.split('.');
	if (parts.length !== 2) return null;
	const [payload, signature] = parts;
	if (
		!payload ||
		!signature ||
		!/^[A-Za-z0-9_-]+$/.test(payload) ||
		!/^[A-Za-z0-9_-]+$/.test(signature)
	) {
		return null;
	}
	const expectedSignature = createHmac('sha256', secret)
		.update(CONNECTION_COOKIE_DOMAIN + payload)
		.digest();
	const receivedSignature = Buffer.from(signature, 'base64url');
	if (
		receivedSignature.length !== expectedSignature.length ||
		!timingSafeEqual(receivedSignature, expectedSignature)
	) {
		return null;
	}
	try {
		const state = JSON.parse(
			Buffer.from(payload, 'base64url').toString('utf8'),
		) as Partial<PayPalConnectionState>;
		if (
			typeof state.trackingId !== 'string' ||
			typeof state.nonce !== 'string' ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.nonce) ||
			typeof state.wgId !== 'string' ||
			typeof state.memberId !== 'string' ||
			typeof state.authUserId !== 'string' ||
			typeof state.code !== 'string' ||
			!SHARE_CODE_PATTERN.test(state.code) ||
			!['sandbox', 'live'].includes(state.environment ?? '') ||
			!(
				state.expectedPreviousMerchantId === null ||
				(typeof state.expectedPreviousMerchantId === 'string' &&
					state.expectedPreviousMerchantId.length <= 128)
			) ||
			!Number.isSafeInteger(state.expiresAt) ||
			(state.expiresAt ?? 0) <= now
		) {
			return null;
		}
		for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
			if (expected[key] !== undefined && expected[key] !== state[key]) return null;
		}
		return state as PayPalConnectionState;
	} catch {
		return null;
	}
}

export function getSafePayPalActionUrl(
	value: unknown,
	environment: PayPalEnvironment,
): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		const expectedHost = environment === 'sandbox' ? 'www.sandbox.paypal.com' : 'www.paypal.com';
		if (
			url.protocol !== 'https:' ||
			url.hostname !== expectedHost ||
			url.port ||
			url.username ||
			url.password
		) {
			return null;
		}
		return url.toString();
	} catch {
		return null;
	}
}

export async function createPayPalPartnerReferral(input: {
	trackingId: string;
	nonce: string;
	returnUrl: string;
}): Promise<string> {
	const config = getPayPalOnboardingConfig();
	if (!config) throw new Error('paypal_not_configured');
	const expectedReturnUrl = new URL(
		`/api/paypal/return?state=${encodeURIComponent(input.nonce)}`,
		config.appOrigin,
	).toString();
	if (input.returnUrl !== expectedReturnUrl) throw new Error('paypal_return_url_invalid');
	const response = await requestPayPalApi<{
		links?: Array<{ rel?: string; href?: string }>;
	}>('/v2/customer/partner-referrals', {
		method: 'POST',
		body: JSON.stringify({
			tracking_id: input.trackingId,
			operations: [
				{
					operation: 'API_INTEGRATION',
					api_integration_preference: {
						rest_api_integration: {
							integration_method: 'PAYPAL',
							integration_type: 'THIRD_PARTY',
							third_party_details: { features: ['PAYMENT'] },
						},
					},
				},
			],
			products: ['EXPRESS_CHECKOUT'],
			legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
			partner_config_override: { return_url: input.returnUrl },
		}),
	});
	const actionUrl = response.links?.find((link) => link.rel === 'action_url')?.href;
	const safeUrl = getSafePayPalActionUrl(actionUrl, config.environment);
	if (!safeUrl) throw new Error('paypal_action_url_invalid');
	return safeUrl;
}

export function isPayPalMerchantIntegrationReady(
	integration: unknown,
	clientId: string,
	expectedTrackingId?: string,
): boolean {
	if (!integration || typeof integration !== 'object') return false;
	const merchant = integration as {
		tracking_id?: unknown;
		payments_receivable?: unknown;
		primary_email_confirmed?: unknown;
		products?: Array<{ name?: unknown; status?: unknown }>;
		oauth_integrations?: Array<{
			oauth_third_party?:
				| { partner_client_id?: unknown; scopes?: unknown }
				| Array<{ partner_client_id?: unknown; scopes?: unknown }>;
		}>;
	};
	const products = Array.isArray(merchant.products) ? merchant.products : [];
	const oauthIntegrations = Array.isArray(merchant.oauth_integrations)
		? merchant.oauth_integrations
		: [];
	if (
		merchant.payments_receivable !== true ||
		merchant.primary_email_confirmed !== true ||
		(expectedTrackingId !== undefined && merchant.tracking_id !== expectedTrackingId) ||
		!products.some(
			(product) =>
				!!product &&
				typeof product === 'object' &&
				product.name === 'EXPRESS_CHECKOUT' &&
				product.status === 'ACTIVE',
		)
	) {
		return false;
	}
	const thirdPartyIntegrations = oauthIntegrations.flatMap((item) => {
		if (!item || typeof item !== 'object') return [];
		return Array.isArray(item.oauth_third_party)
			? item.oauth_third_party
			: item.oauth_third_party
				? [item.oauth_third_party]
				: [];
	});
	return thirdPartyIntegrations.some((item) => {
		if (!item || typeof item !== 'object') return false;
		const scopes = item.scopes;
		return (
			item.partner_client_id === clientId &&
			Array.isArray(scopes) &&
			PAYPAL_PAYMENT_SCOPES.every((scope) => scopes.includes(scope))
		);
	});
}

export async function isPayPalMerchantReady(
	merchantId: string,
	expectedTrackingId?: string,
): Promise<boolean> {
	if (!isPayPalMerchantId(merchantId)) return false;
	const config = getPayPalOnboardingConfig();
	if (!config) throw new Error('paypal_not_configured');
	let integration: unknown;
	try {
		integration = await requestPayPalApi<unknown>(
			`/v1/customer/partners/${encodeURIComponent(config.partnerMerchantId)}/merchant-integrations/${encodeURIComponent(merchantId)}`,
			{ method: 'GET' },
		);
	} catch (err) {
		if (err instanceof Error && err.message === 'paypal_api_404') return false;
		throw err;
	}
	return (
		!!integration &&
		typeof integration === 'object' &&
		(integration as { merchant_id?: unknown }).merchant_id === merchantId &&
		isPayPalMerchantIntegrationReady(integration, config.clientId, expectedTrackingId)
	);
}
