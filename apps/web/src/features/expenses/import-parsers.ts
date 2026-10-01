import { CENTS_PER_EURO } from '@/core/utils/money';
import { AMOUNT_MAX_CENTS } from '@/features/expenses/expense-constants';
const FUZZY_MATCH_MAX_DISTANCE = 2;
const CUSTOM_SPLIT_MAX_DRIFT_CENTS = 2;
const MIN_PLAUSIBLE_YEAR = 2000;
const MAX_PLAUSIBLE_YEAR = 2100;
const BOM = '﻿';

export interface ParsedSplit {
	memberName: string;
	amountCents: number;
}

export interface ParsedExpense {
	date: string;
	description: string;
	amountCents: number;
	currency: 'EUR';
	paidByName: string;
	splits: ParsedSplit[];
	warnings: string[];
}

export type ImportSource = 'splitwise_csv' | 'splid_csv' | 'ocr_screenshot' | 'manual';

/**
 * A parsed row's `warnings` are internal codes (see `parseSplitwiseCsv`), not
 * UI text. This is the one place that turns them into German sentences for
 * `ImportPreviewTable`, so a new code can't accidentally leak to the screen
 * unmapped.
 */
export function describeParsedExpenseWarning(code: string): string {
	if (code.startsWith('unknown_columns_ignored:')) {
		const columns = code.slice('unknown_columns_ignored:'.length).split('|').filter(Boolean);
		return `Spalte${columns.length === 1 ? '' : 'n'} ${columns.map((name) => `„${name}“`).join(', ')} wurde${columns.length === 1 ? '' : 'n'} nicht erkannt und ignoriert.`;
	}
	if (code === 'custom_splits_drift_adjusted') {
		return 'Die Aufteilung wich minimal vom Gesamtbetrag ab und wurde automatisch angeglichen.';
	}
	if (code === 'custom_splits_discarded') {
		return 'Die eigene Aufteilung wich zu stark vom Gesamtbetrag ab und wurde verworfen — stattdessen gleichmäßig aufgeteilt.';
	}
	return code;
}

export class UnsupportedCurrencyError extends Error {
	readonly currency: string;
	constructor(currency: string) {
		super('Nur EUR-Importe unterstützt');
		this.name = 'UnsupportedCurrencyError';
		this.currency = currency;
	}
}

export function normalizeMemberName(name: string): string {
	return name
		.normalize('NFD')
		.replace(/̀|́|̂|̃|̄|̆|̇|̈|̊|̋|̌|̧/g, '')
		.toLowerCase()
		.trim()
		.replace(/\s+/g, ' ');
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const prev: number[] = new Array(b.length + 1);
	const curr: number[] = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j += 1) prev[j] = j;
	for (let i = 1; i <= a.length; i += 1) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			const del = (prev[j] ?? 0) + 1;
			const ins = (curr[j - 1] ?? 0) + 1;
			const sub = (prev[j - 1] ?? 0) + cost;
			curr[j] = Math.min(del, ins, sub);
		}
		for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
	}
	return prev[b.length] ?? 0;
}

interface MemberRef {
	id: string;
	name: string;
}

export function matchMembers(
	parsedNames: readonly string[],
	wgMembers: readonly MemberRef[],
): Map<string, string | null> {
	const result = new Map<string, string | null>();
	const memberIndex = wgMembers.map((m) => ({
		id: m.id,
		name: m.name,
		normalized: normalizeMemberName(m.name),
	}));
	for (const raw of parsedNames) {
		const normalized = normalizeMemberName(raw);
		if (!normalized) {
			result.set(raw, null);
			continue;
		}
		const exact = memberIndex.find((m) => m.normalized === normalized);
		if (exact) {
			result.set(raw, exact.id);
			continue;
		}
		let best: { id: string; distance: number; ambiguous: boolean } | null = null;
		for (const m of memberIndex) {
			const distance = levenshtein(normalized, m.normalized);
			if (distance > FUZZY_MATCH_MAX_DISTANCE) continue;
			if (best === null || distance < best.distance) {
				best = { id: m.id, distance, ambiguous: false };
			} else if (distance === best.distance) {
				best.ambiguous = true;
			}
		}
		result.set(raw, best && !best.ambiguous ? best.id : null);
	}
	return result;
}

