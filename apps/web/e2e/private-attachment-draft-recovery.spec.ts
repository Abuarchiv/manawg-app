import { expect, test } from '@playwright/test';
import { buildDraftKey } from '../src/core/offline/drafts';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const SHARE_CODE = FIXTURE_WG.shareCode;
const FIRST_KEY = `manawg/${FIXTURE_WG.id}/expense/550e8400-e29b-41d4-a716-446655440001.png`;
const SECOND_KEY = `manawg/${FIXTURE_WG.id}/expense/550e8400-e29b-41d4-a716-446655440002.png`;
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/70cAAAAASUVORK5CYII=',
	'base64',
);

test('restored expense draft keeps its image preview and can recover after last-reference revocation', async ({
	page,
}) => {
	await setupMember(page);
	await page.addInitScript(() => {
		const key = '__e2e_private_attachment_csp_violations';
		if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, '[]');
		window.addEventListener('securitypolicyviolation', (event) => {
			const violations = JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[];
			violations.push(`${event.violatedDirective}: ${event.blockedURI}`);
			sessionStorage.setItem(key, JSON.stringify(violations));
		});
	});
	let uploadCount = 0;
	let oldImageUrl = '';
	let revoked = false;
	const imageReads: string[] = [];
	const storageUploadRequests: string[] = [];
	const submitted: Array<Record<string, unknown>> = [];

	await page.route(`**/api/wg/${SHARE_CODE}/expenses**`, async (route) => {
		const request = route.request();
		if (request.method() === 'GET') return route.fulfill({ json: { expenses: [], payments: [] } });
		if (request.method() !== 'POST') return route.fallback();

		const body = request.postDataJSON() as Record<string, unknown>;
		submitted.push(body);
		if (revoked && body.imageUrl === oldImageUrl) {
			return route.fulfill({
				status: 409,
				json: { error: 'image_removed', code: 'image_removed' },
			});
		}
		return route.fulfill({
			json: {
				expense: {
					...body,
					id: 'fixture-saved-expense',
					paidByMemberId: FIXTURE_WG.memberId,
					occurredAt: '2026-09-27T10:00:00.000Z',
					createdAt: '2026-09-27T10:00:00.000Z',
					updatedAt: '2026-09-27T10:00:00.000Z',
				},
				warning: null,
			},
		});
	});
	await page.route(`**/api/wg/${SHARE_CODE}/recurring-expenses**`, (route) =>
		route.fulfill({ json: { recurringExpenses: [] } }),
	);
	await page.route('**/api/upload/sign', async (route) => {
		const request = route.request();
		const key = uploadCount++ === 0 ? FIRST_KEY : SECOND_KEY;
		const publicUrl = new URL(
			`/api/upload/read?key=${encodeURIComponent(key)}`,
			new URL(request.url()).origin,
		).toString();
		const presignedUrl = new URL(
			`/__fixture_storage/upload-${uploadCount}`,
			new URL(request.url()).origin,
		).toString();
		if (!oldImageUrl) oldImageUrl = publicUrl;
		return route.fulfill({
			json: {
				presignedUrl,
				publicUrl,
				maxFileSize: 8 * 1024 * 1024,
				uploadHeaders: { 'Content-Type': 'image/png' },
			},
		});
	});
	await page.route('**/__fixture_storage/**', async (route) => {
		if (route.request().method() !== 'PUT') return route.fallback();
		storageUploadRequests.push(route.request().url());
		return route.fulfill({ status: 200 });
	});
	await page.route('**/api/upload/read?*', async (route) => {
		const key = new URL(route.request().url()).searchParams.get('key') ?? '';
		imageReads.push(key);
		if (revoked && key === FIRST_KEY) {
			return route.fulfill({ status: 404, headers: { 'Cache-Control': 'no-store' } });
		}
		return route.fulfill({
			status: 200,
			headers: { 'Cache-Control': 'no-store' },
			contentType: 'image/png',
			body: PNG,
		});
	});

	await navigateToFeature(page, `/wg/${SHARE_CODE}/ausgaben?new=1`);
	await dismissOnboarding(page);
	let form = page.getByRole('dialog');
	await form.getByLabel('Beschreibung').fill('Beleg-Entwurf');
	await form.getByLabel('Betrag').fill('12,35');
	await form.getByRole('button', { name: 'Beleg hinzufügen' }).click();
	await form.getByLabel('Bild auswählen').setInputFiles({
		name: 'beleg.png',
		mimeType: 'image/png',
		buffer: PNG,
	});
	await expect(form.getByRole('img', { name: 'Beleg hochgeladen' })).toBeVisible();
	const draftKey = buildDraftKey(SHARE_CODE, FIXTURE_WG.memberId, 'expense');
	await expect
		.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey))
		.toContain(oldImageUrl);

	await page.reload({ waitUntil: 'domcontentloaded' });
	await dismissOnboarding(page);
	form = page.getByRole('dialog');
	await expect(form.getByRole('img', { name: 'Beleg hochgeladen' })).toBeVisible();
	await expect.poll(() => imageReads.filter((key) => key === FIRST_KEY).length).toBeGreaterThan(1);

	revoked = true;
	await form.getByRole('button', { name: 'Ausgabe speichern' }).click();
	await expect(
		form.getByText(
			'Ausgabe konnte nicht gespeichert werden: Der Anhang wurde entfernt. Lade ihn erneut hoch.',
		),
	).toBeVisible();
	await expect
		.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey))
		.toContain(oldImageUrl);

	await form.getByRole('button', { name: 'Beleg entfernen' }).click();
	await form.getByLabel('Bild auswählen').setInputFiles({
		name: 'beleg-neu.png',
		mimeType: 'image/png',
		buffer: PNG,
	});
	await expect(form.getByRole('img', { name: 'Beleg hochgeladen' })).toBeVisible();
	await form.getByRole('button', { name: 'Ausgabe speichern' }).click();
	await expect.poll(() => submitted.length).toBe(2);
	await expect(form).toBeHidden();
	expect(submitted[0]?.imageUrl).toBe(oldImageUrl);
	expect(submitted[1]?.imageUrl).not.toBe(oldImageUrl);
	expect(submitted[1]?.imageUrl).toContain(encodeURIComponent(SECOND_KEY));
	expect(storageUploadRequests).toHaveLength(2);
	const cspViolations = await page.evaluate(
		() =>
			JSON.parse(
				sessionStorage.getItem('__e2e_private_attachment_csp_violations') ?? '[]',
			) as string[],
	);
	expect(cspViolations).toEqual([]);
});
