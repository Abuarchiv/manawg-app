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
		const oklchRaw = str.match(/oklch\(([^)]+)\)/)?.[1];
		const oklabRaw = str.match(/oklab\(([^)]+)\)/)?.[1];
		const rgbRaw = str.match(/rgba?\(([^)]+)\)/)?.[1];
		const colorSpaceRaw = oklchRaw ?? oklabRaw;
		if (colorSpaceRaw !== undefined) {
			const slashParts = colorSpaceRaw.split('/');
			const main = slashParts[0]?.trim();
			const alphaPart = slashParts[1]?.trim();
			if (slashParts.length > 2 || main === undefined || (slashParts.length === 2 && !alphaPart)) {
				return null;
			}
			const nums = main.split(/\s+/).map(Number);
			const alpha = alphaPart === undefined ? 1 : Number(alphaPart);
			if (nums.length !== 3 || nums.some((value) => !Number.isFinite(value))) return null;
			if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
			const first = nums[0];
			const second = nums[1];
			const third = nums[2];
			if (first === undefined || second === undefined || third === undefined) return null;
			let L: number;
			let A: number;
			let B: number;
			if (oklchRaw !== undefined) {
				L = first;
				A = second * Math.cos((third * Math.PI) / 180);
				B = second * Math.sin((third * Math.PI) / 180);
			} else {
				L = first;
				A = second;
				B = third;
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
			if (![r, g, b].every(Number.isFinite)) return null;
			return { r, g, b, a: alpha };
		}
		if (rgbRaw !== undefined) {
			const parts = rgbRaw.split(',').map((part) => Number(part.trim()));
			if (parts.length !== 3 && parts.length !== 4) return null;
			const red = parts[0];
			const green = parts[1];
			const blue = parts[2];
			const alpha = parts.length === 4 ? parts[3] : 1;
			if (
				red === undefined ||
				green === undefined ||
				blue === undefined ||
				alpha === undefined ||
				![red, green, blue, alpha].every(Number.isFinite) ||
				red < 0 ||
				red > 255 ||
				green < 0 ||
				green > 255 ||
				blue < 0 ||
				blue > 255 ||
				alpha < 0 ||
				alpha > 1
			) {
				return null;
			}
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
		await Promise.all(
			[checked, unchecked].map((switchControl) =>
				switchControl.evaluate(async (element) => {
					const thumb = element.querySelector<HTMLElement>('[data-slot="switch-thumb"]');
					if (!thumb) throw new Error('Switch thumb must be present');
					await Promise.all(thumb.getAnimations().map((animation) => animation.finished));
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
