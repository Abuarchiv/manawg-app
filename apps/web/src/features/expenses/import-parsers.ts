import { normalizeMemberName } from './import-csv-helpers';
import type { ParsedExpense } from './import-types';

export { parseSplidCsv } from './import-splid-csv';
export { parseSplitwiseCsv } from './import-splitwise-csv';
export {
	type ImportSource,
	type ParsedExpense,
	type RejectedRow,
	UnsupportedCurrencyError,
} from './import-types';

/** Short names differ by one letter all the time (Tom/Tim); only longer ones may be fuzzy. */
function maxFuzzyDistance(length: number): number {
	if (length < 5) return 0;
	return length < 9 ? 1 : 2;
}

const REJECTED_ROW_REASONS: Record<string, string> = {
	date_invalid: 'Datum nicht lesbar',
	amount_invalid: 'Betrag nicht lesbar',
	no_participants: 'Keine beteiligte Person',
	payer_missing: 'Zahlende Person fehlt',
};

export function describeRejectedRowReason(reason: string): string {
	return REJECTED_ROW_REASONS[reason] ?? reason;
}

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
	if (code === 'ocr_heuristic') {
		return 'Aus dem Bild erkannt: Prüfe Datum, Betrag und zahlende Person. Die Ausgabe wird nur der zahlenden Person zugeordnet, es entsteht keine Schuld.';
	}
	return code;
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

/**
 * Maps file names to member ids: exact (normalized) matches first, then a conservative fuzzy
 * match for names no member claimed exactly. Names matched fuzzily are added to `fuzzyNames`
 * so the UI can ask for a check instead of presenting them as certain.
 */
export function matchMembers(
	parsedNames: readonly string[],
	wgMembers: readonly MemberRef[],
	fuzzyNames?: Set<string>,
): Map<string, string | null> {
	const result = new Map<string, string | null>();
	const memberIndex = wgMembers.map((m) => ({
		id: m.id,
		normalized: normalizeMemberName(m.name),
	}));
	const claimedExactly = new Set<string>();
	const pending: Array<{ raw: string; normalized: string }> = [];
	for (const raw of parsedNames) {
		const normalized = normalizeMemberName(raw);
		const exact = normalized ? memberIndex.find((m) => m.normalized === normalized) : undefined;
		if (exact) {
			result.set(raw, exact.id);
			claimedExactly.add(exact.id);
		} else {
			result.set(raw, null);
			if (normalized) pending.push({ raw, normalized });
		}
	}
	for (const { raw, normalized } of pending) {
		let best: { id: string; distance: number; ambiguous: boolean } | null = null;
		for (const m of memberIndex) {
			if (claimedExactly.has(m.id)) continue;
			const maxDistance = maxFuzzyDistance(Math.min(normalized.length, m.normalized.length));
			const distance = levenshtein(normalized, m.normalized);
			if (distance > maxDistance) continue;
			if (best === null || distance < best.distance) {
				best = { id: m.id, distance, ambiguous: false };
			} else if (distance === best.distance) {
				best.ambiguous = true;
			}
		}
		if (best && !best.ambiguous) {
			result.set(raw, best.id);
			fuzzyNames?.add(raw);
		}
	}
	return result;
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
