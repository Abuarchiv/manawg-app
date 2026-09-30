import {
	announcements,
	auditEvents,
	chores,
	db,
	expensePayments,
	expenseSplits,
	expenses,
	memberAbsences,
	recurringExpenses,
	shoppingItems,
	wgMembers,
} from '@/core/db';
import { badRequest, serverError, tooMany } from '@/core/errors';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { readShareCode, resolveE2EFixture } from '@/core/guards/route-preamble';
import type { RouteCtx } from '@/core/infra/api-types';
import { logApiError } from '@/core/infra/observability';
import { checkRateLimit, wgExportLimiter } from '@/core/rate-limit';
import {
	type ExportRow,
	type ExportSectionKey,
	buildWgExport,
	formatExpenseSplitsForExport,
	getExportSectionHeaders,
	getExportSectionRows,
	isExportSectionKey,
	parseRecurringSplitsForExport,
	toCsv,
} from '@/core/reads/export';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

function getExportFormat(req: NextRequest): 'json' | 'csv' | null {
	const format = req.nextUrl.searchParams.get('format');
	if (format === null || format === 'json') return 'json';
	if (format === 'csv') return 'csv';
	return null;
}

/** Per-section paging. The sentinel means "no cap" for plain full dumps. */
interface ExportPage {
	limit: number;
	offset: number;
}

const NO_EXPORT_LIMIT = Number.MAX_SAFE_INTEGER;
const EXPORT_LIMIT_MAX = 100_000;
/** Expense ids per split query; well below Postgres' 65,535 bind-param cap. */
const SPLIT_ID_CHUNK_SIZE = 10_000;

/**
 * Optional `limit`/`offset` params so a huge WG can page through the dump
 * instead of materialising every row in one response. Without params the
 * sections are returned without a row cap, as before.
 * Returns `null` when a param is present but unusable; `explicit` tells the
 * response whether to echo a `pagination` block.
 */
function parseExportPage(req: NextRequest): { page: ExportPage; explicit: boolean } | null {
	const params = req.nextUrl.searchParams;
	const rawLimit = params.get('limit');
	const rawOffset = params.get('offset');
	const limit = rawLimit === null ? NO_EXPORT_LIMIT : Number.parseInt(rawLimit, 10);
	const offset = rawOffset === null ? 0 : Number.parseInt(rawOffset, 10);
	if (!Number.isFinite(limit) || limit < 1 || (rawLimit !== null && limit > EXPORT_LIMIT_MAX)) {
		return null;
	}
	if (!Number.isFinite(offset) || offset < 0) return null;
	return { page: { limit, offset }, explicit: rawLimit !== null || rawOffset !== null };
}

const ALL_EXPORT_SECTIONS: ExportSectionKey[] = [
	'members',
	'expenses',
	'expensePayments',
	'recurringExpenses',
	'shoppingItems',
	'chores',
	'absences',
	'announcements',
	'auditEvents',
];

/**
 * Optional `sections=members,expenses` param for the JSON dump: only the
 * requested sections are fetched, bounding both memory and query load.
 * Returns `null` when a requested key is unknown.
 */
function parseRequestedSections(req: NextRequest): ExportSectionKey[] | null {
	const raw = req.nextUrl.searchParams.get('sections');
	if (raw === null) return ALL_EXPORT_SECTIONS;
	const parts = raw
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length === 0) return null;
	const sections: ExportSectionKey[] = [];
	for (const part of parts) {
		if (!isExportSectionKey(part)) return null;
		if (!sections.includes(part)) sections.push(part);
	}
	return sections;
}

type SectionResult<T> =
	| { section: ExportSectionKey; ok: true; value: T }
	| { section: ExportSectionKey; ok: false };

/**
 * Log each failed section while allowing the other section reads to settle.
 */
async function settleSection<T>(
	section: ExportSectionKey,
	fn: () => Promise<T>,
): Promise<SectionResult<T>> {
	try {
		return { section, ok: true, value: await fn() };
	} catch (err) {
		logApiError(`[export GET] section ${section} failed`, err);
		return { section, ok: false };
	}
}

