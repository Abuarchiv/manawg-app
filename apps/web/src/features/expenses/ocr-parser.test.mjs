import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('../../..', import.meta.url));
const tesseractMockUrl = `data:text/javascript,${encodeURIComponent(
	'export const createWorker = (...args) => globalThis.__ocrTesseractMock.createWorker(...args);',
)}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const path = resolve(appRoot, 'src', `${specifier.slice(2)}.ts`);
			return nextResolve(pathToFileURL(path).href, context);
		}
		if (specifier === 'tesseract.js') return { url: tesseractMockUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});

const { OcrInitializationError, parseOcrText, runOcrOnImage } = await import('./ocr.ts');
const contextDate = '2026-09-27T00:00:00.000Z';
const reloadRequired = (error) => error instanceof OcrInitializationError && error.requiresReload;

function setTesseractMock(createWorker) {
	globalThis.__ocrTesseractMock = { createWorker };
}

function deferred() {
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function assertRejectsWithin(promise, timeoutMs, errorPattern) {
	let timer;
	try {
		await assert.rejects(
			Promise.race([
				promise,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error('Test deadline expired')), timeoutMs);
				}),
			]),
			errorPattern,
		);
	} finally {
		clearTimeout(timer);
	}
}

test('dot, comma, and correctly grouped decimal amounts become euro cents', () => {
	const amounts = [
		'Brot 12.34 EUR',
		'Brot 12,34 EUR',
		'Brot 12.34EUR',
		'Brot 12345.67 EUR',
		'Brot 12345,67 EUR',
		'Brot 1.234,56 EUR',
		'Brot 1,234.56 EUR',
	];
	assert.deepEqual(
		amounts.map((text) =>
			parseOcrText(text, contextDate).expenses.map((expense) => expense.amountCents),
		),
		[[1234], [1234], [1234], [1_234_567], [1_234_567], [123_456], [123_456]],
	);
});

test('dates are not imported as amounts and a real amount after a date remains parseable', () => {
	assert.deepEqual(parseOcrText('Datum 27.09.2026', contextDate).expenses, []);
	const [expense] = parseOcrText('Datum 27.09.2026 Brot 12.34 EUR', contextDate).expenses;
	assert.ok(expense);
	assert.equal(expense.amountCents, 1234);
	assert.equal(expense.date, '2026-09-27T00:00:00.000Z');
});

test('partial, malformed-grouping, over-precision, and over-limit tokens are rejected whole', () => {
	for (const text of [
		'Brot 12,345 EUR',
		'Brot 12.345 EUR',
		'Brot 1234.567 EUR',
		'Brot 1.23.4,56 EUR',
		'Brot 1,23,4.56 EUR',
		'Brot 1\u00a0234,56 EUR',
		'Brot 1\u202f234.56 EUR',
		"Brot 1'234.56 EUR",
		'Brot 1 234,56 EUR',
		'Brot 1  234,56 EUR',
		'Brot 1\u00a0\u00a0234,56 EUR',
		'Brot 12 34,56 EUR',
		'Brot 1234 567,89 EUR',
		'Brot 1000000.01 EUR',
		'Brot123,45 EUR',
		'Brot 123,45X EUR',
	]) {
		assert.deepEqual(parseOcrText(text, contextDate).expenses, [], text);
	}
});

test('signed, foreign-currency, and percentage tokens are not treated as EUR amounts', () => {
	for (const text of [
		'Brot -12,34 EUR',
		'Brot - 12,34 EUR',
		'Brot 12,34- EUR',
		'Brot 12,34 - EUR',
		'Brot −12,34 EUR',
		'Brot − 12,34 EUR',
		'Brot 12,34+ EUR',
		'Brot 12.34 USD',
		'Brot USD 12.34',
		'Brot CHF 12,34',
		'Brot GBP 12,34',
		'Brot $12.34',
		'Brot 12.34 $',
		'Rabatt 12,34%',
		'Rabatt 12,34 %',
	]) {
		assert.deepEqual(parseOcrText(text, contextDate).expenses, [], text);
	}
});

test('a nonbreaking space between label and amount remains a valid boundary', () => {
	const [expense] = parseOcrText('Brot\u00a012,34 EUR', contextDate).expenses;
	assert.equal(expense?.amountCents, 1234);
});

test('separate amounts on one line still select the final amount', () => {
	const [expense] = parseOcrText('Brot 12,34 56,78 EUR', contextDate).expenses;
	assert.equal(expense?.amountCents, 5678);
});

test('a timed-out module load does not start a worker when it resolves late', async () => {
	const moduleLoad = deferred();
	let workerStarts = 0;
	setTesseractMock(() => {
		workerStarts += 1;
		return Promise.resolve({
			recognize: async () => ({ data: { text: '' } }),
			terminate: async () => {},
		});
	});
	await assertRejectsWithin(
		runOcrOnImage(new Blob(), undefined, {
			loadTesseract: () => moduleLoad.promise,
			initTimeoutMs: 10,
		}),
		250,
		reloadRequired,
	);
	moduleLoad.resolve(globalThis.__ocrTesseractMock);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(workerStarts, 0);
});

test('a late worker is terminated if createWorker resolves after the init timeout', async () => {
	const workerInit = deferred();
	const terminated = deferred();
	let terminateCount = 0;
	const worker = {
		recognize: async () => ({ data: { text: 'unused' } }),
		terminate: async () => {
			terminateCount += 1;
			terminated.resolve();
		},
	};
	setTesseractMock(() => workerInit.promise);
	await assertRejectsWithin(
		runOcrOnImage(new Blob(), undefined, { initTimeoutMs: 10 }),
		250,
		reloadRequired,
	);
	workerInit.resolve(worker);
	await terminated.promise;
	assert.equal(terminateCount, 1);
});

test('recognition timeout terminates an initialized worker', async () => {
	let terminateCount = 0;
	setTesseractMock(async () => ({
		recognize: () => new Promise(() => {}),
		terminate: async () => {
			terminateCount += 1;
		},
	}));
	await assertRejectsWithin(
		runOcrOnImage(new Blob(), undefined, { recognitionTimeoutMs: 10 }),
		250,
		/recognition timed out/i,
	);
	assert.equal(terminateCount, 1);
});

test('worker errors during recognition reject and terminate the initialized worker', async () => {
	let terminateCount = 0;
	setTesseractMock(async (_langs, _oem, options) => ({
		recognize: () => {
			queueMicrotask(() => options?.errorHandler?.('recognition failed'));
			return new Promise(() => {});
		},
		terminate: async () => {
			terminateCount += 1;
		},
	}));
	await assertRejectsWithin(
		runOcrOnImage(new Blob(), undefined, { recognitionTimeoutMs: 100 }),
		250,
		/recognition failed/,
	);
	assert.equal(terminateCount, 1);
});

test('optional runner seam still bypasses Tesseract', async () => {
	let createCalls = 0;
	setTesseractMock(() => {
		createCalls += 1;
		return new Promise(() => {});
	});
	assert.equal(
		await runOcrOnImage(new Blob(), { recognize: async () => 'runner text' }),
		'runner text',
	);
	assert.equal(createCalls, 0);
});

test('SDK init errors reject promptly and repeated attempts do not spawn another pending worker', async () => {
	let createCalls = 0;
	setTesseractMock((_langs, _oem, options) => {
		createCalls += 1;
		queueMicrotask(() => options?.errorHandler?.('TypeError: Failed to fetch language data'));
		return new Promise(() => {});
	});
	const runtime = { loadTesseract: async () => globalThis.__ocrTesseractMock, initTimeoutMs: 100 };
	await assertRejectsWithin(runOcrOnImage(new Blob(), undefined, runtime), 250, reloadRequired);
	await assert.rejects(runOcrOnImage(new Blob(), undefined, runtime), reloadRequired);
	assert.equal(createCalls, 1);
});