function stripBom(input: string): string {
	return input.startsWith(BOM) ? input.slice(BOM.length) : input;
}

function detectDelimiter(line: string): string {
	const semi = (line.match(/;/g) ?? []).length;
	const comma = (line.match(/,/g) ?? []).length;
	return semi > comma ? ';' : ',';
}

interface CsvRow {
	fields: string[];
	lineNumber: number;
}

function parseCsv(input: string, delimiter: string): CsvRow[] {
	const rows: CsvRow[] = [];
	let field = '';
	let row: string[] = [];
	let inQuotes = false;
	let lineNumber = 1;
	let rowStartLine = 1;
	let i = 0;
	const text = stripBom(input);
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (inQuotes) {
			if (ch === '"' && next === '"') {
				field += '"';
				i += 2;
				continue;
			}
			if (ch === '"') {
				inQuotes = false;
				i += 1;
				continue;
			}
			if (ch === '\n') lineNumber += 1;
			field += ch;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			i += 1;
			continue;
		}
		if (ch === delimiter) {
			row.push(field);
			field = '';
			i += 1;
			continue;
		}
		if (ch === '\r' && next === '\n') {
			row.push(field);
			rows.push({ fields: row, lineNumber: rowStartLine });
			field = '';
			row = [];
			i += 2;
			lineNumber += 1;
			rowStartLine = lineNumber;
			continue;
		}
		if (ch === '\n' || ch === '\r') {
			row.push(field);
			rows.push({ fields: row, lineNumber: rowStartLine });
			field = '';
			row = [];
			i += 1;
			lineNumber += 1;
			rowStartLine = lineNumber;
			continue;
		}
		field += ch;
		i += 1;
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push({ fields: row, lineNumber: rowStartLine });
	}
	return rows.filter((r) => r.fields.some((f) => f.trim().length > 0));
}

function parseAmountToCents(raw: string): number | null {
	const trimmed = raw.trim().replace(/€|EUR/gi, '').trim();
	if (!trimmed) return null;
	let normalized = trimmed.replace(/\s/g, '');
	const lastComma = normalized.lastIndexOf(',');
	const lastDot = normalized.lastIndexOf('.');
	if (lastComma > -1 && lastDot > -1) {
		if (lastComma > lastDot) {
			normalized = normalized.replace(/\./g, '').replace(',', '.');
		} else {
			normalized = normalized.replace(/,/g, '');
		}
	} else if (lastComma > -1) {
		const decimals = normalized.length - lastComma - 1;
		normalized = decimals === 2 ? normalized.replace(',', '.') : normalized.replace(/,/g, '');
	}
	const num = Number(normalized);
	if (!Number.isFinite(num)) return null;
	const cents = Math.round(num * CENTS_PER_EURO);
	if (!Number.isInteger(cents) || Math.abs(cents) > AMOUNT_MAX_CENTS) return null;
	return cents;
}

function parseDateIso(raw: string): string | null {
	const value = raw.trim();
	if (!value) return null;
	const fromParts = (year: string, month: string, day: string): string | null => {
		const y = Number(year);
		if (y < MIN_PLAUSIBLE_YEAR || y > MAX_PLAUSIBLE_YEAR) return null;
		const m = Number(month);
		const d = Number(day);
		const date = new Date(Date.UTC(y, m - 1, d));
		if (
			Number.isNaN(date.getTime()) ||
			date.getUTCFullYear() !== y ||
			date.getUTCMonth() !== m - 1 ||
			date.getUTCDate() !== d
		) {
			return null;
		}
		return date.toISOString();
	};
	const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (isoMatch) {
		const [, y, m, d] = isoMatch;
		return fromParts(y ?? '', m ?? '', d ?? '');
	}
	const deMatch = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
	if (deMatch) {
		const [, d, m, y] = deMatch;
		const year = (y ?? '').length === 2 ? `20${y}` : y;
		return fromParts(year ?? '', m ?? '', d ?? '');
	}
	const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
	if (slash) {
		const [, m, d, y] = slash;
		const year = (y ?? '').length === 2 ? `20${y}` : y;
		return fromParts(year ?? '', m ?? '', d ?? '');
	}
	return null;
}