function csvExportResponse(
	shareCode: string,
	section: ExportSectionKey,
	rows: Array<Record<string, unknown>>,
): NextResponse {
	return new NextResponse(toCsv(rows, getExportSectionHeaders(section)), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${shareCode}-${section}.csv"`,
		},
	});
}

interface ExportSplitRow {
	expenseId: string;
	debtorMemberId: string;
	amountCents: number;
	settledAt: Date | null;
}

/**
 * Group every split belonging to the given expenses by expense id.
 *
 * Both export paths — the expenses CSV section and the full JSON dump — read
 * the same rows the same way and built the same map, character for character.
 */
async function loadSplitsByExpense(expenseIds: string[]): Promise<Map<string, ExportSplitRow[]>> {
	const splitsByExpense = new Map<string, ExportSplitRow[]>();
	if (expenseIds.length === 0) return splitsByExpense;

	// Postgres caps a statement at 65,535 bind parameters, so a large (or
	// unlimited) page of expense ids is read in chunks.
	for (let start = 0; start < expenseIds.length; start += SPLIT_ID_CHUNK_SIZE) {
		const splitRows = await db
			.select({
				expenseId: expenseSplits.expenseId,
				debtorMemberId: expenseSplits.debtorMemberId,
				amountCents: expenseSplits.amountCents,
				settledAt: expenseSplits.settledAt,
			})
			.from(expenseSplits)
			.where(
				inArray(expenseSplits.expenseId, expenseIds.slice(start, start + SPLIT_ID_CHUNK_SIZE)),
			);

		for (const split of splitRows) {
			const splits = splitsByExpense.get(split.expenseId) ?? [];
			splits.push(split);
			splitsByExpense.set(split.expenseId, splits);
		}
	}
	return splitsByExpense;
}

/*
 * The CSV branch (one section, on demand) and the JSON branch (every section,
 * in one dump) used to run the same query and the same row-mapping twice —
 * once per branch. Below: one fetch + one map per section, shared by both.
 */

async function fetchMemberRows(wgId: string) {
	// Always the FULL roster: members are join-capped (small) and double as
	// the name directory for every other section — paging is only applied to
	// the potentially unbounded sections below.
	return db
		.select({ id: wgMembers.id, name: wgMembers.name, createdAt: wgMembers.createdAt })
		.from(wgMembers)
		.where(eq(wgMembers.wgId, wgId))
		.orderBy(asc(wgMembers.createdAt), asc(wgMembers.id));
}
type MemberRows = Awaited<ReturnType<typeof fetchMemberRows>>;

function toMemberById(memberRows: MemberRows): Map<string, string> {
	return new Map(memberRows.map((member) => [member.id, member.name]));
}
async function getMemberById(wgId: string): Promise<Map<string, string>> {
	return toMemberById(await fetchMemberRows(wgId));
}
function mapMemberRows(memberRows: MemberRows) {
	return memberRows.map((member) => ({
		id: member.id,
		name: member.name,
		createdAt: member.createdAt.toISOString(),
	}));
}

async function fetchExpenseRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: expenses.id,
			description: expenses.description,
			amountCents: expenses.amountCents,
			currency: expenses.currency,
			paidByMemberId: expenses.paidByMemberId,
			imageUrl: expenses.imageUrl,
			occurredAt: expenses.occurredAt,
		})
		.from(expenses)
		.where(eq(expenses.wgId, wgId))
		.orderBy(desc(expenses.occurredAt), desc(expenses.id))
		.limit(page.limit)
		.offset(page.offset);
}
function mapExpenseRows(
	expenseRows: Awaited<ReturnType<typeof fetchExpenseRows>>,
	memberById: Map<string, string>,
	splitsByExpense: Map<string, ExportSplitRow[]>,
) {
	return expenseRows.map((expense) => ({
		id: expense.id,
		description: expense.description,
		amountCents: expense.amountCents,
		currency: expense.currency,
		paidBy: memberById.get(expense.paidByMemberId) ?? '',
		paidByMemberId: expense.paidByMemberId,
		imageUrl: expense.imageUrl ?? '',
		occurredAt: expense.occurredAt.toISOString(),
		splits: formatExpenseSplitsForExport(splitsByExpense.get(expense.id) ?? [], memberById),
	}));
}

