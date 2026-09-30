import { parseEuroAmount } from '@/core/utils/amount';
import { CENTS_PER_EURO } from '@/core/utils/money';
import { AMOUNT_MAX_CENTS } from '@/features/expenses/expense-constants';
import type { ParsedExpense } from './import-parsers';

const OCR_LANGS = 'deu+eng';

export interface OcrRunner {
	recognize(input: Blob | File): Promise<string>;
}

interface TesseractWorkerLike {
	recognize: (image: unknown) => Promise<{ data: { text: string } }>;
	terminate: () => Promise<void>;
}

interface TesseractWorkerOptions {
	errorHandler: (error: unknown) => void;
}

interface TesseractModuleLike {
	createWorker: (
		langs: string,
		oem?: number,
		options?: TesseractWorkerOptions,
	) => Promise<TesseractWorkerLike>;
}

interface OcrRuntimeOptions {
	loadTesseract?: () => Promise<TesseractModuleLike>;
	initTimeoutMs?: number;
	recognitionTimeoutMs?: number;
}

export class OcrInitializationError extends Error {
	readonly requiresReload: boolean;

	constructor(requiresReload: boolean, cause: unknown) {
		super('OCR engine initialization failed.', { cause });
		this.name = 'OcrInitializationError';
		this.requiresReload = requiresReload;
	}
}

const OCR_INIT_TIMEOUT_MS = 30_000;
const OCR_RECOGNITION_TIMEOUT_MS = 20_000;

// ponytail: Tesseract 5 exposes no handle before init settles; keep one pending initializer and terminate late handles, with reload as recovery if it never settles.
let pendingWorkerInitialization: Promise<TesseractWorkerLike> | null = null;

async function loadTesseract(): Promise<TesseractModuleLike> {
	const mod = (await import(/* webpackChunkName: "tesseract" */ 'tesseract.js')) as unknown as
		| TesseractModuleLike
		| { default: TesseractModuleLike };
	return 'createWorker' in mod ? mod : mod.default;
}
async function terminateWorker(worker: TesseractWorkerLike): Promise<void> {
	try {
		await worker.terminate();
	} catch {
		// Termination is best-effort after a failed or completed OCR job.
	}
}

function toOcrError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === 'string') return new Error(reason);
	if (typeof reason === 'object' && reason !== null && 'message' in reason) {
		return new Error(String(reason.message));
	}
	return new Error('OCR worker failed.');
}

function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
	onTimeout: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			onTimeout();
			reject(new Error(message));
		}, timeoutMs);
	});
	return Promise.race([operation, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export async function runOcrOnImage(
	file: Blob | File,
	runner?: OcrRunner,
	runtime: OcrRuntimeOptions = {},
): Promise<string> {
	if (runner) return runner.recognize(file);
	if (pendingWorkerInitialization) {
		throw new OcrInitializationError(true, new Error('OCR initialization is still pending.'));
	}

	let initializationAbandoned = false;
	let rejectWorkerError!: (reason: Error) => void;
	const workerError = new Promise<never>((_, reject) => {
		rejectWorkerError = reject;
	});
	const workerPromise = (runtime.loadTesseract ?? loadTesseract)().then((tesseract) => {
		if (initializationAbandoned) throw new Error('OCR initialization was abandoned.');
		return tesseract.createWorker(OCR_LANGS, undefined, {
			errorHandler: (reason) => {
				initializationAbandoned = true;
				rejectWorkerError(toOcrError(reason));
			},
		});
	});
	pendingWorkerInitialization = workerPromise;
	void workerPromise.then(
		async (lateWorker) => {
			if (initializationAbandoned) await terminateWorker(lateWorker);
			if (pendingWorkerInitialization === workerPromise) pendingWorkerInitialization = null;
		},
		() => {
			if (pendingWorkerInitialization === workerPromise) pendingWorkerInitialization = null;
		},
	);

	let worker: TesseractWorkerLike | null = null;
	try {
		try {
			worker = await withTimeout(
				Promise.race([workerPromise, workerError]),
				runtime.initTimeoutMs ?? OCR_INIT_TIMEOUT_MS,
				'OCR engine initialization timed out.',
				() => {
					initializationAbandoned = true;
				},
			);
		} catch (error) {
			throw new OcrInitializationError(pendingWorkerInitialization === workerPromise, error);
		}
		const { data } = await withTimeout(
			Promise.race([worker.recognize(file), workerError]),
			runtime.recognitionTimeoutMs ?? OCR_RECOGNITION_TIMEOUT_MS,
			'OCR recognition timed out.',
			() => {
				initializationAbandoned = true;
			},
		);
		return data.text ?? '';
	} finally {
		initializationAbandoned = true;
		if (worker) await terminateWorker(worker);
	}
}

const AMOUNT_PATTERN =
	/(?<![\p{L}\d.,/+−$£¥\-])(?<!\d[\u00A0\u202F'’])(\d+(?:[.,]\d+)*)(?:\s*(?:€|EUR))?(?![\p{L}\d.,/+−$£¥%\u00A0\u202F'’\-]|\s*(?:USD|CHF|GBP)\b|\s*[$£¥%])/giu;
const DATE_PATTERN = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/;
const PAYER_PATTERN = /(?:bezahlt von|paid by|von:)\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\s-]{1,40})/i;

