import type { NotificationWarning } from '@/core/notifications/notification-warning';
import type { ParsedExpense, RejectedRow } from '@/features/expenses/import-parsers';
import type { MemberRef } from '@/shared/lib/member-types';
import type { ImportSourceKind } from './ImportSourcePicker';

export type ImportStep = 'source' | 'input' | 'mapping' | 'preview' | 'commit';

export const IMPORT_STEPS: readonly ImportStep[] = [
	'source',
	'input',
	'mapping',
	'preview',
	'commit',
];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImportInputStatus = 'empty' | 'reading' | 'ready' | 'error';

export interface PreviewResponse {
	parsed: ParsedExpense[];
	payloadHash: string;
	memberMapping: Record<string, string | null>;
	conflicts: string[];
	members: MemberRef[];
	/** CSV rows the parser could not read; absent on older responses. */
	rejected?: RejectedRow[];
	/** Names matched by similarity only; the member should confirm them. */
	fuzzyNames?: string[];
}

export interface CommitResponse {
	importId: string;
	inserted: number;
	skipped: number;
	errors: Array<{ index: number; reason: string }>;
	warning: NotificationWarning;
}

export function payloadKey(source: ImportSourceKind): 'splitwise_csv' | 'splid_csv' | 'ocr_text' {
	if (source === 'splitwise_csv') return 'splitwise_csv';
	if (source === 'splid_csv') return 'splid_csv';
	return 'ocr_text';
}

/** Names in the preview that have to point at a member: payers and split participants. */
export function namesInPreview(preview: PreviewResponse | null): string[] {
	if (!preview) return [];
	const names = new Set<string>();
	for (const expense of preview.parsed) {
		if (expense.paidByName) names.add(expense.paidByName);
		for (const s of expense.splits) {
			if (s.memberName) names.add(s.memberName);
		}
	}
	return Array.from(names);
}

/**
 * Mapping for a fresh preview. After "Zurück", the member's own choices survive for names
 * that are still in the input; new names take the server's suggestion.
 */
export function mergeMemberMapping(
	suggested: Record<string, string | null>,
	previous: Record<string, string | null>,
): Record<string, string | null> {
	return Object.fromEntries(
		Object.entries(suggested).map(([name, memberId]) => [
			name,
			Object.hasOwn(previous, name) ? (previous[name] ?? null) : memberId,
		]),
	);
}

/** Decodes a CSV export; Excel CSV from German installations is often Windows-1252, not UTF-8. */
export function decodeCsv(buffer: ArrayBuffer): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
	} catch {
		return new TextDecoder('windows-1252').decode(buffer);
	}
}