async function fetchExpensePaymentRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: expensePayments.id,
			fromMemberId: expensePayments.fromMemberId,
			toMemberId: expensePayments.toMemberId,
			amountCents: expensePayments.amountCents,
			currency: expensePayments.currency,
			completedAt: expensePayments.completedAt,
		})
		.from(expensePayments)
		.where(and(eq(expensePayments.wgId, wgId), eq(expensePayments.status, 'completed')))
		.orderBy(desc(expensePayments.completedAt), desc(expensePayments.id))
		.limit(page.limit)
		.offset(page.offset);
}

function mapExpensePaymentRows(paymentRows: Awaited<ReturnType<typeof fetchExpensePaymentRows>>) {
	return paymentRows.map((payment) => ({
		id: payment.id,
		fromMemberId: payment.fromMemberId,
		toMemberId: payment.toMemberId,
		amountCents: payment.amountCents,
		currency: payment.currency,
		completedAt: payment.completedAt?.toISOString() ?? null,
	}));
}

async function fetchRecurringRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: recurringExpenses.id,
			description: recurringExpenses.description,
			amountCents: recurringExpenses.amountCents,
			paidByMemberId: recurringExpenses.paidByMemberId,
			intervalMonths: recurringExpenses.intervalMonths,
			nextDueAt: recurringExpenses.nextDueAt,
			lastCreatedAt: recurringExpenses.lastCreatedAt,
			createdAt: recurringExpenses.createdAt,
			splitsJson: recurringExpenses.splitsJson,
		})
		.from(recurringExpenses)
		.where(eq(recurringExpenses.wgId, wgId))
		.orderBy(desc(recurringExpenses.nextDueAt), desc(recurringExpenses.id))
		.limit(page.limit)
		.offset(page.offset);
}
function mapRecurringRows(
	recurringRows: Awaited<ReturnType<typeof fetchRecurringRows>>,
	memberById: Map<string, string>,
) {
	return recurringRows.map((item) => ({
		id: item.id,
		description: item.description,
		amountCents: item.amountCents,
		currency: 'EUR',
		paidBy: memberById.get(item.paidByMemberId) ?? '',
		intervalMonths: item.intervalMonths,
		nextDueAt: item.nextDueAt.toISOString(),
		lastCreatedAt: item.lastCreatedAt?.toISOString() ?? '',
		createdAt: item.createdAt.toISOString(),
		splits: parseRecurringSplitsForExport(item.splitsJson, memberById),
	}));
}

async function fetchShoppingRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: shoppingItems.id,
			name: shoppingItems.name,
			quantity: shoppingItems.quantity,
			boughtAt: shoppingItems.boughtAt,
			createdAt: shoppingItems.createdAt,
		})
		.from(shoppingItems)
		.where(eq(shoppingItems.wgId, wgId))
		.orderBy(desc(shoppingItems.createdAt), desc(shoppingItems.id))
		.limit(page.limit)
		.offset(page.offset);
}
function mapShoppingRows(shoppingRows: Awaited<ReturnType<typeof fetchShoppingRows>>) {
	return shoppingRows.map((item) => ({
		id: item.id,
		name: item.name,
		quantity: item.quantity ?? '',
		status: item.boughtAt ? 'erledigt' : 'offen',
		createdAt: item.createdAt.toISOString(),
	}));
}

async function fetchChoreRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: chores.id,
			title: chores.title,
			assignedMemberId: chores.assignedMemberId,
			nextDueAt: chores.nextDueAt,
			intervalDays: chores.intervalDays,
		})
		.from(chores)
		.where(eq(chores.wgId, wgId))
		.orderBy(desc(chores.nextDueAt), desc(chores.id))
		.limit(page.limit)
		.offset(page.offset);
}
function mapChoreRows(
	choreRows: Awaited<ReturnType<typeof fetchChoreRows>>,
	memberById: Map<string, string>,
) {
	return choreRows.map((chore) => ({
		id: chore.id,
		title: chore.title,
		assignedName: chore.assignedMemberId ? (memberById.get(chore.assignedMemberId) ?? '') : '',
		nextDueAt: chore.nextDueAt.toISOString(),
		intervalDays: chore.intervalDays,
	}));
}

