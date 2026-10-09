import 'server-only';
import { recordAuditEvent } from '@/core/audit';
import { db, expenses, recurringExpenses, wgMembers } from '@/core/db';
import { requireOwnerOrAdmin } from '@/core/guards/admin';
import { badRequest, conflict, forbidden, notFound } from '@/core/http/api-errors';
import { isRecurringDueAtEditAllowed } from '@/core/validators/recurring-due-date';
import { checkPaidByGuard } from '@/features/expenses/paid-by-guard';
import {
	addMonthsFromAnchor,
	parseRecurringSplits,
	recurringDueDateMatchesExpected,
	serializeRecurringExpense,
} from '@/features/expenses/recurring-expenses';
import {
	advanceRecurringDue,
	recordRecurringAdvanced,
} from '@/features/expenses/server/recurring-booking';
import { splitValidationErrorCode, validateSplits } from '@/features/expenses/split-math';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';

type RecurringTemplate = typeof recurringExpenses.$inferSelect;
type Split = { debtorMemberId: string; amountCents: number };

interface Caller {
	wgId: string;
	member: { memberId: string; name: string };
}

export interface RecurringTemplateEdit {
	id: string;
	description?: string | undefined;
	amountCents?: number | undefined;
	paidByMemberId?: string | undefined;
	intervalMonths?: number | undefined;
	nextDueAt?: string | undefined;
	/** The due date the editor loaded; a booking since then makes the edit stale. */
	expectedNextDueAt?: string | undefined;
	splits?: Split[] | undefined;
	paused?: boolean | undefined;
}

function auditMetadata(template: RecurringTemplate, splitCount: number) {
	return {
		description: template.description,
		amountCents: template.amountCents,
		currency: 'EUR',
		intervalMonths: template.intervalMonths,
		nextDueAt: template.nextDueAt.toISOString(),
		splitCount,
	};
}

function hasFinancialChange(
	edit: RecurringTemplateEdit,
	template: RecurringTemplate,
	splits: Split[],
	templateSplits: Split[],
): boolean {
	const existingSplitAmounts = new Map(
		templateSplits.map(({ debtorMemberId, amountCents }) => [debtorMemberId, amountCents] as const),
	);
	const hasSplitChange =
		edit.splits !== undefined &&
		(splits.length !== templateSplits.length ||
			splits.some(
				({ debtorMemberId, amountCents }) =>
					existingSplitAmounts.get(debtorMemberId) !== amountCents,
			));
	return (
		(edit.amountCents !== undefined && edit.amountCents !== template.amountCents) ||
		(edit.paidByMemberId !== undefined && edit.paidByMemberId !== template.paidByMemberId) ||
		hasSplitChange
	);
}

type PauseTransition = 'pause' | 'resume' | null;

function pauseTransition(
	paused: boolean | undefined,
	template: RecurringTemplate,
): PauseTransition {
	if (paused === true && !template.pausedAt) return 'pause';
	if (paused === false && template.pausedAt) return 'resume';
	return null;
}

/**
 * Resuming does not book the missed charges: the due date moves to the first cycle day from
 * today on (due today stays due); otherwise the cron would book every paused month.
 */
function resumedDueAt(dueAt: Date, template: RecurringTemplate, intervalMonths: number): Date {
	const anchorDay = (template.anchorAt ?? template.nextDueAt).getUTCDate();
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	let next = dueAt;
	while (next < today) next = addMonthsFromAnchor(next, anchorDay, intervalMonths);
	return next;
}

/** A requested due date on another calendar day than the current one, else null. */
function movedDueAt(requested: string | undefined, template: RecurringTemplate): Date | null {
	if (requested === undefined) return null;
	const date = new Date(requested);
	return date.toISOString().slice(0, 10) !== template.nextDueAt.toISOString().slice(0, 10)
		? date
		: null;
}

const AUDIT = {
	pause: { eventType: 'recurring.paused', action: 'hat die Fixkosten {d} pausiert.' },
	resume: { eventType: 'recurring.resumed', action: 'hat die Fixkosten {d} reaktiviert.' },
	edit: { eventType: 'recurring.updated', action: 'hat die Fixkosten-Vorlage {d} aktualisiert.' },
} as const;