function lowerKey(key: string): string {
	return normalizeMemberName(key);
}

function findColumnIndex(headers: readonly string[], candidates: readonly string[]): number {
	const lowered = headers.map(lowerKey);
	for (const candidate of candidates) {
		const idx = lowered.indexOf(lowerKey(candidate));
		if (idx !== -1) return idx;
	}
	return -1;
}

function distributeRemainder(total: number, shares: number[]): number[] {
	const sum = shares.reduce((acc, n) => acc + n, 0);
	const diff = total - sum;
	if (diff === 0 || shares.length === 0) return shares;
	const out = [...shares];
	if (diff > 0) {
		for (let k = 0; k < diff; k += 1) {
			const idx = k % out.length;
			out[idx] = (out[idx] ?? 0) + 1;
		}
	} else {
		const sorted = out.map((amount, idx) => ({ amount, idx })).sort((a, b) => b.amount - a.amount);
		for (let k = 0; k < -diff; k += 1) {
			const target = sorted[k % sorted.length];
			if (!target) break;
			out[target.idx] = (out[target.idx] ?? 0) - 1;
		}
	}
	return out;
}

const SPLITWISE_KNOWN_COLS = new Set([
	'date',
	'datum',
	'description',
	'beschreibung',
	'notes',
	'notizen',
	'details',
	'repayments',
	'category',
	'kategorie',
	'cost',
	'kosten',
	'amount',
	'betrag',
	'currency',
	'wahrung',
	'created date',
	'created by',
	'last changed',
	'last modified by',
]);