async function fetchAbsenceRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: memberAbsences.id,
			memberId: memberAbsences.memberId,
			startDate: memberAbsences.startDate,
			endDate: memberAbsences.endDate,
			reason: memberAbsences.reason,
			createdAt: memberAbsences.createdAt,
		})
		.from(memberAbsences)
		.where(eq(memberAbsences.wgId, wgId))
		.orderBy(desc(memberAbsences.startDate), desc(memberAbsences.id))
		.limit(page.limit)
		.offset(page.offset);
}
function mapAbsenceRows(
	absenceRows: Awaited<ReturnType<typeof fetchAbsenceRows>>,
	memberById: Map<string, string>,
) {
	return absenceRows.map((absence) => ({
		id: absence.id,
		memberName: memberById.get(absence.memberId) ?? '',
		startDate: absence.startDate.toISOString(),
		endDate: absence.endDate.toISOString(),
		reason: absence.reason ?? '',
		createdAt: absence.createdAt.toISOString(),
	}));
}

async function fetchAnnouncementRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: announcements.id,
			content: announcements.content,
			kind: announcements.kind,
			status: announcements.status,
			authorMemberId: announcements.authorMemberId,
			imageUrl: announcements.imageUrl,
			createdAt: announcements.createdAt,
		})
		.from(announcements)
		.where(eq(announcements.wgId, wgId))
		.orderBy(desc(announcements.createdAt), desc(announcements.id))
		.limit(page.limit)
		.offset(page.offset);
}
function mapAnnouncementRows(
	announcementRows: Awaited<ReturnType<typeof fetchAnnouncementRows>>,
	memberById: Map<string, string>,
) {
	return announcementRows.map((item) => ({
		id: item.id,
		content: item.content,
		kind: item.kind,
		status: item.status,
		authorName: memberById.get(item.authorMemberId) ?? '',
		imageUrl: item.imageUrl ?? '',
		createdAt: item.createdAt.toISOString(),
	}));
}

async function fetchAuditRows(wgId: string, page: ExportPage) {
	return db
		.select({
			id: auditEvents.id,
			memberId: auditEvents.memberId,
			eventType: auditEvents.eventType,
			entityType: auditEvents.entityType,
			summary: auditEvents.summary,
			createdAt: auditEvents.createdAt,
		})
		.from(auditEvents)
		.where(eq(auditEvents.wgId, wgId))
		.orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
		.limit(page.limit)
		.offset(page.offset);
}
function mapAuditRows(
	auditRows: Awaited<ReturnType<typeof fetchAuditRows>>,
	memberById: Map<string, string>,
) {
	return auditRows.map((item) => ({
		id: item.id,
		eventType: item.eventType,
		entityType: item.entityType,
		memberName: item.memberId ? (memberById.get(item.memberId) ?? '') : 'System',
		summary: item.summary,
		createdAt: item.createdAt.toISOString(),
	}));
}

