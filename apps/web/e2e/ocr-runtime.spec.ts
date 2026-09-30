import { type Page, type Response, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

const OCR_LANGUAGE_DATA_URLS = [
	'https://cdn.jsdelivr.net/npm/@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz',
	'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
];
// Tesseract.js-core 5.1.1 tries an optional fetch of its embedded WASM data URI.
// WebKit blocks it via connect-src, then successfully falls back to decoding
// the same bytes. Match only that exact message and WASM magic prefix; do not
// permit data: URLs in CSP.
const WEBKIT_WASM_DATA_CSP_MESSAGE =
	'Refused to connect to data:application/octet-stream;base64,<embedded-wasm> because it does not appear in the connect-src directive of the Content Security Policy.';
const WEBKIT_WASM_DATA_CSP_PATTERN =
	/^Refused to connect to data:application\/octet-stream;base64,(AGFzbQE[A-Za-z0-9+/=]*(?:\.{3}[A-Za-z0-9+/=]*)?) because it does not appear in the connect-src directive of the Content Security Policy\.$/;

function isExpectedWebKitWasmDataCsp(message: string): boolean {
	return WEBKIT_WASM_DATA_CSP_PATTERN.test(message.trimEnd());
}

const IMPORT_PATH = `/wg/${FIXTURE_WG.shareCode}/import`;
const FIXTURE_ENV_ENABLED =
	process.env.E2E_FIXTURE_MODE === 'true' &&
	process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE === 'true' &&
	process.env.NEXT_PUBLIC_DB_DOWN === 'true' &&
	process.env.PLAYWRIGHT_USE_BUILD === 'true';

test.skip(
	process.env.OCR_RUNTIME_E2E !== 'true' || !FIXTURE_ENV_ENABLED,
	'OCR runtime proof is opt-in: set OCR_RUNTIME_E2E=true with the production fixture build. The real Tesseract worker, WASM core, and German/English models require public access to cdn.jsdelivr.net.',
);
test.use({ serviceWorkers: 'block' });

interface NetworkEvidence {
	cdnResponses: Map<string, number>;
	cspViolations: string[];
	pageErrors: string[];
	apiWrites: string[];
}

function observeNetwork(page: Page): NetworkEvidence {
	const evidence: NetworkEvidence = {
		cdnResponses: new Map(),
		cspViolations: [],
		pageErrors: [],
		apiWrites: [],
	};

	page.context().on('response', (response) => {
		if (response.url().startsWith('https://cdn.jsdelivr.net/')) {
			evidence.cdnResponses.set(response.url(), response.status());
		}
	});
	page.context().on('request', (request) => {
		if (request.method() === 'GET') return;
		const path = new URL(request.url()).pathname;
		if (path.startsWith('/api/')) {
			evidence.apiWrites.push(`${request.method()} ${path}`);
		}
	});
	page.on('console', (message) => {
		if (
			message.type() === 'error' &&
			/Content Security Policy|Refused to (?:compile|load|execute)/i.test(message.text())
		) {
			const text = message.text();
			if (isExpectedWebKitWasmDataCsp(text)) {
				evidence.cspViolations.push(WEBKIT_WASM_DATA_CSP_MESSAGE);
			} else {
				evidence.cspViolations.push(
					text.length > 512 ? `${text.slice(0, 256)}…${text.slice(-256)}` : text,
				);
			}
		}
	});
	page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
	return evidence;
}

function cspSources(policy: string, name: string): string[] {
	const directive = policy
		.split(';')
		.map((entry) => entry.trim())
		.find((entry) => entry.startsWith(`${name} `));
	return directive?.slice(name.length).trim().split(/\s+/) ?? [];
}

function expectStrictOcrPolicy(response: Response): void {
	const csp = response.headers()['content-security-policy'];
	expect(csp).toBeTruthy();
	const scriptSrc = cspSources(csp ?? '', 'script-src');
	const connectSrc = cspSources(csp ?? '', 'connect-src');

	expect(scriptSrc).toContain("'wasm-unsafe-eval'");
	expect(scriptSrc).not.toContain("'unsafe-eval'");
	expect(connectSrc).toContain(OCR_LANGUAGE_DATA_URLS[0]);
	expect(connectSrc).toContain(OCR_LANGUAGE_DATA_URLS[1]);
	expect(connectSrc).not.toContain('https://cdn.jsdelivr.net');
}

function expectOnlyExpectedCspViolations(violations: readonly string[], browserName: string): void {
	const unexpected = violations.filter(
		(message) => browserName !== 'webkit' || message !== WEBKIT_WASM_DATA_CSP_MESSAGE,
	);
	expect(unexpected).toEqual([]);
}

async function openOcrImport(page: Page): Promise<Response> {
	await setupMember(page);
	const documentResponse = page.waitForResponse(
		(response) =>
			response.request().resourceType() === 'document' &&
			new URL(response.url()).pathname === IMPORT_PATH,
	);
	await navigateToFeature(page, IMPORT_PATH);
	await dismissOnboarding(page);
	const response = await documentResponse;
	expect(response.status()).toBe(200);
	expectStrictOcrPolicy(response);

	await page.getByRole('button', { name: /Screenshot/i }).click();
	await expect(page.locator('#import-screenshot')).toBeVisible();
	return response;
}

async function uploadSyntheticReceipt(page: Page): Promise<void> {
	const base64 = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 1000;
		canvas.height = 600;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas 2D context unavailable');
		context.fillStyle = '#fff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.fillStyle = '#000';
		context.font = '38px Arial';
		['TEST RECEIPT', '27.09.2026', 'Milch 2,50 EUR', 'Brot 3,20 EUR', 'TOTAL 5,70 EUR'].forEach(
			(line, index) => context.fillText(line, 60, 85 + index * 85),
		);
		return canvas.toDataURL('image/png').split(',')[1] ?? '';
	});
	if (!base64) throw new Error('Synthetic receipt PNG was not generated');
	await page.locator('#import-screenshot').setInputFiles({
		name: 'synthetic-receipt.png',
		mimeType: 'image/png',
		buffer: Buffer.from(base64, 'base64'),
	});
}