const EDIT_FIELDS = [
	'description',
	'amountCents',
	'paidByMemberId',
	'intervalMonths',
	'nextDueAt',
	'splits',
] as const;

/**
 * Edit, pause or resume a template; that is the owner's (or an admin's) call. The update is a
 * compare-and-set on the due date (or on the pause state): an editor that loaded an older due
 * date, or a booking (cron or "Erfassen") that moved it meanwhile, must not get the stale date
 * written back.
 */
export async function editRecurringTemplate(
	caller: Caller,
	template: RecurringTemplate,
	edit: RecurringTemplateEdit,
): Promise<NextResponse> {
	const { wgId, member } = caller;
	const denied = await requireOwnerOrAdmin(wgId, member, template.createdByMemberId);
	if (denied) return denied;
	if (
		edit.expectedNextDueAt !== undefined &&
		!recurringDueDateMatchesExpected(template.nextDueAt.toISOString(), edit.expectedNextDueAt)
	) {
		return conflict('recurring_expense_changed', 'recurring_expense_changed');
	}
	if (
		edit.nextDueAt !== undefined &&
		!isRecurringDueAtEditAllowed(edit.nextDueAt, template.nextDueAt)
	) {
		return badRequest('due_date_invalid');
	}
	const paidByMemberId = edit.paidByMemberId ?? template.paidByMemberId;
	const templateSplits = parseRecurringSplits(template.splitsJson);
	const splits = edit.splits ?? templateSplits;
	const amountCents = edit.amountCents ?? template.amountCents;
	const intervalMonths = edit.intervalMonths ?? template.intervalMonths;
	const splitCheck = validateSplits(amountCents, splits);
	if (!splitCheck.ok) return badRequest(splitValidationErrorCode(splitCheck.reason));

	const onlyPause =
		edit.paused !== undefined && EDIT_FIELDS.every((field) => edit[field] === undefined);
	const memberIds = Array.from(new Set([paidByMemberId, ...splits.map((s) => s.debtorMemberId)]));
	const memberRows = await db
		.select({ id: wgMembers.id })
		.from(wgMembers)
		.where(
			and(
				eq(wgMembers.wgId, wgId),
				inArray(wgMembers.id, memberIds),
				// A template stays pausable after a participant left.
				...(onlyPause && edit.paused === true ? [] : [isNull(wgMembers.deactivatedAt)]),
			),
		);
	if (memberRows.length !== memberIds.length) return badRequest('member_not_in_wg');
	if (
		hasFinancialChange(edit, template, splits, templateSplits) &&
		!checkPaidByGuard(paidByMemberId, member.memberId, splits).ok
	) {
		return forbidden('paid_by_must_include_caller', 'paid_by_must_include_caller');
	}

	const transition = pauseTransition(edit.paused, template);
	if (onlyPause && transition === null) {
		return NextResponse.json({ recurringExpense: serializeRecurringExpense(template) });
	}
	// Only a really moved due date re-anchors the cadence. The edit form resends the unchanged
	// date on every save; re-anchoring then would pin a clamped 28.02. as the new anchor day and
	// lose the 31st.
	const moved = movedDueAt(edit.nextDueAt, template);
	const dueAt = moved ?? template.nextDueAt;
	const byId = and(eq(recurringExpenses.id, template.id), eq(recurringExpenses.wgId, wgId));
	const [updated] = await db
		.update(recurringExpenses)
		.set({
			description: edit.description ?? template.description,
			amountCents,
			paidByMemberId,
			intervalMonths,
			nextDueAt:
				transition === 'resume' && edit.nextDueAt === undefined
					? resumedDueAt(dueAt, template, intervalMonths)
					: dueAt,
			anchorAt: moved ?? template.anchorAt ?? template.nextDueAt,
			splitsJson: JSON.stringify(splits),
			updatedAt: new Date(),
			...(transition === 'pause' ? { pausedAt: new Date() } : {}),
			...(transition === 'resume' ? { pausedAt: null } : {}),
		})
		.where(
			and(
				byId,
				transition === 'pause'
					? isNull(recurringExpenses.pausedAt)
					: transition === 'resume'
						? isNotNull(recurringExpenses.pausedAt)
						: eq(recurringExpenses.nextDueAt, template.nextDueAt),
			),
		)
		.returning();
	if (!updated) {
		const [current] = await db.select().from(recurringExpenses).where(byId).limit(1);
		if (!current) return notFound('recurring_expense_not_found');
		// A concurrent request already paused or resumed it.
		if (transition !== null) {
			return NextResponse.json({ recurringExpense: serializeRecurringExpense(current) });
		}
		return conflict('recurring_expense_changed', 'recurring_expense_changed');
	}
	const audit = AUDIT[transition ?? 'edit'];
	await recordAuditEvent({
		wgId,
		memberId: member.memberId,
		eventType: audit.eventType,
		entityType: 'recurring_expense',
		entityId: updated.id,
		summary: `${member.name} ${audit.action.replace('{d}', updated.description)}`,
		metadata: {
			...auditMetadata(updated, splits.length),
			pausedAt: updated.pausedAt?.toISOString() ?? null,
		},
	});
	return NextResponse.json({ recurringExpense: serializeRecurringExpense(updated) });
}