export async function GET(
	req: NextRequest,
	ctx: RouteCtx<{ code: string }>,
): Promise<NextResponse> {
	const codeResult = await readShareCode(ctx);
	if (!codeResult.ok) return codeResult.response;
	const { code } = codeResult;
	const format = getExportFormat(req);
	if (!format) return badRequest('format_invalid');

	const e2e = await resolveE2EFixture(req, code);
	if (e2e.mode === 'denied') return e2e.response;
	if (e2e.mode === 'fixture') {
		const { fixture } = e2e;
		const now = new Date().toISOString();
		const data = buildWgExport({
			wg: { name: fixture.name, shareCode: fixture.shareCode },
			members: fixture.members.map((member) => ({
				id: member.id,
				name: member.name,
				createdAt: now,
			})),
			expenses: [],
			expensePayments: [],
			recurringExpenses: [],
			shoppingItems: [],
			chores: [],
			absences: [],
			announcements: [],
			auditEvents: [],
		});
		if (format === 'csv') {
			const requestedSection = req.nextUrl.searchParams.get('section');
			if (requestedSection !== null && !isExportSectionKey(requestedSection)) {
				return badRequest('section_invalid');
			}
			const section = requestedSection ?? 'expenses';
			return new NextResponse(
				toCsv(getExportSectionRows(data, section), getExportSectionHeaders(section)),
				{
					headers: {
						'content-type': 'text/csv; charset=utf-8',
						'content-disposition': `attachment; filename="${fixture.shareCode}-${section}.csv"`,
					},
				},
			);
		}
		return NextResponse.json(data);
	}

	try {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;

		// Keyed per member rather than per IP: a whole WG can sit behind one NAT,
		// and one member's export budget must not lock out their flatmates.
		const limit = await checkRateLimit(wgExportLimiter, `export:${wg.id}:${auth.member.memberId}`);
		if (!limit.success) return tooMany('rate_limited');

		const parsedPage = parseExportPage(req);
		if (!parsedPage) return badRequest('pagination_invalid');
		const { page, explicit: pageExplicit } = parsedPage;

		if (format === 'csv') {
			const requestedSection = req.nextUrl.searchParams.get('section');
			if (requestedSection !== null && !isExportSectionKey(requestedSection)) {
				return badRequest('section_invalid');
			}
			const section = requestedSection ?? 'expenses';

			// The section's own queries are the only things that can fail here —
			// a failure is logged with the section name and surfaced as a
			// section-specific error instead of a generic 500.
			const settled = await settleSection(section, async () => {
				if (section === 'members') {
					return mapMemberRows(await fetchMemberRows(wg.id));
				}
				if (section === 'expenses') {
					const [memberById, expenseRows] = await Promise.all([
						getMemberById(wg.id),
						fetchExpenseRows(wg.id, page),
					]);
					const splitsByExpense = await loadSplitsByExpense(
						expenseRows.map((expense) => expense.id),
					);
					return mapExpenseRows(expenseRows, memberById, splitsByExpense);
				}
				if (section === 'expensePayments') {
					return mapExpensePaymentRows(await fetchExpensePaymentRows(wg.id, page));
				}
				if (section === 'recurringExpenses') {
					const [memberById, recurringRows] = await Promise.all([
						getMemberById(wg.id),
						fetchRecurringRows(wg.id, page),
					]);
					return mapRecurringRows(recurringRows, memberById);
				}
				if (section === 'shoppingItems') {
					return mapShoppingRows(await fetchShoppingRows(wg.id, page));
				}
				if (section === 'chores') {
					const [memberById, choreRows] = await Promise.all([
						getMemberById(wg.id),
						fetchChoreRows(wg.id, page),
					]);
					return mapChoreRows(choreRows, memberById);
				}
				if (section === 'absences') {
					const [memberById, absenceRows] = await Promise.all([
						getMemberById(wg.id),
						fetchAbsenceRows(wg.id, page),
					]);
					return mapAbsenceRows(absenceRows, memberById);
				}
				if (section === 'announcements') {
					const [memberById, announcementRows] = await Promise.all([
						getMemberById(wg.id),
						fetchAnnouncementRows(wg.id, page),
					]);
					return mapAnnouncementRows(announcementRows, memberById);
				}
				const [memberById, auditRows] = await Promise.all([
					getMemberById(wg.id),
					fetchAuditRows(wg.id, page),
				]);
				return mapAuditRows(auditRows, memberById);
			});
			if (!settled.ok) return serverError(null, `export_section_failed:${section}`);
			return csvExportResponse(wg.shareCode, section, settled.value);
		}

		const parsedSections = parseRequestedSections(req);
		if (!parsedSections) return badRequest('section_invalid');
		const requestedSections = parsedSections;

		// Sections that join member names. The directory fetch is shared and
		// always covers the full roster; its failure marks exactly those
		// sections failed that depend on it.
		const DEPENDENT_ON_MEMBERS: Exclude<ExportSectionKey, 'members'>[] = [
			'expenses',
			'recurringExpenses',
			'chores',
			'absences',
			'announcements',
			'auditEvents',
		];
		const needsDirectory = requestedSections.some((section) =>
			DEPENDENT_ON_MEMBERS.includes(section as Exclude<ExportSectionKey, 'members'>),
		);
		const wantsMembers = requestedSections.includes('members');
		let memberRowsFetched: Awaited<ReturnType<typeof fetchMemberRows>> | null = null;
		let directoryFailed = false;
		if (wantsMembers || needsDirectory) {
			try {
				memberRowsFetched = await fetchMemberRows(wg.id);
			} catch (err) {
				directoryFailed = true;
				logApiError('[export GET] section members failed', err);
			}
		}
		const memberById = memberRowsFetched
			? toMemberById(memberRowsFetched)
			: new Map<string, string>();
		const requireDirectory = () => {
			if (directoryFailed) throw new Error('member_directory_unavailable');
		};

		const loaders: Record<Exclude<ExportSectionKey, 'members'>, () => Promise<ExportRow[]>> = {
			expenses: async () => {
				requireDirectory();
				const expenseRows = await fetchExpenseRows(wg.id, page);
				const splitsByExpense = await loadSplitsByExpense(expenseRows.map((expense) => expense.id));
				return mapExpenseRows(expenseRows, memberById, splitsByExpense);
			},
			expensePayments: async () =>
				mapExpensePaymentRows(await fetchExpensePaymentRows(wg.id, page)),
			recurringExpenses: async () => {
				requireDirectory();
				return mapRecurringRows(await fetchRecurringRows(wg.id, page), memberById);
			},
			shoppingItems: async () => mapShoppingRows(await fetchShoppingRows(wg.id, page)),
			chores: async () => {
				requireDirectory();
				return mapChoreRows(await fetchChoreRows(wg.id, page), memberById);
			},
			absences: async () => {
				requireDirectory();
				return mapAbsenceRows(await fetchAbsenceRows(wg.id, page), memberById);
			},
			announcements: async () => {
				requireDirectory();
				return mapAnnouncementRows(await fetchAnnouncementRows(wg.id, page), memberById);
			},
			auditEvents: async () => {
				requireDirectory();
				return mapAuditRows(await fetchAuditRows(wg.id, page), memberById);
			},
		};

		const failedSections: string[] = [];
		const rowsBySection = new Map<ExportSectionKey, ExportRow[]>();
		if (wantsMembers) {
			if (directoryFailed || !memberRowsFetched) failedSections.push('members');
			// Members are never paged (see fetchMemberRows) — the full roster
			// doubles as the name directory for every other section.
			else rowsBySection.set('members', mapMemberRows(memberRowsFetched));
		}

		const dependentKeys = requestedSections.filter(
			(section): section is Exclude<ExportSectionKey, 'members'> => section !== 'members',
		);
		const settledSections = await Promise.all(
			dependentKeys.map((section) => settleSection(section, loaders[section])),
		);
		for (const result of settledSections) {
			if (result.ok) rowsBySection.set(result.section, result.value);
			else failedSections.push(result.section);
		}

		// An export must contain every requested section.
		if (failedSections.length > 0) {
			return serverError(null, 'export_incomplete');
		}

		const data = buildWgExport({
			wg: { name: wg.name, shareCode: wg.shareCode },
			members: rowsBySection.get('members') ?? [],
			expenses: rowsBySection.get('expenses') ?? [],
			expensePayments: rowsBySection.get('expensePayments') ?? [],
			recurringExpenses: rowsBySection.get('recurringExpenses') ?? [],
			shoppingItems: rowsBySection.get('shoppingItems') ?? [],
			chores: rowsBySection.get('chores') ?? [],
			absences: rowsBySection.get('absences') ?? [],
			announcements: rowsBySection.get('announcements') ?? [],
			auditEvents: rowsBySection.get('auditEvents') ?? [],
		});

		return NextResponse.json({
			...data,
			failedSections,
			...(pageExplicit ? { pagination: { limit: page.limit, offset: page.offset } } : {}),
		});
	} catch (err) {
		logApiError('[export GET]', err);
		return serverError(err);
	}
}
