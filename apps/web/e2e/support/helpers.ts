// Shared helpers for ManaWG Playwright happy-path E2E specs.
//
// All specs in this directory rely on the `MTE8PZAT` share-code WG, which is
// surfaced as a stable fixture in `apps/web/src/fixtures/data.ts` so that
// the WG layout renders without a real Postgres instance. Individual feature
// API endpoints are mocked per-test via `page.route()`.

import { expect, type Page, test } from '@playwright/test';
import { E2E_EXISTING_WG, FIXTURE_AUTH_USER_ID } from '../../src/fixtures/data';

declare global {
	interface Window {
		/** Set by `setupMember` when local storage cannot be written. */
		__manawgStorageBlocked?: boolean;
	}
}

export const FIXTURE_WG = {
	id: E2E_EXISTING_WG.id,
	shareCode: E2E_EXISTING_WG.shareCode,
	memberId: E2E_EXISTING_WG.member.id,
	memberName: E2E_EXISTING_WG.member.name,
} as const;

/** Skips the surrounding test or describe unless the app runs against the in-memory fixture server. */
export function skipUnlessFixtures(): void {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
}

/** Skips unless the fixture server runs with the database reported as down. */
export function skipUnlessDbDown(): void {
	test.skip(
		process.env.E2E_FIXTURE_MODE !== 'true' || process.env.NEXT_PUBLIC_DB_DOWN !== 'true',
		'requires database-down fixture server',
	);
}

/**
 * Prepares a fixture WG visit: the fixture layout already renders as the WG's first member, so
 * only stale local state from earlier specs is wiped.
 *
 * Flags blocked storage on `window` so `navigateToFeature` fails with a clear
 * cause instead of an opaque assertion later.
 */
export async function setupMember(page: Page): Promise<void> {
	await page.addInitScript(() => {
		try {
			// Wipe any stale offline queue from previous specs.
			localStorage.removeItem('manawg:offline-actions');
		} catch {
			window.__manawgStorageBlocked = true;
			document.documentElement?.setAttribute('data-manawg-storage-blocked', 'true');
		}
	});
}

/**
 * Waits until React has hydrated the element. Server-rendered forms are visible and fillable
 * earlier; in WebKit a value filled while hydration runs was sometimes reset to the initial state.
 */
export async function waitForHydration(page: Page, selector: string): Promise<void> {
	await page.waitForFunction((target) => {
		const element = document.querySelector(target);
		return element !== null && Object.keys(element).some((key) => key.startsWith('__reactFiber'));
	}, selector);
}

/**
 * Records the fixture account as this browser's local account, as a WG visit does. Needed by specs
 * that seed the offline queue or open /offline without visiting a WG first: the queue and the
 * remembered WGs are filtered by that account.
 */
export async function seedLocalAccount(page: Page): Promise<void> {
	await page.addInitScript((authUserId) => {
		try {
			localStorage.setItem('manawg_account', authUserId);
		} catch {
			// Blocked storage is reported by setupMember / navigateToFeature.
		}
	}, FIXTURE_AUTH_USER_ID);
}

/**
 * The month grid opens on the current Berlin month. Steps one month forward when `iso` falls
 * into the next one, so specs with "in two days" dates also pass at the end of a month.
 */
export async function showMonthOf(page: Page, iso: string, nextMonthLabel: string): Promise<void> {
	const month = (date: Date) =>
		new Intl.DateTimeFormat('en-CA', {
			timeZone: 'Europe/Berlin',
			year: 'numeric',
			month: '2-digit',
		}).format(date);
	if (month(new Date(iso)) !== month(new Date())) {
		await page.getByRole('button', { name: nextMonthLabel }).click();
	}
}

/**
 * Navigates to a feature path with retry-on-cold-start so the first request
 * after Next dev boot does not flake the suite.
 */
