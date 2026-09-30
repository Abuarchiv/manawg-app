import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

test('notification switches reject additional changes until the pending save completes', async ({
	page,
}) => {
	await setupMember(page);
	const status = {
		pushOptIn: false,
		pushConfigured: true,
		notifyAnnouncements: true,
		notifyChores: true,
		notifyExpenses: true,
		notifyReminders: true,
		notifyShopping: true,
		notifyInventory: true,
		notifyChat: true,
		notifyEvents: true,
		quietStartHour: null,
		quietEndHour: null,
	};
	let releaseSave = () => {};
	const saveGate = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});
	const patches: unknown[] = [];
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/notifications`, async (route) => {
		if (route.request().method() !== 'PATCH') return route.fulfill({ json: status });
		patches.push(route.request().postDataJSON());
		await saveGate;
		return route.fulfill({ json: { ok: true } });
	});
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#benachrichtigungen`);
	const chores = page.getByRole('switch', { name: 'Putzplan', exact: true });
	const expenses = page.getByRole('switch', { name: 'Ausgaben', exact: true });
	const push = page.getByRole('switch', { name: 'Web Push aktivieren', exact: true });
	await expect(chores).toBeEnabled();
	// Regression: the switch's <button> render target must declare type="button" (via
	// nativeButton), otherwise it silently defaults to type="submit" and would submit
	// any enclosing <form> on activation.
	await expect(chores).toHaveAttribute('type', 'button');
	await expect(expenses).toBeChecked();
	const originalThumbPosition = await expenses
		.locator('[data-slot="switch-thumb"]')
		.evaluate((thumb) => getComputedStyle(thumb).left);
	await chores.click();
	// A quick tap still plays the liquid-glass lift before the thumb settles.
	await expect(chores.locator('[data-slot="switch-thumb"]')).toHaveAttribute('data-pressed', '');
	try {
		await expect.poll(() => patches.length).toBe(1);
		await expect(chores).toBeDisabled();
		await expect(expenses).toBeDisabled();
		await expect(push).toBeDisabled();
		// Native activation must not move the thumb while its save handler is locked.
		await expenses.evaluate((button) => (button as HTMLButtonElement).click());
		await expect(expenses).toBeChecked();
	} finally {
		releaseSave();
	}
	await expect(chores).toBeEnabled();
	await expect(chores).not.toBeChecked();
	await expect(chores.locator('[data-slot="switch-thumb"]')).not.toHaveAttribute('data-pressed');
	await expect(expenses).toBeEnabled();
	await expect(expenses).toBeChecked();
	await expect(expenses.locator('[data-slot="switch-thumb"]')).toHaveCSS(
		'left',
		originalThumbPosition,
	);
	expect(patches).toEqual([{ notifyChores: false }]);
	// iOS 26 geometry: checked thumb 2.5px inside the right edge, vertically centred.
	const [button, thumb] = await Promise.all([
		expenses.boundingBox(),
		expenses.locator('[data-slot="switch-thumb"]').boundingBox(),
	]);
	if (!button || !thumb) throw new Error('switch not rendered');
	expect(button.x + button.width - (thumb.x + thumb.width)).toBeCloseTo(2.5, 1);
	expect(button.y + button.height / 2 - (thumb.y + thumb.height / 2)).toBeCloseTo(0, 1);
});
