import { expect, test } from '@playwright/test';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

test('a removed absence stays removed when a chore completion updates the cache', async ({
	page,
}) => {
	const shareCode = 'MTE8PZAT';
	const memberId = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
	const absence = {
		id: 'absence-holiday',
		memberId,
		memberName: 'Alex',
		startDate: '2026-01-01T00:00:00.000Z',
		endDate: '2099-12-31T00:00:00.000Z',
		reason: 'Urlaub',
	};
	let absences = [absence];
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/chores`, (route) =>
		route.fulfill({
			json: {
				chores: [
					{
						id: 'chore-bath',
						title: 'Bad putzen',
						intervalDays: 7,
						recurrenceType: 'days',
						nextDueAt: new Date().toISOString(),
						assignedMemberId: memberId,
						lastCompletedAt: null,
						lastCompletedByName: null,
						openGapCountForAssignee: 0,
					},
				],
				monthCompletions: {},
			},
		}),
	);
	await page.route(`**/api/wg/${shareCode}/absences`, (route) =>
		route.fulfill({ json: { absences } }),
	);
	await page.route(`**/api/wg/${shareCode}/absences/${absence.id}`, (route) => {
		absences = [];
		return route.fulfill({ json: {} });
	});
	await page.route(`**/api/wg/${shareCode}/chores/chore-bath/complete`, (route) =>
		route.fulfill({ status: 503, json: { error: 'server_error' } }),
	);

	await navigateToFeature(page, `/wg/${shareCode}/putzen`);
	await dismissOnboarding(page);
	const absenceRow = page.locator(`#absence-${absence.id}`);
	await absenceRow.getByRole('button', { name: /entfernen$/ }).click();
	await absenceRow.getByRole('button', { name: /endgültig entfernen$/ }).click();
	await expect(absenceRow).toHaveCount(0);

	await page.getByRole('button', { name: 'Als erledigt markieren: Bad putzen' }).click();
	await page.getByRole('button', { name: 'Erledigt bestätigen: Bad putzen' }).click();
	await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText(
		'Erledigt-Aktion konnte nicht gespeichert werden',
	);
	await expect(absenceRow).toHaveCount(0);
});

test('an armed absence removal can be cancelled without deleting it', async ({ page }) => {
	const shareCode = 'MTE8PZAT';
	const memberId = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
	const absence = {
		id: 'absence-holiday',
		memberId,
		memberName: 'Alex',
		startDate: '2026-01-01T00:00:00.000Z',
		endDate: '2099-12-31T00:00:00.000Z',
		reason: 'Urlaub',
	};
	let deleteCalls = 0;
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/chores`, (route) =>
		route.fulfill({ json: { chores: [], monthCompletions: {} } }),
	);
	await page.route(`**/api/wg/${shareCode}/absences`, (route) =>
		route.fulfill({ json: { absences: [absence] } }),
	);
	await page.route(`**/api/wg/${shareCode}/absences/${absence.id}`, (route) => {
		deleteCalls += 1;
		return route.fulfill({ json: {} });
	});

	await navigateToFeature(page, `/wg/${shareCode}/putzen`);
	await dismissOnboarding(page);
	const absenceRow = page.locator(`#absence-${absence.id}`);
	await absenceRow.getByRole('button', { name: /entfernen$/ }).click();
	await expect(absenceRow.getByRole('button', { name: /endgültig entfernen$/ })).toBeVisible();
	await absenceRow.getByRole('button', { name: /abbrechen$/ }).click();

	await expect(absenceRow.getByRole('button', { name: /endgültig entfernen$/ })).toHaveCount(0);
	await expect(absenceRow).toBeVisible();
	expect(deleteCalls).toBe(0);
});