/** Delete a template, for its owner or an admin. Booked charges stay. */
export async function deleteRecurringTemplate(caller: Caller, id: string): Promise<NextResponse> {
	const { wgId, member } = caller;
	const byId = and(eq(recurringExpenses.id, id), eq(recurringExpenses.wgId, wgId));
	const [template] = await db.select().from(recurringExpenses).where(byId).limit(1);
	if (!template) return notFound('recurring_expense_not_found');
	const denied = await requireOwnerOrAdmin(wgId, member, template.createdByMemberId);
	if (denied) return denied;

	const deleted = await db
		.delete(recurringExpenses)
		.where(byId)
		.returning({ id: recurringExpenses.id });
	if (deleted.length === 0) return notFound('recurring_expense_not_found');

	await recordAuditEvent({
		wgId,
		memberId: member.memberId,
		eventType: 'recurring.deleted',
		entityType: 'recurring_expense',
		entityId: template.id,
		summary: `${member.name} hat die Fixkosten-Vorlage ${template.description} gelöscht.`,
		metadata: {
			description: template.description,
			amountCents: template.amountCents,
			currency: 'EUR',
			intervalMonths: template.intervalMonths,
			nextDueAt: template.nextDueAt.toISOString(),
		},
	});
	return NextResponse.json({ deleted: true });
}

/**
 * Move a template's due date on by one interval after a member booked the charge. Every member
 * may do this, but only while a booking for the current due date exists (otherwise the charge
 * would be skipped); the compare-and-set on `expectedNextDueAt` keeps two bookings from
 * advancing twice.
 */
export async function advanceRecurringTemplate(
	caller: Caller,
	template: RecurringTemplate,
	expectedNextDueAt: string | undefined,
): Promise<NextResponse> {
	const { wgId, member } = caller;
	if (
		expectedNextDueAt &&
		!recurringDueDateMatchesExpected(template.nextDueAt.toISOString(), expectedNextDueAt)
	) {
		return conflict('recurring_expense_already_advanced');
	}
	if (template.pausedAt) return badRequest('abo_paused');
	const [booked] = await db
		.select({ id: expenses.id })
		.from(expenses)
		.where(
			and(
				eq(expenses.wgId, wgId),
				eq(expenses.recurringExpenseId, template.id),
				eq(expenses.recurringDueAt, template.nextDueAt),
			),
		)
		.limit(1);
	if (!booked) return conflict('recurring_expense_not_booked');
	const updated = await advanceRecurringDue(db, template);
	if (!updated) {
		const [current] = await db
			.select()
			.from(recurringExpenses)
			.where(and(eq(recurringExpenses.id, template.id), eq(recurringExpenses.wgId, wgId)))
			.limit(1);
		if (!current) return notFound('recurring_expense_not_found');
		if (
			!recurringDueDateMatchesExpected(
				current.nextDueAt.toISOString(),
				template.nextDueAt.toISOString(),
			)
		) {
			return conflict('recurring_expense_already_advanced');
		}
		if (current.pausedAt) return badRequest('abo_paused');
		return conflict('recurring_expense_already_advanced');
	}
	await recordRecurringAdvanced(member.memberId, updated);
	return NextResponse.json({ recurringExpense: serializeRecurringExpense(updated) });
}
