import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

test('native share success does not mark the invite link as copied', async ({ page }) => {
	// Stub the Web Share API so `nativeShare()` takes its success branch instead
	// of falling back to clipboard copy.
	await page.addInitScript(() => {
		Object.defineProperty(window.navigator, 'share', {
			configurable: true,
			value: () => Promise.resolve(),
		});
	});
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);

	const linkButton = page.getByRole('button', { name: 'Einladungslink kopieren' });
	await expect(linkButton).toBeVisible();
	const shareButton = page.getByRole('button', { name: 'WG-Einladung teilen' });
	await shareButton.click();

	// A real share (not a clipboard copy) must not relabel the link row or
	// swap its icon to a checkmark — nothing was copied.
	await expect(page.getByRole('button', { name: 'Link kopiert' })).toHaveCount(0);
	await expect(linkButton).toBeVisible();

	// The generic "ready" note is still fine to show after a successful share.
	await expect(page.getByText('Einladungslink bereit.')).toBeVisible();
});

test('deactivating another member shows their open balances and succeeds', async ({ page }) => {
	const otherMember = { id: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55', name: 'Mina' };
	await setupMember(page);

	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/members`, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		return route.fulfill({
			json: {
				members: [
					{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName, color: null, active: true },
					{ id: otherMember.id, name: otherMember.name, color: null, active: true },
				],
				viewerIsAdmin: true,
			},
		});
	});
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/members/${otherMember.id}`, async (route) => {
		const method = route.request().method();
		if (method === 'GET') {
			return route.fulfill({
				json: {
					member: { id: otherMember.id, name: otherMember.name, active: true },
					openBalances: [
						{
							member_id: FIXTURE_WG.memberId,
							name: FIXTURE_WG.memberName,
							amount_cents: 1250,
							currency: 'EUR',
							direction: 'owed',
						},
					],
				},
			});
		}
		if (method === 'PATCH') {
			return route.fulfill({
				json: { member: { id: otherMember.id, name: otherMember.name, active: false } },
			});
		}
		return route.fallback();
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);
	await page.getByRole('button', { name: `Ausziehen: ${otherMember.name}` }).click();

	await expect(page.getByRole('heading', { name: `${otherMember.name} ausziehen?` })).toBeVisible();
	// direction "owed" from Mina's perspective: the viewer (dsaf) owes her.
	await expect(page.getByText(`${FIXTURE_WG.memberName} schuldet`)).toBeVisible();

	const confirmButton = page.getByRole('button', { name: 'Ausziehen', exact: true });
	await expect(confirmButton).toBeEnabled();
	await confirmButton.click();

	await expect(
		page.getByText(`${otherMember.name} ist jetzt als ausgezogen markiert.`),
	).toBeVisible();
});

test('reactivating a former member keeps their name at the start of the accessible label', async ({
	page,
}) => {
	const otherMember = { id: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55', name: 'Mina' };
	await setupMember(page);

	let reactivated = false;
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/members`, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		return route.fulfill({
			json: {
				members: [
					{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName, color: null, active: true },
					{ id: otherMember.id, name: otherMember.name, color: null, active: reactivated },
				],
				viewerIsAdmin: true,
			},
		});
	});
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/members/${otherMember.id}`, async (route) => {
		if (route.request().method() !== 'PATCH') return route.fallback();
		reactivated = true;
		return route.fulfill({
			json: { member: { id: otherMember.id, name: otherMember.name, active: true } },
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);
	// WCAG 2.5.3 — the visible "Aktivieren" label must stay at the start of the
	// accessible name, disambiguated by the affected member's name.
	await page.getByRole('button', { name: `Aktivieren: ${otherMember.name}`, exact: true }).click();

	await expect(page.getByText(`${otherMember.name} ist wieder aktiv.`)).toBeVisible();
});

test('cancelling "WG verlassen" returns focus to its button', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/members`, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		return route.fulfill({
			json: {
				members: [
					{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName, color: null, active: true },
					{ id: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55', name: 'Mina', color: null, active: true },
				],
				viewerIsAdmin: false,
			},
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);
	const leave = page.getByRole('button', { name: 'WG verlassen', exact: true });
	await leave.click();

	// WCAG 2.5.3 — the visible "Abbrechen"/"Verlassen" labels must stay at the
	// start of the accessible name, disambiguated by the self-leave action.
	const cancel = page.getByRole('button', { name: 'Abbrechen: WG verlassen', exact: true });
	await expect(cancel).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Verlassen: WG auf diesem Gerät verlassen', exact: true }),
	).toBeVisible();
	await cancel.click();

	await expect(leave).toBeFocused();
});