export function parseSplitwiseCsv(csv: string): ParsedExpense[] {
	const firstNewline = csv.indexOf('\n');
	const headerLine = firstNewline === -1 ? csv : csv.slice(0, firstNewline);
	const delimiter = detectDelimiter(stripBom(headerLine));
	const rows = parseCsv(csv, delimiter);
	if (rows.length < 2) return [];
	const header = rows[0]?.fields ?? [];
	const idxDate = findColumnIndex(header, ['date', 'datum']);
	const idxDesc = findColumnIndex(header, ['description', 'beschreibung']);
	const idxCost = findColumnIndex(header, ['cost', 'kosten', 'amount', 'betrag']);
	const idxCurrency = findColumnIndex(header, ['currency', 'währung', 'wahrung']);
	if (idxDate === -1 || idxDesc === -1 || idxCost === -1) return [];

	const memberColumns: { index: number; name: string }[] = [];
	const ignoredColumns: string[] = [];
	for (let i = 0; i < header.length; i += 1) {
		const raw = (header[i] ?? '').trim();
		const key = lowerKey(raw);
		if (!key) continue;
		if (SPLITWISE_KNOWN_COLS.has(key) || key.startsWith('wahrung')) continue;
		const hasAmount = rows.slice(1).some((row) => {
			const value = (row.fields[i] ?? '').trim();
			return value !== '' && parseAmountToCents(value) !== null;
		});
		if (!hasAmount) {
			ignoredColumns.push(raw);
			continue;
		}
		memberColumns.push({ index: i, name: raw });
	}

	const out: ParsedExpense[] = [];
	for (let r = 1; r < rows.length; r += 1) {
		const fields = rows[r]?.fields ?? [];
		const warnings: string[] = [];
		if (ignoredColumns.length > 0) {
			warnings.push(`unknown_columns_ignored:${ignoredColumns.join('|')}`);
		}
		const descRaw = (fields[idxDesc] ?? '').trim();
		if (!descRaw || /^total/i.test(descRaw)) continue;
		const date = parseDateIso(fields[idxDate] ?? '');
		if (!date) {
			warnings.push('date_invalid');
			continue;
		}
		const totalCents = parseAmountToCents(fields[idxCost] ?? '');
		if (totalCents === null || totalCents <= 0) {
			warnings.push('amount_invalid');
			continue;
		}
		const currencyRaw =
			idxCurrency === -1 ? 'EUR' : (fields[idxCurrency] ?? 'EUR').trim().toUpperCase();
		if (currencyRaw && currencyRaw !== 'EUR') {
			throw new UnsupportedCurrencyError(currencyRaw);
		}

		let paidByName = '';
		let paidByColIndex = -1;
		let paidByValue = Number.NEGATIVE_INFINITY;
		for (const col of memberColumns) {
			const raw = (fields[col.index] ?? '').trim();
			if (!raw) continue;
			const signedCents = parseAmountToCents(raw);
			if (signedCents === null) continue;
			if (signedCents > paidByValue) {
				paidByValue = signedCents;
				paidByName = col.name;
				paidByColIndex = col.index;
			}
		}
		if (!paidByName && memberColumns[0]) {
			paidByName = memberColumns[0].name;
			paidByColIndex = memberColumns[0].index;
		}

		// Splitwise's per-person columns hold each person's NET balance on the
		// row, not their share: a debtor's column is `-share` (matches
		// Math.abs below), but the payer's column is `paid - ownShare`, so
		// their share has to be recovered as `total - net` — using the raw
		// abs value for the payer too under-detects real custom splits as
		// "drift" and silently discards them (see customSplits below).
		const parsedMemberAmounts = memberColumns
			.map((col) => {
				const raw = (fields[col.index] ?? '').trim();
				const signedCents = raw ? parseAmountToCents(raw) : null;
				if (signedCents === null || signedCents === 0) return null;
				const amountCents =
					col.index === paidByColIndex ? totalCents - signedCents : Math.abs(signedCents);
				return amountCents <= 0 ? null : { memberName: col.name, amountCents };
			})
			.filter((amount): amount is ParsedSplit => Boolean(amount));
		const customTotal = parsedMemberAmounts.reduce((acc, amount) => acc + amount.amountCents, 0);
		const drift = totalCents - customTotal;
		let customSplits: ParsedSplit[] | null = null;
		if (parsedMemberAmounts.length > 0) {
			if (drift === 0) {
				customSplits = parsedMemberAmounts;
			} else if (Math.abs(drift) <= CUSTOM_SPLIT_MAX_DRIFT_CENTS) {
				let maxIdx = 0;
				for (let i = 1; i < parsedMemberAmounts.length; i += 1) {
					if (
						(parsedMemberAmounts[i]?.amountCents ?? 0) >
						(parsedMemberAmounts[maxIdx]?.amountCents ?? 0)
					) {
						maxIdx = i;
					}
				}
				customSplits = parsedMemberAmounts.map((split, idx) =>
					idx === maxIdx ? { ...split, amountCents: split.amountCents + drift } : split,
				);
				warnings.push('custom_splits_drift_adjusted');
			} else {
				warnings.push('custom_splits_discarded');
			}
		}
		if (customSplits) {
			out.push({
				date,
				description: descRaw,
				amountCents: totalCents,
				currency: 'EUR',
				paidByName,
				splits: customSplits,
				warnings,
			});
			continue;
		}

		const participants = memberColumns.filter((col) => {
			const raw = (fields[col.index] ?? '').trim();
			if (!raw) return false;
			const cents = parseAmountToCents(raw);
			return cents !== null && cents !== 0;
		});
		if (participants.length === 0) {
			warnings.push('no_participants');
			continue;
		}
		const baseShare = Math.floor(totalCents / participants.length);
		const rawShares = participants.map(() => baseShare);
		const finalShares = distributeRemainder(totalCents, rawShares);
		const splits: ParsedSplit[] = participants.map((col, idx) => ({
			memberName: col.name,
			amountCents: finalShares[idx] ?? baseShare,
		}));

		out.push({
			date,
			description: descRaw,
			amountCents: totalCents,
			currency: 'EUR',
			paidByName,
			splits,
			warnings,
		});
	}
	return out;
}

