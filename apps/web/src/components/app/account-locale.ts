import { hasSessionCookie } from '@/core/auth/session-hint';
import { safeLocalStorage } from '@/core/utils/browser';
import type { Locale } from '@/shared/i18n/locale';

/** The locale last stored on the account from this device, so the sync runs once per change. */
const SYNCED_KEY = 'manawg:locale-synced';

/**
 * Stores the language on the account (push and mail), best effort because rendering only needs
 * the cookie.
 */
export async function saveAccountLocale(locale: Locale): Promise<void> {
	if (!hasSessionCookie()) return;
	const res = await fetch('/api/account', {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ locale }),
		// A stalled connection must not hold back the reload that applies the new language.
		signal: AbortSignal.timeout(5000),
	}).catch(() => null);
	// An unread body keeps the request open in Chromium, so the page never settles.
	await res?.text().catch(() => undefined);
	if (res?.ok) safeLocalStorage()?.setItem(SYNCED_KEY, locale);
}

/** Saves the language shown unless this device already stored it on the account. */
export async function syncAccountLocale(current: Locale): Promise<void> {
	if (safeLocalStorage()?.getItem(SYNCED_KEY) === current) return;
	await saveAccountLocale(current);
}
