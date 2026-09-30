import {
	PAYPAL_CONNECTION_COOKIE_NAME,
	getPayPalEnvironment,
	getTrustedPayPalAppOrigin,
	isPayPalMerchantId,
	verifyPayPalConnectionCookie,
} from '@/core/infra/paypal-onboarding';
import { type NextRequest, NextResponse } from 'next/server';

function cookieValue(req: NextRequest): string | undefined {
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

function redirect(location: string): NextResponse {
	return new NextResponse(null, {
		status: 303,
		headers: {
			Location: location,
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
		},
	});
}

export function GET(req: NextRequest): NextResponse {
	const environment = getPayPalEnvironment();
	const appOrigin = getTrustedPayPalAppOrigin(environment);
	if (!environment || !appOrigin) {
		return NextResponse.json(
			{ error: 'paypal_connection_expired' },
			{
				status: 503,
				headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
			},
		);
	}

	const callbackUrl = new URL(req.url);
	const state = verifyPayPalConnectionCookie(cookieValue(req), { environment });
	if (!state || callbackUrl.searchParams.get('state') !== state.nonce) {
		return redirect(new URL('/', appOrigin).toString());
	}

	const destination = new URL(`/wg/${encodeURIComponent(state.code)}/einstellungen`, appOrigin);
	destination.searchParams.set('paypal', 'return');
	const merchantId = callbackUrl.searchParams.get('merchantIdInPayPal');
	if (isPayPalMerchantId(merchantId)) {
		destination.searchParams.set('merchantIdInPayPal', merchantId);
	}
	return redirect(destination.toString());
}