export function parseSplidCsv(csv: string): ParsedExpense[] {
	const firstNewline = csv.indexOf('\n');
	const headerLine = firstNewline === -1 ? csv : csv.slice(0, firstNewline);
	const delimiter = detectDelimiter(stripBom(headerLine));
	const rows = parseCsv(csv, delimiter);
	if (rows.length < 2) return [];
	const header = rows[0]?.fields ?? [];
	const idxDate = findColumnIndex(header, ['datum', 'date']);
	const idxDesc = findColumnIndex(header, ['beschreibung', 'titel', 'description']);
	const idxAmount = findColumnIndex(header, ['betrag', 'kosten', 'amount']);
	const idxPaidBy = findColumnIndex(header, ['bezahlt von', 'zahler', 'payer', 'paid by']);
	const idxParticipants = findColumnIndex(header, ['teilnehmer', 'participants', 'für']);
	const idxCurrency = findColumnIndex(header, ['währung', 'wahrung', 'currency']);
	if (idxDate === -1 || idxDesc === -1 || idxAmount === -1 || idxPaidBy === -1) return [];

	const out: ParsedExpense[] = [];
	for (let r = 1; r < rows.length; r += 1) {
		const fields = rows[r]?.fields ?? [];
		const warnings: string[] = [];
		const descRaw = (fields[idxDesc] ?? '').trim();
		if (!descRaw) continue;
		const date = parseDateIso(fields[idxDate] ?? '');
		if (!date) {
			warnings.push('date_invalid');
			continue;
		}
		const totalCents = parseAmountToCents(fields[idxAmount] ?? '');
		if (totalCents === null || totalCents <= 0) {
			warnings.push('amount_invalid');
			continue;
		}
		const paidByName = (fields[idxPaidBy] ?? '').trim();
		if (!paidByName) {
			warnings.push('payer_missing');
			continue;
		}
		if (idxCurrency !== -1) {
			const currencyRaw = (fields[idxCurrency] ?? 'EUR').trim().toUpperCase();
			if (currencyRaw && currencyRaw !== 'EUR') {
				throw new UnsupportedCurrencyError(currencyRaw);
			}
		}
		const participantsRaw =
			idxParticipants === -1 ? paidByName : (fields[idxParticipants] ?? '').trim();
		const participants = participantsRaw
			.split(/[,;|]/)
			.map((s) => s.trim())
			.filter(Boolean);
		const finalParticipants = participants.length === 0 ? [paidByName] : participants;
		const baseShare = Math.floor(totalCents / finalParticipants.length);
		const rawShares = finalParticipants.map(() => baseShare);
		const shares = distributeRemainder(totalCents, rawShares);
		const splits: ParsedSplit[] = finalParticipants.map((name, idx) => ({
			memberName: name,
			amountCents: shares[idx] ?? baseShare,
		}));

		out.push({
			date,
			description: descRaw,
			amountCents: totalCents,
			currency: 'EUR',
			paidByName,
			splits,
			warnings,
		});
	}
	return out;
}

export function collectUniqueNames(parsed: readonly ParsedExpense[]): string[] {
	const set = new Set<string>();
	for (const e of parsed) {
		if (e.paidByName) set.add(e.paidByName);
		for (const s of e.splits) {
			if (s.memberName) set.add(s.memberName);
		}
	}
	return Array.from(set);
}

export function findMappingConflicts(
	parsed: readonly ParsedExpense[],
	mapping: Readonly<Record<string, string | null>>,
): string[] {
	const conflicts = new Set<string>();
	for (const name of collectUniqueNames(parsed)) {
		if (!mapping[name]) conflicts.add(name);
	}
	return Array.from(conflicts);
}
