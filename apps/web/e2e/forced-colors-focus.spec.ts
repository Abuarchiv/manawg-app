import { type Locator, type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

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
	const lightRing = await fixtureButton.evaluate((element) => getComputedStyle(element).boxShadow);
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
