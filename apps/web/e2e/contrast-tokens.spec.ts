import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

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
	function parseToLinearSrgb(str: string) {
		const oklchM = str.match(/oklch\(([^)]+)\)/);
		const oklabM = str.match(/oklab\(([^)]+)\)/);
		const rgbM = str.match(/rgba?\(([^)]+)\)/);
		const oklchOrOklabM = oklchM ?? oklabM;
		if (oklchOrOklabM) {
			const raw = oklchOrOklabM[1];
			const [main, alphaPart] = raw.split('/').map((s) => s.trim());
			const nums = main.split(/\s+/).map((s) => Number.parseFloat(s));
			const a = alphaPart ? Number.parseFloat(alphaPart) : 1;
			let L: number;
			let A: number;
			let B: number;
			if (oklchM) {
				const [l, c, h] = nums;
				L = l;
				A = c * Math.cos((h * Math.PI) / 180);
				B = c * Math.sin((h * Math.PI) / 180);
			} else {
				[L, A, B] = nums;
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
			const parts = rgbM[1].split(',').map((s) => Number.parseFloat(s.trim()));
			const srgbToLinear = (v: number) => {
				const c = v / 255;
				return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			};
			return {
				r: srgbToLinear(parts[0]),
				g: srgbToLinear(parts[1]),
				b: srgbToLinear(parts[2]),
				a: parts.length > 3 ? parts[3] : 1,
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
	const backdrop = args.against ? parseToLinearSrgb(nearestOpaqueBg(el.parentElement ?? el)) : null;
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
