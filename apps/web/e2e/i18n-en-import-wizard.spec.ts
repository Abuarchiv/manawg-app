// English expense import wizard (Splitwise, Splid, screenshot) and its history.
// Why: every wizard step, error and the undo flow must read as English at phone widths.

import { expect, type Page, test } from '@playwright/test';
import {
	dismissOnboarding,
	FIXTURE_WG,
	navigateToFeature,
	setupMember,
	skipUnlessFixtures,
} from './support/helpers';
import { expectNoGermanChrome, expectNoHorizontalOverflow, setEnglishLocale } from './support/i18n';

const BASE = `/wg/${FIXTURE_WG.shareCode}`;
const API = `**/api/wg/${FIXTURE_WG.shareCode}`;
const UNKNOWN = '\u001F';

const previewBody = {
	parsed: [
		{
			date: '2026-03-25T12:00:00.000Z',
			description: 'Weekly shop',
			amountCents: 1250,
			currency: 'EUR',
			paidByName: FIXTURE_WG.memberName,
			splits: [{ memberName: FIXTURE_WG.memberName, amountCents: 1250 }],
			warnings: ['custom_splits_drift_adjusted'],
		},
		{
			date: '2026-03-26T12:00:00.000Z',
			description: 'Pizza',
			amountCents: 2480,
			currency: 'EUR',
			paidByName: UNKNOWN,
			splits: [{ memberName: UNKNOWN, amountCents: 2480 }],
			warnings: ['ocr_heuristic', 'unknown_columns_ignored:Notes|Tags'],
		},
	],
	payloadHash: 'en-import-payload',
	memberMapping: { [FIXTURE_WG.memberName]: FIXTURE_WG.memberId, [UNKNOWN]: null },
	conflicts: [UNKNOWN],
	members: [{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName }],
	rejected: [{ line: 4, reason: 'amount_invalid', description: 'Rent' }],
};

async function openWizard(page: Page): Promise<void> {
	await navigateToFeature(page, `${BASE}/import`);
	await dismissOnboarding(page);
}

async function mockHistory(page: Page, imports: unknown[] = []): Promise<void> {
	await page.route(`${API}/imports`, (route) => route.fulfill({ json: { imports } }));
}

async function pasteExport(page: Page): Promise<void> {
	await page.getByRole('button', { name: /Splitwise CSV/ }).click();
	await expect(page.getByRole('heading', { name: 'Choose the export file' })).toBeVisible();
	await page.getByText('Or paste the contents', { exact: true }).click();
	await page.getByRole('textbox', { name: 'Export contents' }).fill('fixture export');
}

