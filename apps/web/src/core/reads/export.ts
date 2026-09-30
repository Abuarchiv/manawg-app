export type ExportRow = Record<string, unknown>;

interface WgExportInput {
	wg: { name: string; shareCode: string };
	members: ExportRow[];
	expenses: ExportRow[];
	expensePayments: ExportRow[];
	recurringExpenses: ExportRow[];
	shoppingItems: ExportRow[];
	chores: ExportRow[];
	absences: ExportRow[];
	announcements: ExportRow[];
	auditEvents: ExportRow[];
}

export interface WgExport {
	wg: { name: string; shareCode: string };
	exportedAt: string;
	sections: {
		members: ExportRow[];
		expenses: ExportRow[];
		expensePayments: ExportRow[];
		recurringExpenses: ExportRow[];
		shoppingItems: ExportRow[];
		chores: ExportRow[];
		absences: ExportRow[];
		announcements: ExportRow[];
		auditEvents: ExportRow[];
	};
}

export type ExportSectionKey = keyof WgExport['sections'];

export interface ExportSectionSummary {
	key: ExportSectionKey;
	label: string;
	count: number;
}

const SECTION_LABELS: Record<ExportSectionKey, string> = {
	members: 'Mitglieder',
	expenses: 'Ausgaben',
	expensePayments: 'Erledigte Zahlungen',
	recurringExpenses: 'Fixkosten',
	shoppingItems: 'Einkauf',
	chores: 'Putzplan',
	absences: 'Abwesenheiten',
	announcements: 'Pinnwand',
	auditEvents: 'Audit',
};

const SECTION_HEADERS: Record<ExportSectionKey, string[]> = {
	members: ['id', 'name', 'createdAt'],
	expenses: [
		'id',
		'description',
		'amountCents',
		'currency',
		'paidBy',
		'paidByMemberId',
		'imageUrl',
		'occurredAt',
		'splits',
	],
	expensePayments: ['id', 'fromMemberId', 'toMemberId', 'amountCents', 'currency', 'completedAt'],
	recurringExpenses: [
		'id',
		'description',
		'amountCents',
		'currency',
		'paidBy',
		'intervalMonths',
		'nextDueAt',
		'lastCreatedAt',
		'createdAt',
		'splits',
	],
	shoppingItems: ['id', 'name', 'quantity', 'status', 'createdAt'],
	chores: ['id', 'title', 'assignedName', 'nextDueAt', 'intervalDays'],
	absences: ['id', 'memberName', 'startDate', 'endDate', 'reason', 'createdAt'],
	announcements: ['id', 'content', 'kind', 'status', 'authorName', 'imageUrl', 'createdAt'],
	auditEvents: ['id', 'eventType', 'entityType', 'memberName', 'summary', 'createdAt'],
};

const EXPORT_SECTION_KEYS = Object.keys(SECTION_LABELS) as ExportSectionKey[];

export function isExportSectionKey(value: string | null): value is ExportSectionKey {
	return EXPORT_SECTION_KEYS.includes(value as ExportSectionKey);
}

export function buildWgExport(input: WgExportInput, now = Date.now()): WgExport {
	return {
		wg: input.wg,
		exportedAt: new Date(now).toISOString(),
		sections: {
			members: input.members,
			expenses: input.expenses,
			expensePayments: input.expensePayments,
			recurringExpenses: input.recurringExpenses,
			shoppingItems: input.shoppingItems,
			chores: input.chores,
			absences: input.absences,
			announcements: input.announcements,
			auditEvents: input.auditEvents,
		},
	};
}

function formatCsvValue(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object') {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function neutralizeCsvFormula(text: string): string {
	return /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function escapeCsv(value: unknown): string {
	const raw = formatCsvValue(value);
	const text = neutralizeCsvFormula(raw);
	if (raw === text && !/[",\n\r]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows: ExportRow[], fallbackHeaders: string[] = []): string {
	const headers = fallbackHeaders.length > 0 ? fallbackHeaders : Object.keys(rows[0] ?? {});
	if (headers.length === 0) return '';
	const lines = [headers.join(',')];
	for (const row of rows) {
		lines.push(headers.map((header) => escapeCsv(row[header])).join(','));
	}
	return lines.join('\n');
}

export function getExportSectionHeaders(section: ExportSectionKey): string[] {
	return SECTION_HEADERS[section];
}

export function buildExportSummary(data: WgExport): ExportSectionSummary[] {
	return EXPORT_SECTION_KEYS.map((key) => ({
		key,
		label: SECTION_LABELS[key],
		count: data.sections[key].length,
	}));
}

export function buildEmptyExportSummary(): ExportSectionSummary[] {
	return EXPORT_SECTION_KEYS.map((key) => ({
		key,
		label: SECTION_LABELS[key],
		count: 0,
	}));
}

export function getExportSectionRows(data: WgExport, section: ExportSectionKey): ExportRow[] {
	return data.sections[section];
}

export function parseRecurringSplitsForExport(
	splitsJson: string,
	memberById: Map<string, string>,
): Array<{ debtor: string; amountCents: number }> {
	try {
		const parsed = JSON.parse(splitsJson) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((split) => {
			if (!split || typeof split !== 'object' || Array.isArray(split)) return [];
			const candidate = split as Record<string, unknown>;
			if (
				typeof candidate.debtorMemberId !== 'string' ||
				typeof candidate.amountCents !== 'number'
			) {
				return [];
			}
			return [
				{
					debtor: memberById.get(candidate.debtorMemberId) ?? candidate.debtorMemberId,
					amountCents: candidate.amountCents,
				},
			];
		});
	} catch {
		return [];
	}
}

export function formatExpenseSplitsForExport(
	splits: Array<{
		debtorMemberId: string;
		amountCents: number;
		settledAt: Date | string | null;
	}>,
	memberById: Map<string, string>,
): Array<{
	debtorMemberId: string;
	debtor: string;
	amountCents: number;
	settledAt: string | null;
}> {
	return splits.map((split) => ({
		debtorMemberId: split.debtorMemberId,
		debtor: memberById.get(split.debtorMemberId) ?? split.debtorMemberId,
		amountCents: split.amountCents,
		settledAt: split.settledAt instanceof Date ? split.settledAt.toISOString() : split.settledAt,
	}));
}
