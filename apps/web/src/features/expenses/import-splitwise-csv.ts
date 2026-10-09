import {
	detectDelimiter,
	distributeRemainder,
	findColumnIndex,
	lowerKey,
	parseAmountToCents,
	parseCsv,
	parseDateIso,
	stripBom,
} from './import-csv-helpers';
import {
	type ParsedExpense,
	type ParsedSplit,
	type RejectedRow,
	UnsupportedCurrencyError,
} from './import-types';
const CUSTOM_SPLIT_MAX_DRIFT_CENTS = 2;

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

export function parseSplitwiseCsv(csv: string, rejected?: RejectedRow[]): ParsedExpense[] {
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
		const line = rows[r]?.lineNumber ?? r + 1;
		const warnings: string[] = [];
		if (ignoredColumns.length > 0) {
			warnings.push(`unknown_columns_ignored:${ignoredColumns.join('|')}`);
		}
		const descRaw = (fields[idxDesc] ?? '').trim();
		if (!descRaw || /^total/i.test(descRaw)) continue;
		const date = parseDateIso(fields[idxDate] ?? '');
		if (!date) {
			rejected?.push({ line, reason: 'date_invalid', description: descRaw });
			continue;
		}
		const totalCents = parseAmountToCents(fields[idxCost] ?? '');
		if (totalCents === null || totalCents <= 0) {
			rejected?.push({ line, reason: 'amount_invalid', description: descRaw });
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
			rejected?.push({ line, reason: 'no_participants', description: descRaw });
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