test.describe('English expense import', () => {
	skipUnlessFixtures();

	for (const width of [320, 390]) {
		for (const colorScheme of ['light', 'dark'] as const) {
			test(`the wizard reads English from source to result at ${width}px ${colorScheme}`, async ({
				context,
				page,
				baseURL,
			}) => {
				await setEnglishLocale(context, baseURL ?? 'http://localhost:3111');
				await page.setViewportSize({ width, height: 844 });
				await page.emulateMedia({ colorScheme });
				await setupMember(page);
				await mockHistory(page);
				await page.route(`${API}/imports/preview`, (route) => route.fulfill({ json: previewBody }));
				await page.route(`${API}/imports/commit`, (route) =>
					route.fulfill({
						json: {
							importId: 'en-import',
							inserted: 1,
							skipped: 0,
							errors: [{ index: 1, reason: 'payer_unmapped' }],
							warning: 'notification_delivery_failed',
						},
					}),
				);
				await openWizard(page);

				await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
				await expect(page).toHaveTitle(/Import expenses/);
				await expect(
					page.getByRole('heading', { level: 1, name: 'Import expenses' }),
				).toBeVisible();
				await expect(page.getByText('Step 1 of 5')).toBeVisible();
				await expect(page.getByRole('heading', { name: 'Choose an import source' })).toBeVisible();
				await expect(page.getByRole('button', { name: /File from Splitwise/ })).toBeVisible();
				await expect(page.getByRole('button', { name: /Photo or screenshot/ })).toBeVisible();
				await expectNoGermanChrome(page);
				await expectNoHorizontalOverflow(page);

				await pasteExport(page);
				await expect(page.getByText('Step 2 of 5')).toBeVisible();
				await expect(page.getByText('Export file up to 5 MB.')).toBeVisible();
				await expect(page.getByRole('button', { name: 'Create preview' })).toBeEnabled();
				await expectNoGermanChrome(page);
				await expectNoHorizontalOverflow(page);

				await page.getByRole('button', { name: 'Create preview', exact: true }).click();
				await expect(page.getByRole('heading', { name: 'Match names to flatmates' })).toBeVisible();
				await expect(page.getByText('Match the names that are still open.')).toBeVisible();
				const unknown = page.getByRole('combobox', { name: 'Choose flatmate for Unknown' });
				await expect(unknown).toBeVisible();
				await expect(unknown.getByRole('option', { name: 'Not matched yet' })).toBeAttached();
				await expect(unknown.getByRole('option', { name: 'Leave out (skip rows)' })).toBeAttached();
				await page.getByRole('button', { name: 'Continue to preview', exact: true }).click();
				await expect(page.getByText('Choose a flatmate.')).toBeVisible();
				await unknown.selectOption(FIXTURE_WG.memberId);
				await expectNoGermanChrome(page);
				await expectNoHorizontalOverflow(page);

				await page.getByRole('button', { name: 'Continue to preview', exact: true }).click();
				await expect(page.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible();
				await expect(page.getByText('2 selected')).toBeVisible();
				await expect(page.getByText('Check amounts and shares.')).toBeVisible();
				await expect(page.getByText('1 row could not be read')).toBeVisible();
				await page.getByText('Show details').click();
				await expect(page.getByText('Row 4: Rent (Amount not readable)')).toBeVisible();
				await expect(page.getByText('25 Mar 2026')).toBeVisible();
				await expect(page.getByText('€12.50').first()).toBeVisible();
				await expect(page.getByText('€24.80').first()).toBeVisible();
				await expect(page.getByText(/paid by/).first()).toBeVisible();
				await expect(
					page.getByText(
						'The split differed slightly from the total and was adjusted automatically.',
					),
				).toBeVisible();
				await expect(
					page.getByText('Columns “Notes”, “Tags” were not recognised and ignored.'),
				).toBeVisible();
				await expect(page.getByText('Skip duplicates')).toBeVisible();
				await expect(page.getByRole('list', { name: 'Split' }).first()).toBeAttached();
				await expectNoGermanChrome(page);
				await expectNoHorizontalOverflow(page);

				await page.getByRole('button', { name: 'Import (2)', exact: true }).click();
				await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
				await expect(page.getByText('1 imported · 0 skipped · 1 error')).toBeVisible();
				await expect(page.getByText('Notification notice')).toBeVisible();
				await expect(
					page.getByText(
						'The import was saved, but the flat notification could not be delivered to everyone.',
					),
				).toBeVisible();
				await expect(page.getByText('Entries not imported')).toBeVisible();
				await expect(
					page.getByText(
						'Entry 2 (Pizza, 26 Mar 2026, €24.80): The payer could not be matched. Check the matches.',
					),
				).toBeVisible();
				await expect(page.getByRole('button', { name: 'Check matches' })).toBeVisible();
				await expect(page.getByRole('button', { name: 'Undo import' })).toBeVisible();
				await expect(page.getByRole('link', { name: 'Go to expenses' })).toBeVisible();
				await expectNoGermanChrome(page);
				await expectNoHorizontalOverflow(page);
			});
		}
	}

	test('the screenshot source and its input step read English', async ({
		context,
		page,
		baseURL,
	}) => {
		await setEnglishLocale(context, baseURL ?? 'http://localhost:3111');
		await page.setViewportSize({ width: 390, height: 844 });
		await setupMember(page);
		await mockHistory(page);
		await openWizard(page);

		await page.getByRole('button', { name: /Photo or screenshot/ }).click();
		await expect(page.getByRole('heading', { name: 'Add an image' })).toBeVisible();
		await expect(page.getByLabel('Choose screenshot')).toBeAttached();
		await expect(page.getByText('Choose image', { exact: true })).toBeVisible();
		await expect(
			page.getByText('Photo or screenshot up to 10 MB. Only euro amounts (EUR) are recognised.'),
		).toBeVisible();
		await expect(page.getByText('Check or correct the result')).toBeVisible();
		await expectNoGermanChrome(page);
		await expectNoHorizontalOverflow(page);
	});

	test('the Splid source and its input step read English', async ({ context, page, baseURL }) => {
		await setEnglishLocale(context, baseURL ?? 'http://localhost:3111');
		await page.setViewportSize({ width: 390, height: 844 });
		await setupMember(page);
		await mockHistory(page);
		await openWizard(page);

		await page.getByRole('button', { name: /Splid CSV/ }).click();
		await expect(page.getByRole('heading', { name: 'Choose the export file' })).toBeVisible();
		await expect(page.getByText('Export file up to 5 MB.')).toBeVisible();
		await expectNoGermanChrome(page);
		await expectNoHorizontalOverflow(page);
	});

	test('the route error boundary reads English', async ({ context, page, baseURL }) => {
		await setEnglishLocale(context, baseURL ?? 'http://localhost:3111');
		await page.setViewportSize({ width: 390, height: 844 });
		await setupMember(page);
		await mockHistory(page);
		// A preview without `splits` makes the preview table throw while rendering.
		const broken = {
			...previewBody,
			conflicts: [],
			parsed: [{ ...previewBody.parsed[0], splits: undefined }],
		};
		await page.route(`${API}/imports/preview`, (route) => route.fulfill({ json: broken }));
		await openWizard(page);
		await pasteExport(page);
		await page.getByRole('button', { name: 'Create preview', exact: true }).click();

		await expect(
			page.getByRole('heading', { name: 'The import assistant could not be loaded' }),
		).toBeVisible();
		await expect(
			page.getByText('Something went wrong while loading the import assistant.'),
		).toBeVisible();
		await expectNoGermanChrome(page);
		await expectNoHorizontalOverflow(page);
	});

	test('a rejected preview shows English copy and a recovery action', async ({
		context,
		page,
		baseURL,
	}) => {
		await setEnglishLocale(context, baseURL ?? 'http://localhost:3111');
		await page.setViewportSize({ width: 390, height: 844 });
		await setupMember(page);
		await mockHistory(page);
		await page.route(`${API}/imports/preview`, (route) =>
			route.fulfill({
				status: 400,
				json: { error: 'payload_too_large', code: 'payload_too_large' },
			}),
		);
		await openWizard(page);
		await pasteExport(page);
		await page.getByRole('button', { name: 'Create preview', exact: true }).click();

		await expect(
			page.getByText(
				'Preview failed: The file is too large. Choose a smaller file (CSV up to 5 MB, image up to 10 MB).',
			),
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Correct the input' })).toBeVisible();
		await expectNoGermanChrome(page);
	});

	test('a file without one readable row names each rejected row', async ({
		context,
		page,
		baseURL,
	}) => {
		await setEnglishLocale(context, baseURL ?? 'http://localhost:3111');
		await page.setViewportSize({ width: 390, height: 844 });
		await setupMember(page);
		await mockHistory(page);
		await page.route(`${API}/imports/preview`, (route) =>
			route.fulfill({ json: { ...previewBody, parsed: [], memberMapping: {}, conflicts: [] } }),
		);
		await openWizard(page);
		await pasteExport(page);
		await page.getByRole('button', { name: 'Create preview', exact: true }).click();

		const error = page.locator('#import-error');
		await expect(error).toContainText('Preview failed:');
		await error.getByText('Show details', { exact: true }).click();
		await expect(error.getByText(/^Row 4: Rent \(.+\)$/)).toBeVisible();
		await expectNoGermanChrome(page);
	});

	test('leaving with typed input asks in English', async ({ context, page, baseURL }) => {
		await setEnglishLocale(context, baseURL ?? 'http://localhost:3111');
		await page.setViewportSize({ width: 390, height: 844 });
		await setupMember(page);
		await mockHistory(page);
		await openWizard(page);
		await pasteExport(page);

		await page.getByRole('link', { name: 'Back to expenses' }).click();
		const dialog = page.getByRole('alertdialog', { name: 'Discard import input?' });
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByText(
				'The data and matches entered so far are lost. No new expenses are imported.',
			),
		).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Discard' })).toBeVisible();
	});

	test('earlier imports and their undo read English', async ({ context, page, baseURL }) => {
		await setEnglishLocale(context, baseURL ?? 'http://localhost:3111');
		await page.setViewportSize({ width: 390, height: 844 });
		await setupMember(page);
		await mockHistory(page, [
			{
				id: 'imp-1',
				source: 'splitwise_csv',
				startedAt: '2026-03-03T12:00:00.000Z',
				inserted: 2,
				importedByMemberId: FIXTURE_WG.memberId,
			},
		]);
		const undoRequests: string[] = [];
		await page.route(`${API}/imports/imp-1`, (route) => {
			undoRequests.push(route.request().method());
			return route.fulfill({ json: { removed: 2 } });
		});
		await openWizard(page);

		await expect(page.getByRole('heading', { name: 'Earlier imports' })).toBeVisible();
		await expect(page.getByText(/Splitwise from 3 Mar 2026: 2 expenses/)).toBeVisible();
		await page.getByRole('button', { name: 'Undo import: Splitwise from 3 Mar 2026' }).click();
		expect(undoRequests).toEqual([]);
		await page.getByRole('button', { name: /Remove all imported expenses/ }).click();
		await expect(page.getByText('Import undone: 2 expenses removed.')).toBeVisible();
		expect(undoRequests).toEqual(['DELETE']);
		await expectNoGermanChrome(page);
	});
});
