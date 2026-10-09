// Accessibility: contrast tokens, forced-colors focus, label-in-name, Enter-key hints/next field.
// Why: WCAG 2.2 targets (contrast, focus, label-in-name) are legal/UX requirements and regress via styling changes.

import { type Locator, type Page, expect, test } from '@playwright/test';
import {
	FIXTURE_WG,
	dismissOnboarding,
	mockNoWgs,
	mockUnreadCount,
	navigateToFeature,
	setupMember,
} from './support/helpers';

test.describe('contrast tokens', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	// Regression for WCAG 1.4.11 (Non-text Contrast, 3:1 minimum): the shadcn default
	// theme shipped --input: oklch(0.922 0 0) and --ring: oklch(0.708 0 0) in light mode,
	// which only reach 1.26:1 and 2.59:1 against a white page/card background. That made
	// unfocused text-input borders and the unchecked Switch's track/thumb boundary (which
	// is filled with --input, see components/animate-ui/components/base/switch.tsx) and
	// the focus-visible ring (--ring) nearly invisible in light mode. Dark mode already
	// passed (--input/--ring are darker there) and must stay that way.
	//
	// This runs the real contrast math against the browser's *computed* colors (Chromium
	// serializes them as oklch()/oklab(), not rgb()) rather than re-deriving oklch by hand,
	// so it catches any future token change that regresses the ratio, not just this one.
	function sampleBoundaryContrast(args: {
		selector: string;
		pseudo?: string;
		prop: 'backgroundColor' | 'borderTopColor';
		/** Compare against this element/pseudo instead of walking up to the nearest opaque ancestor. */
		against?: { selector: string; pseudo?: string };
	}) {
		function parseToLinearSrgb(str: string): { r: number; g: number; b: number; a: number } | null {
			const oklchM = str.match(/oklch\(([^)]+)\)/);
			const oklabM = str.match(/oklab\(([^)]+)\)/);
			const rgbM = str.match(/rgba?\(([^)]+)\)/);
			const oklchOrOklabM = oklchM ?? oklabM;
			if (oklchOrOklabM) {
				const raw = oklchOrOklabM[1] ?? '';
				const [main = '', alphaPart] = raw.split('/').map((s) => s.trim());
				const [n0 = Number.NaN, n1 = Number.NaN, n2 = Number.NaN] = main
					.split(/\s+/)
					.map((s) => Number.parseFloat(s));
				const a = alphaPart ? Number.parseFloat(alphaPart) : 1;
				let L: number;
				let A: number;
				let B: number;
				if (oklchM) {
					L = n0;
					A = n1 * Math.cos((n2 * Math.PI) / 180);
					B = n1 * Math.sin((n2 * Math.PI) / 180);
				} else {
					[L, A, B] = [n0, n1, n2];
				}
				const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
				const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
				const s_ = L - 0.0894841775 * A - 1.291485548 * B;
				const l = l_ ** 3;
				const m = m_ ** 3;
				const s = s_ ** 3;
				const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
				const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
				const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
				return { r, g, b, a };
			}
			if (rgbM) {
				const [red = Number.NaN, green = Number.NaN, blue = Number.NaN, alpha = 1] = (rgbM[1] ?? '')
					.split(',')
					.map((s) => Number.parseFloat(s.trim()));
				const srgbToLinear = (v: number) => {
					const c = v / 255;
					return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
				};
				return {
					r: srgbToLinear(red),
					g: srgbToLinear(green),
					b: srgbToLinear(blue),
					a: alpha,
				};
			}
			return null;
		}
		function luminance(c: { r: number; g: number; b: number }) {
			return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
		}
		function contrast(
			c1: { r: number; g: number; b: number },
			c2: { r: number; g: number; b: number },
		) {
			const L1 = luminance(c1);
			const L2 = luminance(c2);
			const [a, b] = L1 > L2 ? [L1, L2] : [L2, L1];
			return (a + 0.05) / (b + 0.05);
		}
		function composite(
			fg: { r: number; g: number; b: number; a: number },
			bg: { r: number; g: number; b: number },
		) {
			return {
				r: fg.r * fg.a + bg.r * (1 - fg.a),
				g: fg.g * fg.a + bg.g * (1 - fg.a),
				b: fg.b * fg.a + bg.b * (1 - fg.a),
			};
		}
		function nearestOpaqueBg(el: Element): string {
			let node: Element | null = el;
			while (node) {
				const bg = getComputedStyle(node).backgroundColor;
				const parsed = parseToLinearSrgb(bg);
				if (parsed && parsed.a > 0.99) return bg;
				node = node.parentElement;
			}
			return getComputedStyle(document.body).backgroundColor;
		}
		const el = document.querySelector(args.selector);
		if (!el) return { error: `not found: ${args.selector}` };
		const boundaryRaw = args.pseudo
			? getComputedStyle(el, args.pseudo)[args.prop]
			: getComputedStyle(el)[args.prop];
		let pageRaw: string;
		if (args.against) {
			const againstEl = document.querySelector(args.against.selector);
			if (!againstEl) return { error: `not found: ${args.against.selector}` };
			pageRaw = args.against.pseudo
				? getComputedStyle(againstEl, args.against.pseudo).backgroundColor
				: getComputedStyle(againstEl).backgroundColor;
		} else {
			pageRaw = nearestOpaqueBg(el.parentElement ?? el);
		}
		const page = parseToLinearSrgb(pageRaw);
		const boundary = parseToLinearSrgb(boundaryRaw);
		if (!page || !boundary) return { error: 'unparseable color', boundaryRaw, pageRaw };
		// The "adjacent color" surface itself might be semi-transparent (e.g. the dark-mode
		// unchecked track uses an alpha fill); composite it onto an opaque backdrop first.
		const backdrop = args.against
			? parseToLinearSrgb(nearestOpaqueBg(el.parentElement ?? el))
			: null;
		const opaquePage = backdrop && page.a < 0.99 ? composite(page, backdrop) : page;
		const composited = composite(boundary, opaquePage);
		return {
			boundaryRaw,
			pageRaw,
			ratio: Number(contrast(composited, opaquePage).toFixed(2)),
		};
	}

	const notificationStatus = {
		pushOptIn: false,
		pushConfigured: true,
		notifyAnnouncements: true,
		notifyChores: true,
		notifyExpenses: false,
		notifyReminders: true,
		notifyShopping: true,
		notifyInventory: true,
		notifyChat: true,
		notifyEvents: true,
		quietStartHour: null,
		quietEndHour: null,
	};

	for (const scheme of ['light', 'dark'] as const) {
		test(`text input border meets 3:1 non-text contrast in ${scheme}`, async ({ page }) => {
			await page.emulateMedia({ colorScheme: scheme });
			await setupMember(page);
			await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/shopping`, (route) =>
				route.fulfill({ json: { items: [] } }),
			);
			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einkauf`);
			const input = page.getByRole('textbox', { name: 'Artikel-Name' });
			await expect(input).toBeVisible();

			const resting = await page.evaluate(sampleBoundaryContrast, {
				selector: '[aria-label="Artikel-Name"]',
				prop: 'borderTopColor' as const,
			});
			expect(resting.ratio, JSON.stringify(resting)).toBeGreaterThanOrEqual(3);

			await input.focus();
			const focused = await page.evaluate(sampleBoundaryContrast, {
				selector: '[aria-label="Artikel-Name"]',
				prop: 'borderTopColor' as const,
			});
			expect(focused.ratio, JSON.stringify(focused)).toBeGreaterThanOrEqual(3);
		});

		test(`switch track/thumb meet 3:1 non-text contrast in ${scheme}`, async ({ page }) => {
			await page.emulateMedia({ colorScheme: scheme });
			await setupMember(page);
			await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/notifications`, (route) =>
				route.fulfill({ json: notificationStatus }),
			);
			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#benachrichtigungen`);
			const checked = page.getByRole('switch', { name: 'Putzplan', exact: true });
			const unchecked = page.getByRole('switch', { name: 'Ausgaben', exact: true });
			await expect(checked).toBeChecked();
			await expect(unchecked).not.toBeChecked();
			await expect(checked).toBeEnabled();
			await expect(unchecked).toBeEnabled();
			await Promise.all(
				[checked, unchecked].map((control) =>
					control.evaluate(async (element) => {
						await Promise.all(
							element
								.getAnimations({ subtree: true })
								.map((animation) => animation.finished.catch(() => undefined)),
						);
					}),
				),
			);

			for (const [label, expectChecked] of [
				['Putzplan', true],
				['Ausgaben', false],
			] as const) {
				const track = await page.evaluate(sampleBoundaryContrast, {
					selector: `[aria-label="${label}"]`,
					pseudo: '::before',
					prop: 'backgroundColor' as const,
				});
				expect(
					track.ratio,
					`${label} (checked=${expectChecked}) track: ${JSON.stringify(track)}`,
				).toBeGreaterThanOrEqual(3);

				const thumb = await page.evaluate(sampleBoundaryContrast, {
					selector: `[aria-label="${label}"] [data-slot="switch-thumb"]`,
					prop: 'backgroundColor' as const,
					against: { selector: `[aria-label="${label}"]`, pseudo: '::before' },
				});
				expect(
					thumb.ratio,
					`${label} (checked=${expectChecked}) thumb: ${JSON.stringify(thumb)}`,
				).toBeGreaterThanOrEqual(3);
			}
		});
	}
});

