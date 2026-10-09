export type ExportRow = Record<string, unknown>;

interface WgExportInput {
	wg: { name: string; shareCode: string };
	members: ExportRow[];
	expenses: ExportRow[];
	expensePayments: ExportRow[];
	recurringExpenses: ExportRow[];
	shoppingItems: ExportRow[];
	chores: ExportRow[];
	choreCompletions: ExportRow[];
	inventory: ExportRow[];
	absences: ExportRow[];
	announcements: ExportRow[];
	announcementComments: ExportRow[];
	events: ExportRow[];
	chatMessages: ExportRow[];
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
		choreCompletions: ExportRow[];
		inventory: ExportRow[];
		absences: ExportRow[];
		announcements: ExportRow[];
		announcementComments: ExportRow[];
		events: ExportRow[];
		chatMessages: ExportRow[];
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
	choreCompletions: 'Putz-Erledigungen',
	inventory: 'Vorräte',
	absences: 'Abwesenheiten',
	announcements: 'Pinnwand',
	announcementComments: 'Pinnwand-Kommentare',
	events: 'Termine',
	chatMessages: 'Chat',
	auditEvents: 'WG-Änderungen',
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
	expensePayments: [
		'id',
		'fromName',
		'toName',
		'fromMemberId',
		'toMemberId',
		'amountCents',
		'currency',
		'completedAt',
	],
	recurringExpenses: [
		'id',
		'description',
		'amountCents',
		'currency',
		'paidBy',
		'intervalMonths',
		'nextDueAt',
		'lastCreatedAt',
		'pausedAt',
		'createdAt',
		'splits',
	],
	shoppingItems: [
		'id',
		'name',
		'quantity',
		'status',
		'addedBy',
		'boughtBy',
		'boughtAt',
		'createdAt',
	],
	// intervalDays counts months when recurrenceType is 'months'.
	chores: ['id', 'title', 'assignedName', 'nextDueAt', 'intervalDays', 'recurrenceType'],
	choreCompletions: ['id', 'choreTitle', 'completedByName', 'completedAt'],
	inventory: [
		'id',
		'name',
		'quantity',
		'unit',
		'threshold',
		'category',
		'lastDecrementedAt',
		'createdAt',
	],
	absences: ['id', 'memberName', 'startDate', 'endDate', 'reason', 'createdAt'],
	announcements: ['id', 'content', 'kind', 'status', 'authorName', 'imageUrl', 'createdAt'],
	announcementComments: ['id', 'announcementId', 'authorName', 'content', 'createdAt'],
	events: [
		'id',
		'title',
		'description',
		'startsAt',
		'endsAt',
		'allDay',
		'location',
		'recurrence',
		'createdByName',
		'createdAt',
	],
	chatMessages: [
		'id',
		'createdAt',
		'senderName',
		'kind',
		'body',
		'imageUrl',
		'editedAt',
		'deletedAt',
		'replyToMessageId',
	],
	auditEvents: ['id', 'eventType', 'entityType', 'memberName', 'summary', 'createdAt'],
};

export const EXPORT_SECTION_KEYS = Object.keys(SECTION_LABELS) as readonly ExportSectionKey[];

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
			choreCompletions: input.choreCompletions,
			inventory: input.inventory,
			absences: input.absences,
			announcements: input.announcements,
			announcementComments: input.announcementComments,
			events: input.events,
			chatMessages: input.chatMessages,
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
	if (raw === text && !/[";\n\r]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

const CENTS_SUFFIX = /Cents$/;
const TIMESTAMP_HEADER = /(At|Date)$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const berlinMinutes = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Europe/Berlin',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

/** "2026-03-30 00:00" in Berlin time; UTC strings put Berlin midnight on the previous day. */
function formatBerlinMinutes(iso: string): string {
	const parts = Object.fromEntries(
		berlinMinutes.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Cents become a decimal-comma amount ("12,34"), the form German Excel reads as a number. */
function formatCentsAmount(value: unknown): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return escapeCsv(value);
	const abs = Math.abs(Math.round(value));
	return `${value < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** Splits as "Name: 12,34; Name2: 5,00" instead of a JSON blob. */
function formatSplitsCell(splits: unknown[]): string {
	return splits
		.map((split) => {
			const { debtor, amountCents } = (split ?? {}) as Record<string, unknown>;
			return `${String(debtor ?? '')}: ${formatCentsAmount(amountCents)}`;
		})
		.join('; ');
}

function csvCell(header: string, value: unknown, row: ExportRow): string {
	if (CENTS_SUFFIX.test(header)) return formatCentsAmount(value);
	if (header === 'splits' && Array.isArray(value)) return escapeCsv(formatSplitsCell(value));
	if (TIMESTAMP_HEADER.test(header) && typeof value === 'string' && ISO_INSTANT.test(value)) {
		// All-day events are stored as UTC midnight: show the date only, not a Berlin clock time.
		return row.allDay === true ? value.slice(0, 10) : formatBerlinMinutes(value);
	}
	return escapeCsv(value);
}

/**
 * German Excel needs a UTF-8 BOM for umlauts and a semicolon separator
 * (the comma is its decimal mark); `*Cents` columns are written as `*` amounts,
 * timestamps as Berlin local time and splits as readable text.
 */
export function toCsv(rows: ExportRow[], fallbackHeaders: string[] = []): string {
	const headers = fallbackHeaders.length > 0 ? fallbackHeaders : Object.keys(rows[0] ?? {});
	if (headers.length === 0) return '';
	const lines = [headers.map((header) => header.replace(CENTS_SUFFIX, '')).join(';')];
	for (const row of rows) {
		lines.push(headers.map((header) => csvCell(header, row[header], row)).join(';'));
	}
	return `\uFEFF${lines.join('\n')}`;
}

export function getExportSectionHeaders(section: ExportSectionKey): string[] {
	return SECTION_HEADERS[section];
}

export type ExportSectionCounts = Record<ExportSectionKey, number>;

/** Summary from `GET /export?summary=counts`, without downloading every row. */
export function buildExportSummaryFromCounts(counts: ExportSectionCounts): ExportSectionSummary[] {
	return EXPORT_SECTION_KEYS.map((key) => ({
		key,
		label: SECTION_LABELS[key],
		count: counts[key] ?? 0,
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
