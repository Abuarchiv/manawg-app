import { type ParsedExpense, parseAmountToCents } from './import-parsers';

const OCR_LANGS = 'deu+eng';
const supportedCurrencyCodes = new Set(
	(
		Intl as typeof Intl & {
			supportedValuesOf?: (key: 'currency') => string[];
		}
	).supportedValuesOf?.('currency') ?? ['USD', 'CHF', 'GBP', 'JPY', 'CAD', 'AUD'],
);

export interface OcrRunner {
	recognize(input: Blob | File): Promise<string>;
}

interface TesseractWorkerLike {
	recognize: (image: unknown) => Promise<{ data: { text: string } }>;
	terminate: () => Promise<void>;
}

interface TesseractModuleLike {
	createWorker: (langs: string) => Promise<TesseractWorkerLike>;
}

async function loadTesseract(): Promise<TesseractModuleLike> {
	const mod = (await import(/* webpackChunkName: "tesseract" */ 'tesseract.js')) as unknown as
		| TesseractModuleLike
		| { default: TesseractModuleLike };
	return 'createWorker' in mod ? mod : mod.default;
}
export async function runOcrOnImage(file: Blob | File, runner?: OcrRunner): Promise<string> {
	if (runner) return runner.recognize(file);
	const tesseract = await loadTesseract();
	const worker = await tesseract.createWorker(OCR_LANGS);
	try {
		const { data } = await worker.recognize(file);
		return data.text ?? '';
	} finally {
		await worker.terminate().catch(() => undefined);
	}
}

const AMOUNT_PATTERN =
	/(?<![\p{L}\d.,])(?<!\d\s)([+\-−]?\s*)?(?:€\s*|EUR\s*)?([+\-−]?\s*(?:\d{1,3}(?:[.,]\d{3}|[ \u00a0\u202f]\d{3})+|\d+)[.,]\d{1,2})\s*(?:€|EUR)?(?![\p{L}\d.,]|\s*%)/giu;
const DATE_PATTERN = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/;
const PAYER_PATTERN = /(?:bezahlt von|paid by|von:)\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\s-]{1,40})/i;

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

		const amounts = Array.from(line.matchAll(AMOUNT_PATTERN)).filter((match) => {
			const start = match.index ?? 0;
			const before = line.slice(0, start);
			const after = line.slice(start + match[0].length);
			const prefixCurrency = /(?:^|\s)([a-z]{3})\s*$/i.exec(before)?.[1]?.toUpperCase();
			const suffixCurrency = /^\s*([a-z]{3})\b/i.exec(after)?.[1]?.toUpperCase();
			return ![prefixCurrency, suffixCurrency].some(
				(code) => code !== undefined && code !== 'EUR' && supportedCurrencyCodes.has(code),
			);
		});
		if (amounts.length === 0) continue;
		const last = amounts[amounts.length - 1];
		if (!last || typeof last[2] !== 'string') continue;
		const amountCents = parseAmountToCents(`${last[1] ?? ''}${last[2]}`);
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