test.describe('forced colors focus', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	async function expectSystemFocusRing(page: Page, target: Locator): Promise<void> {
		const styles = await target.evaluate((element) => {
			const { outlineColor, outlineOffset, outlineStyle, outlineWidth } = getComputedStyle(element);
			return { outlineColor, outlineOffset, outlineStyle, outlineWidth };
		});
		const highlight = await page.evaluate(() => {
			const sample = document.createElement('span');
			sample.style.color = 'Highlight';
			document.body.append(sample);
			const color = getComputedStyle(sample).color;
			sample.remove();
			return color;
		});

		expect(styles).toMatchObject({
			outlineColor: highlight,
			outlineOffset: '2px',
			outlineStyle: 'solid',
		});
		expect(Number.parseFloat(styles.outlineWidth)).toBeGreaterThanOrEqual(3);
	}

	test('keeps keyboard focus visible in Windows high contrast on shared controls and WG actions', async ({
		page,
		browserName,
	}) => {
		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/chores`, (route) =>
			route.fulfill({
				json: {
					chores: [
						{
							id: 'chore-bath',
							title: 'Bad putzen',
							intervalDays: 7,
							recurrenceType: 'days',
							nextDueAt: new Date().toISOString(),
							assignedMemberId: FIXTURE_WG.memberId,
							lastCompletedAt: null,
							lastCompletedByName: null,
							openGapCountForAssignee: 0,
						},
					],
					monthCompletions: {},
				},
			}),
		);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/putzen`);
		await dismissOnboarding(page);
		const doneChore = page.getByRole('button', { name: 'Als erledigt markieren: Bad putzen' });
		await expect(doneChore).toBeVisible();
		await expect(doneChore).toBeEnabled();

		await page.evaluate(() => {
			const fixture = document.createElement('div');
			fixture.innerHTML = `
			<button data-testid="focus-button" class="outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">Button</button>
			<input data-testid="focus-input" aria-label="Fixture Eingabe" class="h-11 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
			<select data-testid="focus-select" aria-label="Fixture Auswahl" class="h-11 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"><option>Option</option></select>
			<a data-testid="focus-link" href="#focus-link-target">Link</a>
		`;
			document.body.insertBefore(fixture, document.body.firstChild);
		});

		const fixtureButton = page.getByTestId('focus-button');
		await page.emulateMedia({ forcedColors: 'none', colorScheme: 'light' });
		await page.keyboard.press('Tab');
		if (browserName === 'webkit') {
			// WebKit's default macOS Tab order skips buttons and links without Full Keyboard Access.
			await expect(page.getByTestId('focus-input')).toBeFocused();
			await fixtureButton.focus();
			await expect(fixtureButton).toBeFocused();
		} else {
			await expect(fixtureButton).toBeFocused();
		}
		const lightRing = await fixtureButton.evaluate(
			(element) => getComputedStyle(element).boxShadow,
		);
		expect(lightRing).not.toBe('none');

		await page.evaluate(() => document.documentElement.classList.add('dark'));
		await page.emulateMedia({ forcedColors: 'none', colorScheme: 'dark' });
		const darkRing = await fixtureButton.evaluate((element) => getComputedStyle(element).boxShadow);
		expect(darkRing).not.toBe('none');

		await page.emulateMedia({ forcedColors: 'active' });
		await expectSystemFocusRing(page, fixtureButton);

		for (const selector of ['focus-input', 'focus-select', 'focus-link']) {
			const target = page.getByTestId(selector);
			if (browserName === 'webkit' && selector === 'focus-link') {
				await target.focus();
			} else {
				await page.keyboard.press('Tab');
			}
			await expect(target).toBeFocused();
			await expectSystemFocusRing(page, target);
			if (selector === 'focus-input' || selector === 'focus-select') {
				const height = await target.evaluate((element) => element.getBoundingClientRect().height);
				expect(height).toBeGreaterThanOrEqual(44);
			}
		}

		const choreButton = page.getByRole('button', { name: 'Als erledigt markieren: Bad putzen' });
		let reachedChoreButton = false;
		if (browserName === 'webkit') {
			// WebKit's native Tab order skips buttons and links without Full Keyboard Access.
			await choreButton.focus();
			reachedChoreButton = await choreButton.evaluate(
				(element) => element === document.activeElement,
			);
		} else {
			for (let i = 0; i < 100; i += 1) {
				await page.keyboard.press('Tab');
				if (await choreButton.evaluate((element) => element === document.activeElement)) {
					reachedChoreButton = true;
					break;
				}
			}
		}
		expect(reachedChoreButton).toBe(true);
		await expectSystemFocusRing(page, choreButton);
		const hitTarget = await choreButton.evaluate((element) => {
			const style = getComputedStyle(element, '::after');
			return { height: style.height, minWidth: style.minWidth };
		});
		expect(Number.parseFloat(hitTarget.height)).toBeGreaterThanOrEqual(44);
		expect(Number.parseFloat(hitTarget.minWidth)).toBeGreaterThanOrEqual(44);
	});
});