function parseOcrAmount(raw: string): number | null {
	let normalized = raw;
	if (/^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(raw)) {
		normalized = raw.replace(/\./g, '').replace(',', '.');
	} else if (/^\d{1,3}(?:,\d{3})+\.\d{2}$/.test(raw)) {
		normalized = raw.replace(/,/g, '');
	} else if (!/^\d+[.,]\d{2}$/.test(raw)) {
		return null;
	}
	const amountEuros = parseEuroAmount(normalized);
	if (amountEuros === null) return null;
	const amountCents = Math.round(amountEuros * CENTS_PER_EURO);
	return Number.isSafeInteger(amountCents) && amountCents <= AMOUNT_MAX_CENTS ? amountCents : null;
}

function parseDate(raw: string): string | null {
	const match = raw.match(DATE_PATTERN);
	if (!match) return null;
	const [, d, m, y] = match;
	const year = (y ?? '').length === 2 ? `20${y}` : y;
	const dayNum = Number(d);
	const monthNum = Number(m);
	const yearNum = Number(year);
	const date = new Date(
		`${year}-${(m ?? '').padStart(2, '0')}-${(d ?? '').padStart(2, '0')}T00:00:00Z`,
	);
	if (Number.isNaN(date.getTime())) return null;
	if (
		date.getUTCFullYear() !== yearNum ||
		date.getUTCMonth() + 1 !== monthNum ||
		date.getUTCDate() !== dayNum
	) {
		return null;
	}
	return date.toISOString();
}

function cleanDescription(raw: string): string {
	return raw
		.replace(AMOUNT_PATTERN, '')
		.replace(/(?:bezahlt von|paid by|von:)\s*[A-Za-zÄÖÜäöüß\s-]+/i, '')
		.replace(DATE_PATTERN, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function hasWholeAmountBoundary(line: string, match: RegExpMatchArray): boolean {
	const start = match.index ?? 0;
	const before = line.slice(0, start);
	const after = line.slice(start + match[0].length);
	const precedingNumber = before.match(
		/(?:^|[^\p{L}\d])(\d+(?:[.,]\d+)*)(?:[\s\u00A0\u202F'’]+)$/u,
	)?.[1];
	if (
		precedingNumber &&
		parseOcrAmount(precedingNumber) === null &&
		!DATE_PATTERN.test(precedingNumber)
	) {
		return false;
	}
	if (/[+\-−]\s*$/u.test(before) || /^\s*[+\-−]/u.test(after)) return false;
	if (/(?:^|\s)(?:USD|CHF|GBP)\s*$/i.test(before)) return false;
	return true;
}

interface OcrParseResult {
	expenses: ParsedExpense[];
	rawText: string;
}

export function parseOcrText(rawText: string, contextDateIso?: string): OcrParseResult {
	const lines = rawText
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const expenses: ParsedExpense[] = [];
	let currentPayer = '';
	let currentDate = contextDateIso ?? new Date().toISOString();
	if (contextDateIso) {
		const contextDate = new Date(contextDateIso);
		if (!Number.isNaN(contextDate.getTime())) currentDate = contextDate.toISOString();
	}

	for (const line of lines) {
		const payerMatch = line.match(PAYER_PATTERN);
		if (payerMatch?.[1]) {
			currentPayer = payerMatch[1].trim().replace(/[:.]$/, '');
		}
		const maybeDate = parseDate(line);
		if (maybeDate) currentDate = maybeDate;

		const amounts = Array.from(line.matchAll(AMOUNT_PATTERN)).filter((match) =>
			hasWholeAmountBoundary(line, match),
		);
		if (amounts.length === 0) continue;
		const last = amounts[amounts.length - 1];
		if (!last || typeof last[1] !== 'string') continue;
		const amountCents = parseOcrAmount(last[1]);
		if (amountCents === null || amountCents <= 0) continue;

		const description = cleanDescription(line);
		if (!description) continue;
		const payer = currentPayer || 'Unbekannt';

		expenses.push({
			date: currentDate,
			description,
			amountCents,
			currency: 'EUR',
			paidByName: payer,
			splits: [{ memberName: payer, amountCents }],
			warnings: ['ocr_heuristic'],
		});
	}

	return { expenses, rawText };
}