function expectTesseractAssets(cdnResponses: Map<string, number>): void {
	const urls = [...cdnResponses.keys()];
	const paths = urls.map((url) => new URL(url).pathname);
	const workerPath = '/npm/tesseract.js@v5.1.1/dist/worker.min.js';
	const corePath = /^\/npm\/tesseract\.js-core@v5\.1\.1\/tesseract-core(?:-[^/]+)?\.wasm\.js$/;
	const deuPath = new URL(OCR_LANGUAGE_DATA_URLS[0]).pathname;
	const engPath = new URL(OCR_LANGUAGE_DATA_URLS[1]).pathname;

	expect(paths).toContain(workerPath);
	expect(paths.some((path) => corePath.test(path))).toBe(true);
	expect(paths).toContain(deuPath);
	expect(paths).toContain(engPath);
	for (const path of [workerPath, deuPath, engPath]) {
		const url = `https://cdn.jsdelivr.net${path}`;
		expect(cdnResponses.get(url), `${url} returns HTTP 200`).toBe(200);
	}
	const coreUrl = urls.find((url) => corePath.test(new URL(url).pathname));
	expect(coreUrl).toBeTruthy();
	expect(cdnResponses.get(coreUrl ?? '')).toBe(200);
}

test('real Tesseract recognizes a local receipt under the strict CSP', async ({
	page,
	browserName,
}) => {
	test.setTimeout(90_000);
	const evidence = observeNetwork(page);
	await openOcrImport(page);
	await uploadSyntheticReceipt(page);

	const recognizedData = page.locator('#import-ocr');
	await expect.poll(() => recognizedData.inputValue(), { timeout: 55_000 }).toContain('TOTAL');
	const recognizedText = await recognizedData.inputValue();
	expect(recognizedText).toMatch(/Milch/i);
	expect(recognizedText).toContain('5,70');
	await expect(
		page.getByText('Bild wird ausgewertet. Das kann 30 Sekunden dauern.', { exact: true }),
	).toHaveCount(0);

	expectTesseractAssets(evidence.cdnResponses);
	expectOnlyExpectedCspViolations(evidence.cspViolations, browserName);
	expect(evidence.pageErrors).toEqual([]);
	expect(evidence.apiWrites).toEqual([]);
});

test('blocked Tesseract language downloads show bounded recovery guidance', async ({
	page,
	browserName,
}) => {
	test.setTimeout(75_000);
	const blockedModelRequests: string[] = [];
	for (const url of OCR_LANGUAGE_DATA_URLS) {
		await page.context().route(url, (route) => {
			blockedModelRequests.push(route.request().url());
			return route.abort();
		});
	}
	const evidence = observeNetwork(page);
	await openOcrImport(page);
	await uploadSyntheticReceipt(page);

	const recovery = page.getByText(/Texterkennung konnte nicht (geladen|initialisiert) werden/);
	await expect(recovery).toBeVisible({ timeout: 45_000 });
	const recoveryText = (await recovery.textContent()) ?? '';
	expect(recoveryText).toMatch(/Internetverbindung/);
	expect(recoveryText).toMatch(/lade die Seite neu|versuche es erneut/i);
	await expect(page.locator('#import-screenshot')).toBeEnabled();
	await expect(
		page.getByText('Bild wird ausgewertet. Das kann 30 Sekunden dauern.', { exact: true }),
	).toHaveCount(0);

	expect(blockedModelRequests.length).toBeGreaterThan(0);
	expectOnlyExpectedCspViolations(evidence.cspViolations, browserName);
	expect(evidence.apiWrites).toEqual([]);
});
