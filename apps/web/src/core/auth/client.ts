'use client';

import { retireWebPushEndpoint } from '@/core/notifications/push-subscribe';
import { createBrowserClient } from '@supabase/ssr';
import { getSupabaseEnv } from './env';
import { safeNextPath } from './next-path';

export type SocialProvider = 'google';

export type AuthSessionResult = {
	sessionEstablished: boolean;
};

export type LogoutPushTarget = {
	code: string;
	memberId: string;
	memberToken?: string;
};

export type LogoutPushCleanup = 'none' | 'unsubscribed' | 'failed';

const PHONE_PROVIDER_UNAVAILABLE_CODES = new Set(['phone_provider_disabled', 'provider_disabled']);

/** Public Supabase error codes that mean SMS auth is unavailable, not invalid input. */
export function isPhoneAuthUnavailable(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const code = Reflect.get(error, 'code');
	return typeof code === 'string' && PHONE_PROVIDER_UNAVAILABLE_CODES.has(code);
}

export function createSupabaseBrowserClient() {
	const { url, publishableKey } = getSupabaseEnv();
	return createBrowserClient(url, publishableKey);
}

export async function isAuthProviderEnabled(provider: SocialProvider | 'phone'): Promise<boolean> {
	const { url, publishableKey } = getSupabaseEnv();
	const response = await fetch(new URL('/auth/v1/settings', url), {
		headers: { apikey: publishableKey },
		cache: 'no-store',
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error('auth_unavailable');
	const settings = (await response.json()) as { external?: Record<string, boolean> };
	return settings.external?.[provider] === true;
}

async function requireEnabledProvider(provider: SocialProvider): Promise<void> {
	if (!(await isAuthProviderEnabled(provider))) throw new Error('provider_unavailable');
}

function authCallbackUrl(next: string): string {
	const callback = new URL('/auth/callback', window.location.origin);
	callback.searchParams.set('next', safeNextPath(next));
	return callback.toString();
}

export async function startSocialLogin(provider: SocialProvider, next: string): Promise<void> {
	await requireEnabledProvider(provider);
	const { error } = await createSupabaseBrowserClient().auth.signInWithOAuth({
		provider,
		options: { redirectTo: authCallbackUrl(next) },
	});
	if (error) throw error;
}

export async function linkSocialIdentity(provider: SocialProvider, next: string): Promise<void> {
	await requireEnabledProvider(provider);
	const { error } = await createSupabaseBrowserClient().auth.linkIdentity({
		provider,
		options: { redirectTo: authCallbackUrl(next) },
	});
	if (error) throw error;
}

export async function signInWithEmailPassword(
	email: string,
	password: string,
): Promise<AuthSessionResult> {
	const { data, error } = await createSupabaseBrowserClient().auth.signInWithPassword({
		email,
		password,
	});
	if (error) throw error;
	return { sessionEstablished: data.session !== null };
}

export async function signUpWithEmailPassword(
	email: string,
	password: string,
	next: string,
): Promise<AuthSessionResult> {
	const { data, error } = await createSupabaseBrowserClient().auth.signUp({
		email,
		password,
		options: { emailRedirectTo: authCallbackUrl(next) },
	});
	if (error) throw error;
	return { sessionEstablished: data.session !== null };
}

export async function requestPasswordReset(email: string): Promise<void> {
	const { error } = await createSupabaseBrowserClient().auth.resetPasswordForEmail(email, {
		redirectTo: authCallbackUrl('/auth/reset'),
	});
	if (error) throw error;
}

export async function updatePassword(password: string): Promise<void> {
	const { error } = await createSupabaseBrowserClient().auth.updateUser({ password });
	if (error) throw error;
}

export async function requestPhoneOtp(phone: string): Promise<void> {
	const { error } = await createSupabaseBrowserClient().auth.signInWithOtp({
		phone,
		options: { shouldCreateUser: true },
	});
	if (error) throw error;
}

export async function verifyPhoneOtp(phone: string, token: string): Promise<AuthSessionResult> {
	const { data, error } = await createSupabaseBrowserClient().auth.verifyOtp({
		phone,
		token,
		type: 'sms',
	});
	if (error) throw error;
	return { sessionEstablished: data.session !== null };
}

async function removeCurrentBrowserPushSubscription(
	targets: readonly LogoutPushTarget[],
): Promise<LogoutPushCleanup> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'none';

	let registration: ServiceWorkerRegistration | undefined;
	try {
		registration = await navigator.serviceWorker.getRegistration();
	} catch {
		console.warn('[auth] browser push subscription could not be inspected during logout');
		return 'failed';
	}
	if (!registration) return 'none';
	if (!registration.pushManager) return 'none';

	let subscription: PushSubscription | null;
	try {
		subscription = await registration.pushManager.getSubscription();
	} catch {
		console.warn('[auth] browser push subscription could not be inspected during logout');
		return 'failed';
	}
	if (!subscription) return 'none';

	const uniqueTargets = [
		...new Map(targets.map((target) => [`${target.code}:${target.memberId}`, target])).values(),
	];
	const serverCleanup = Promise.allSettled(
		uniqueTargets.map((target) =>
			retireWebPushEndpoint(
				target.code,
				target.memberId,
				subscription.endpoint,
				target.memberToken,
			),
		),
	);
	let locallyUnsubscribed = false;
	let unsubscribeTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		locallyUnsubscribed = await Promise.race([
			subscription.unsubscribe().catch(() => false),
			new Promise<false>((resolve) => {
				unsubscribeTimeout = setTimeout(() => resolve(false), 3_000);
			}),
		]);
	} catch {
		locallyUnsubscribed = false;
	} finally {
		if (unsubscribeTimeout) clearTimeout(unsubscribeTimeout);
	}
	const serverResults = await serverCleanup;
	const serverCleanupSucceeded =
		uniqueTargets.length > 0 && serverResults.every((result) => result.status === 'fulfilled');
	if (!locallyUnsubscribed) {
		console.warn('[auth] browser push subscription could not be retired during logout');
		return 'failed';
	}
	if (!serverCleanupSucceeded && uniqueTargets.length > 0) {
		console.warn('[auth] browser push endpoint cleanup request failed during logout');
	}
	return 'unsubscribed';
}

export async function signOutSocialAccount(
	pushTargets: readonly LogoutPushTarget[] = [],
): Promise<{ pushCleanup: LogoutPushCleanup }> {
	const pushCleanup = await removeCurrentBrowserPushSubscription(pushTargets).catch(
		() => 'failed' as const,
	);
	const { error } = await createSupabaseBrowserClient().auth.signOut({ scope: 'local' });
	if (error) throw error;
	return { pushCleanup };
}