export async function navigateToFeature(page: Page, path: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 120_000 });
			const storageBlocked = await page.evaluate(() => Boolean(window.__manawgStorageBlocked));
			if (storageBlocked) {
				throw new Error(
					'localStorage is blocked in this browser context (private mode?) — the stale offline queue could not be wiped',
				);
			}
			const body = await page.locator('body').innerText();
			if (body.includes('Internal Server Error')) {
				throw new Error('Next dev server returned Internal Server Error');
			}
			if (body.includes('Seite nicht gefunden')) {
				throw new Error('not-found-during-warmup');
			}
			if (new URL(page.url()).pathname.startsWith('/login')) {
				throw new Error(
					`redirected to login (${page.url()}) — unexpected sign-in redirect; run the fixtures lane, not the live lane`,
				);
			}
			return;
		} catch (err) {
			lastError = err;
			await page.waitForTimeout(1500);
		}
	}
	throw lastError;
}

/**
 * Fixture setup must not fall through to the production access-denied state.
 */
export async function dismissOnboarding(page: Page): Promise<void> {
	const accessDenied = page.getByRole('alert', {
		name: 'Du bist in dieser WG nicht (mehr) Mitglied, z. B. weil du ausgezogen bist, entfernt wurdest oder die WG gelöscht wurde.',
	});
	await expect(accessDenied)
		.toBeHidden({ timeout: 2_000 })
		.catch(() => {
			throw new Error(
				'Fixture member was not accepted — the WG shell shows the access-denied state',
			);
		});
}

/**
 * Mocks the chat unread badge request that every WG page fires. `base` is the
 * WG API prefix, e.g. `/api/wg/MTE8PZAT`; the default count keeps the badge hidden.
 */
export async function mockUnreadCount(page: Page, base: string, count = 0): Promise<void> {
	await page.route(`**${base}/chat/unread-count`, (route) =>
		route.fulfill({ status: 200, json: { count, overflow: false } }),
	);
}

/** Mocks the signed-in user's WG list as empty (entry/onboarding pages). */
export async function mockNoWgs(page: Page): Promise<void> {
	// With Supabase configured (AUTH_UI lane) the client probes /api/wg/mine only behind the hint
	// cookie, and the middleware keeps the hint only next to a session cookie.
	const base = new URL(process.env.BASE_URL ?? 'http://localhost:3101');
	await page.context().addCookies([
		{ name: 'sb-fixture-auth-token', value: 'fixture', domain: base.hostname, path: '/' },
		{ name: 'manawg_signed_in', value: '1', domain: base.hostname, path: '/' },
	]);
	await page.route('**/api/wg/mine', (route) => route.fulfill({ status: 200, json: { wgs: [] } }));
}

/**
 * Minimal responsive matrix: 320px light at 100% text plus 320px dark at 200% text.
 * Wider widths and the other colour/scale combinations exercise the same CSS paths.
 */
export function inMinimalMatrix(c: { width: number; dark: boolean; large: boolean }): boolean {
	return c.width === 320 && c.dark === c.large;
}

/**
 * Resolves on the next history pop, or after 2 s when it already happened. A closed dialog
 * pops its history marker 50 ms later (useDismissOnBack); a page.goto started before that
 * pop gets aborted by it, so wait for it before leaving the page.
 */
export function nextHistoryPop(page: Page): Promise<unknown> {
	return page.evaluate(
		() =>
			new Promise((done) => {
				window.addEventListener('popstate', done, { once: true });
				window.setTimeout(done, 2000);
			}),
	);
}

/** Mocks the WG dashboard read under `base`, e.g. `/api/wg/MTE8PZAT`. */
export async function mockDashboard(page: Page, base: string, body: unknown): Promise<void> {
	await page.route(`**${base}/dashboard`, (route) => route.fulfill({ status: 200, json: body }));
}

type Tuple<T, N extends number, R extends T[] = []> = R['length'] extends N
	? R
	: Tuple<T, N, [...R, T]>;

/** Asserts that `items` holds exactly `count` entries and types them as a tuple. */
export function tuple<T, N extends number>(items: readonly T[], count: N): Tuple<T, N> {
	if (items.length !== count) {
		throw new Error(`Expected ${count} items, got ${items.length}`);
	}
	return [...items] as Tuple<T, N>;
}

/** Narrows away `null`/`undefined` with a descriptive failure instead of a TypeError later. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
	if (value === null || value === undefined) throw new Error(`Expected ${what} to be defined`);
	return value;
}