test.describe('label in name audit', () => {
	// Regression checks for the SEMANTICS/NAVIGATION/LOCALE audit: single <h1> per
	// page, WCAG 2.5.3 label-in-name on icon+text buttons, and SPA route-change
	// focus (Next's AppRouterAnnouncer never fires across sibling `/wg/[code]/*`
	// routes because `document.title` and the page's single <h1> never change).

	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	const BASE = `/api/wg/${FIXTURE_WG.shareCode}`;
	// Fixture WG name (src/fixtures/data.ts E2E_EXISTING_WG.name) — not
	// exported via FIXTURE_WG, so it is duplicated here like the other specs do.
	const WG_NAME = 'sadf';

	const emptyDashboard = {
		balances: [],
		spendByDay: [],
		totalSpendByCurrency: {},
		weekSpendByCurrency: {},
		monthSpendByCurrency: {},
		totalSpendCents: 0,
		weekSpendCents: 0,
		monthSpendCents: 0,
		openShoppingCount: 0,
		openShoppingTop: [],
		dueChores: [],
		dueRecurringExpenses: [],
		activity: [],
		latestAnnouncement: null,
		myOpenAnnouncements: [],
		absentMembers: [],
		wgHealth: { score: 100, label: 'Alles im Griff', items: [] },
		setup: {
			choreCount: 0,
			hasExpense: false,
			hasShoppingItem: false,
			hasAnnouncement: false,
			notificationsEnabled: false,
		},
	};

	test('Start page has exactly one <h1>, named after the WG', async ({ page }) => {
		await setupMember(page);
		await page.route(`**${BASE}/dashboard`, (route) => route.fulfill({ json: emptyDashboard }));
		await mockUnreadCount(page, BASE);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
		await dismissOnboarding(page);

		// WCAG 1.3.1 / 2.4.6 — WgAppHeader's WG-name heading must be the page's
		// only level-1 heading; the date line below it is a <h2>.
		await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
		await expect(
			page.getByRole('heading', { level: 1, name: `${WG_NAME} – Start`, exact: true }),
		).toBeVisible();
	});

	test('bottom-nav navigation moves focus to the main landmark', async ({ page }) => {
		await setupMember(page);
		await page.route(`**${BASE}/dashboard`, (route) => route.fulfill({ json: emptyDashboard }));
		await mockUnreadCount(page, BASE);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
		await dismissOnboarding(page);

		const nav = page.getByRole('navigation', { name: 'WG Hauptnavigation' });
		const haushalt = nav.getByRole('link', { name: 'Haushalt', exact: true });
		await haushalt.click();

		// Without RouteFocusOnNavigate, the just-activated <a> keeps focus because
		// the shared <main> never remounts across sibling `/wg/[code]/*` routes.
		await expect(page.locator('#main')).toBeFocused();
	});

	test('new-WG invite card names the visible action first', async ({ page }) => {
		await setupMember(page);
		await page.route(`**${BASE}/dashboard`, (route) => route.fulfill({ json: emptyDashboard }));
		await mockUnreadCount(page, BASE);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
		await dismissOnboarding(page);

		// WCAG 2.5.3 — the visible "Mitbewohner einladen" text must be the whole
		// accessible name, not a differently-worded aria-label.
		await expect(
			page.getByRole('button', { name: 'Mitbewohner einladen', exact: true }),
		).toBeVisible();
	});

	test('subscription pause button names the visible action first, then the subscription', async ({
		page,
	}) => {
		await setupMember(page);
		await page.route(`**${BASE}/members*`, (route) =>
			route.fulfill({
				json: {
					members: [
						{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName, color: null, active: true },
					],
				},
			}),
		);
		await page.route(`**${BASE}/recurring-expenses*`, (route) =>
			route.fulfill({
				json: {
					recurringExpenses: [
						{
							id: 'abo-label-audit',
							description: 'Musik-Abo',
							amountCents: 999,
							currency: 'EUR',
							paidByMemberId: FIXTURE_WG.memberId,
							intervalMonths: 1,
							nextDueAt: '2026-10-01T12:00:00.000Z',
							lastCreatedAt: null,
							pausedAt: null,
							splits: [{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 999 }],
						},
					],
				},
			}),
		);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/abos`);
		await page.getByRole('button', { name: /Details öffnen: Musik-Abo/ }).click();

		// WCAG 2.5.3 — "Pausieren"/"Fortsetzen" must lead the accessible name,
		// disambiguated by the subscription's description.
		await expect(
			page.getByRole('button', { name: 'Pausieren: Musik-Abo', exact: true }),
		).toBeVisible();
	});

	test('expense settle button names the visible action first, then the debtor', async ({
		page,
	}) => {
		const { memberId, memberName, shareCode } = FIXTURE_WG;
		const otherMemberId = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';
		await setupMember(page);
		await page.route(`**/api/wg/${shareCode}/members`, (route) =>
			route.fulfill({
				json: {
					members: [
						{ id: memberId, name: memberName, color: null, active: true },
						{ id: otherMemberId, name: 'Mina', color: null, active: true },
					],
					viewerIsAdmin: false,
				},
			}),
		);
		await page.route(`**/api/wg/${shareCode}/expenses`, (route) =>
			route.fulfill({
				json: {
					expenses: [
						{
							id: 'expense-label-audit',
							paidByMemberId: memberId,
							amountCents: 2000,
							currency: 'EUR',
							description: 'Wocheneinkauf',
							imageUrl: null,
							occurredAt: '2026-09-24T17:00:00.000Z',
							createdAt: '2026-09-24T17:00:00.000Z',
							updatedAt: '2026-09-24T17:00:00.000Z',
							splits: [
								{
									id: 'split-label-audit',
									debtorMemberId: otherMemberId,
									amountCents: 1000,
									settledAt: null,
								},
							],
						},
					],
					payments: [],
				},
			}),
		);
		await page.route(`**/api/wg/${shareCode}/recurring-expenses`, (route) =>
			route.fulfill({ json: { recurringExpenses: [] } }),
		);
		await page.route(`**/api/wg/${shareCode}/dashboard`, (route) =>
			route.fulfill({ json: { openShoppingCount: 0, dueChores: [], dueRecurringExpenses: [] } }),
		);
		await mockUnreadCount(page, `/api/wg/${shareCode}`);

		await navigateToFeature(page, `/wg/${shareCode}/ausgaben`);
		await dismissOnboarding(page);
		await page.getByRole('button', { name: /Details öffnen/ }).click();

		// WCAG 2.5.3 — "Als bezahlt eintragen"/"Wieder öffnen" must lead the
		// accessible name, disambiguated by the debtor's name.
		await expect(
			page.getByRole('button', { name: 'Als bezahlt eintragen: Mina', exact: true }),
		).toBeVisible();
	});
});

test.describe('enter key hint forms', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	// Regression: these free-text fields had no enterKeyHint, so the on-screen
	// keyboard's action key showed the generic "return" glyph instead of a
	// next/done affordance (Apple HIG / Material 3 text input guidance).
	const { shareCode, memberId, memberName } = FIXTURE_WG;

	test('inventory add name field hints "next"', async ({ page }) => {
		await setupMember(page);
		await page.route(`**/api/wg/${shareCode}/inventory*`, (route) =>
			route.request().method() === 'GET'
				? route.fulfill({ json: { items: [], grouped: {} } })
				: route.continue(),
		);

		await navigateToFeature(page, `/wg/${shareCode}/vorraete`);
		await dismissOnboarding(page);
		await page.getByRole('button', { name: 'Vorrat hinzufügen', exact: true }).first().click();

		await expect(page.locator('#inventory-name')).toHaveAttribute('enterkeyhint', 'next');
	});

	test('abo description and amount fields hint "next"', async ({ page }) => {
		await setupMember(page);
		await page.route(`**/api/wg/${shareCode}/recurring-expenses*`, (route) =>
			route.request().method() === 'GET'
				? route.fulfill({ json: { recurringExpenses: [] } })
				: route.continue(),
		);

		await navigateToFeature(page, `/wg/${shareCode}/abos`);
		await dismissOnboarding(page);
		await page.getByRole('button', { name: 'Fixkosten hinzufügen' }).click();
		await expect(page.getByRole('dialog', { name: 'Neue Fixkosten' })).toBeVisible();

		await expect(page.locator('#abo-description')).toHaveAttribute('enterkeyhint', 'next');
		await expect(page.locator('#abo-amount')).toHaveAttribute('enterkeyhint', 'next');
	});

	test('chore title field hints "done"', async ({ page }) => {
		await setupMember(page);
		await page.route(`**/api/wg/${shareCode}/chores*`, (route) =>
			route.request().method() === 'GET'
				? route.fulfill({ json: { chores: [] } })
				: route.continue(),
		);
		await page.route(`**/api/wg/${shareCode}/absences*`, (route) =>
			route.request().method() === 'GET'
				? route.fulfill({ json: { absences: [] } })
				: route.continue(),
		);

		await navigateToFeature(page, `/wg/${shareCode}/putzen`);
		await dismissOnboarding(page);
		await page.getByRole('button', { name: 'Putzaufgabe hinzufügen', exact: true }).click();

		await expect(page.locator('#chore-title')).toHaveAttribute('enterkeyhint', 'done');
	});

	test('absence reason field hints "done"', async ({ page }) => {
		await setupMember(page);
		await page.route(`**/api/wg/${shareCode}/chores*`, (route) =>
			route.request().method() === 'GET'
				? route.fulfill({ json: { chores: [] } })
				: route.continue(),
		);
		await page.route(`**/api/wg/${shareCode}/absences*`, (route) =>
			route.request().method() === 'GET'
				? route.fulfill({ json: { absences: [] } })
				: route.continue(),
		);

		await navigateToFeature(page, `/wg/${shareCode}/putzen?panel=absences`);
		await dismissOnboarding(page);
		// `?panel=absences` already opens the form (button reads "...schließen").

		await expect(page.locator('#absence-reason')).toHaveAttribute('enterkeyhint', 'done');
	});

	test('expense description and amount fields hint "next"', async ({ page }) => {
		await setupMember(page);
		await page.route(`**/api/wg/${shareCode}/members*`, (route) =>
			route.fulfill({
				json: { members: [{ id: memberId, name: memberName, color: null, active: true }] },
			}),
		);
		await page.route(`**/api/wg/${shareCode}/expenses*`, (route) =>
			route.request().method() === 'GET'
				? route.fulfill({ json: { expenses: [], payments: [] } })
				: route.continue(),
		);
		await page.route(`**/api/wg/${shareCode}/recurring-expenses*`, (route) =>
			route.request().method() === 'GET'
				? route.fulfill({ json: { recurringExpenses: [] } })
				: route.continue(),
		);
		await page.route(`**/api/wg/${shareCode}/dashboard*`, (route) =>
			route.fulfill({ json: { openShoppingCount: 0, dueChores: [], dueRecurringExpenses: [] } }),
		);

		await navigateToFeature(page, `/wg/${shareCode}/ausgaben`);
		await dismissOnboarding(page);
		// The bottom button opens the form.
		await page
			.locator('[data-page-primary-action]')
			.getByRole('button', { name: 'Ausgabe hinzufügen' })
			.click();

		await expect(page.locator('#expense-description')).toHaveAttribute('enterkeyhint', 'next');
		await expect(page.locator('#f-betrag')).toHaveAttribute('enterkeyhint', 'next');
	});

	test('legacy account recovery share code field hints "done"', async ({ page }) => {
		await page.route('**/api/wg/mine', (route) =>
			route.fulfill({ status: 200, json: { wgs: [] } }),
		);
		// The section only appears when this device holds a legacy profile with a recovery token.
		await page.addInitScript(() => {
			const uuid = (n: string) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`;
			localStorage.setItem(
				`manawg_identity:${uuid('a')}`,
				JSON.stringify({ memberId: uuid('b'), name: 'Anna', memberToken: 'token' }),
			);
		});

		await page.goto('/neu');
		await page
			.getByRole('button', { name: 'Altes Profil auf diesem Gerät wiederherstellen' })
			.click();

		await expect(page.locator('#legacy-recovery-share-code')).toHaveAttribute(
			'enterkeyhint',
			'done',
		);
	});
});

test.describe('enter key next field', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	// Regression: a field whose keyboard key reads "next" submitted the whole form
	// and flagged the still-empty fields below it.
	test('the "next" key moves to the following field instead of submitting', async ({ page }) => {
		await mockNoWgs(page);
		let submitted = false;
		await page.route('**/api/wg', (route) => {
			if (route.request().method() === 'POST') submitted = true;
			return route.fulfill({ status: 500, json: { error: 'unexpected' } });
		});

		await page.goto('/neu');
		await page.getByRole('button', { name: 'Neue WG erstellen', exact: true }).click();
		const wgName = page.getByLabel('WG-Name');
		await expect(wgName).toHaveAttribute('enterkeyhint', 'next');
		await wgName.fill('Sonnenallee');
		await wgName.press('Enter');

		await expect(page.getByLabel('Dein Anzeigename')).toBeFocused();
		await expect(page.locator('#create-wg-error, #create-wg-form-error')).toHaveCount(0);
		expect(submitted).toBe(false);
	});
});
