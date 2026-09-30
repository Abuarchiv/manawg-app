import { postSystemNotice } from '@/core/activity-feed';
import { recordAuditEvent } from '@/core/audit';
import {
	db,
	expenseImports,
	expenseSplits,
	expenses,
	idempotencyResponses,
	wgMembers,
} from '@/core/db';
import { type DbTransaction, TransactionAbort } from '@/core/db/transaction';
import { RESPONSE_REPLAY_TTL_SECONDS } from '@/core/idempotency';
import {
	type NotificationDispatchWarning,
	dispatchNotificationSafely,
} from '@/core/notifications/notification-dispatch';
import { formatEuroCents } from '@/core/utils/money';
import {
	hasCapturingExpensePayment,
	withExpensePaymentLock,
} from '@/features/expenses/expense-payments';
import { settledAtForOwnShare } from '@/features/expenses/split-math';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ImportSource, ParsedExpense } from './import-parsers';

interface CommitInput {
	wg: { id: string; name: string; shareCode: string };
	source: ImportSource;
	importedByMemberId: string;
	importedByName: string;
	expenses: ReadonlyArray<{ parsed: ParsedExpense; skip: boolean }>;
	mapping: Readonly<Record<string, string | null>>;
	skipDuplicates: boolean;
	rawPayloadHash: string;
	replay?: { scope: string; key: string };
}

export interface CommitResult {
	importId: string;
	inserted: number;
	skipped: number;
	errors: Array<{ index: number; reason: string }>;
	warning: NotificationDispatchWarning;
}

function buildDuplicateKey(
	date: string,
	description: string,
	amountCents: number,
	paidByMemberId: string,
	currency: string,
): string {
	const key = [date.slice(0, 10), description.trim().toLowerCase(), amountCents, paidByMemberId];
	// EUR import keys already persisted in this four-part format; keep them stable.
	return (currency === 'EUR' ? key : [...key, currency]).join('|');
}

// Reads inside the same transaction as the writes: the duplicate keys are the
// yardstick for every row of this import, so they must not be a snapshot taken
// before a concurrent import added rows.
async function loadDuplicateKeys(tx: DbTransaction, wgId: string): Promise<Set<string>> {
	const rows = await tx
		.select({
			occurredAt: expenses.occurredAt,
			description: expenses.description,
			amountCents: expenses.amountCents,
			currency: expenses.currency,
			paidByMemberId: expenses.paidByMemberId,
		})
		.from(expenses)
		.where(eq(expenses.wgId, wgId));
	const set = new Set<string>();
	for (const r of rows) {
		const iso =
			r.occurredAt instanceof Date
				? r.occurredAt.toISOString()
				: new Date(r.occurredAt).toISOString();
		set.add(buildDuplicateKey(iso, r.description, r.amountCents, r.paidByMemberId, r.currency));
	}
	return set;
}

/**
 * Every member in a row that will be imported must belong to this WG. Skipped
 * preview rows are excluded; validation runs before the import row exists.
 */
async function assertMembersInWg(input: CommitInput): Promise<void> {
	const memberIds = new Set<string>();
	for (const item of input.expenses) {
		if (item.skip) continue;
		const paid = input.mapping[item.parsed.paidByName];
		if (paid) memberIds.add(paid);
		for (const split of item.parsed.splits) {
			const mapped = input.mapping[split.memberName];
			if (mapped) memberIds.add(mapped);
		}
	}
	const memberIdsList = Array.from(memberIds);
	if (memberIdsList.length === 0) return;

	const memberRows = await db
		.select({ id: wgMembers.id })
		.from(wgMembers)
		.where(
			and(
				eq(wgMembers.wgId, input.wg.id),
				inArray(wgMembers.id, memberIdsList),
				isNull(wgMembers.deactivatedAt),
			),
		);
	const validIds = new Set(memberRows.map((m) => m.id));
	for (const id of memberIdsList) {
		if (!validIds.has(id)) throw new Error('member_not_in_wg');
	}
}

type SplitRow = { debtorMemberId: string; amountCents: number };

type PreparedRow =
	| { ok: true; paidByMemberId: string; splitRows: SplitRow[]; duplicateKey: string }
	| { ok: false; reason: string };

/**
 * Turns one parsed row into what the insert needs, or into the reason why it
 * cannot be inserted. A rejected row is reported back to the user and does not
 * abort the import — only a failing database call does.
 */
function prepareRow(input: CommitInput, parsed: ParsedExpense): PreparedRow {
	const paidByMemberId = input.mapping[parsed.paidByName];
	if (!paidByMemberId) return { ok: false, reason: 'payer_unmapped' };

	const splitRows = parsed.splits
		.map((s) => ({ debtorMemberId: input.mapping[s.memberName], amountCents: s.amountCents }))
		.filter((s): s is SplitRow => Boolean(s.debtorMemberId));
	if (splitRows.length === 0) return { ok: false, reason: 'no_valid_splits' };

	const splitSum = splitRows.reduce((acc, s) => acc + s.amountCents, 0);
	if (splitSum !== parsed.amountCents) return { ok: false, reason: 'split_sum_mismatch' };

	return {
		ok: true,
		paidByMemberId,
		splitRows,
		duplicateKey: buildDuplicateKey(
			parsed.date,
			parsed.description,
			parsed.amountCents,
			paidByMemberId,
			parsed.currency,
		),
	};
}

interface ImportWriteResult {
	importId: string;
	inserted: number;
	skipped: number;
	errors: Array<{ index: number; reason: string }>;
	totalAmountCents: number;
}

type ImportTransactionResult =
	| { replayed: true; result: CommitResult }
	| { replayed: false; value: ImportWriteResult };

function isClaimPlaceholder(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		(value as Record<string, unknown>)._claimed === true
	);
}

export function isCommitResult(value: unknown): value is CommitResult {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	return (
		Object.keys(body).length === 5 &&
		typeof body.importId === 'string' &&
		body.importId.length > 0 &&
		Number.isInteger(body.inserted) &&
		Number(body.inserted) >= 0 &&
		Number.isInteger(body.skipped) &&
		Number(body.skipped) >= 0 &&
		Array.isArray(body.errors) &&
		body.errors.every(
			(error: unknown) =>
				error !== null &&
				typeof error === 'object' &&
				Number.isInteger((error as { index?: unknown }).index) &&
				typeof (error as { reason?: unknown }).reason === 'string',
		) &&
		(body.warning === null ||
			body.warning === 'notification_delivery_failed' ||
			body.warning === 'notification_delivery_unknown')
	);
}

/**
 * Writes the import row, every accepted expense with its splits and the final
 * counters. Runs inside one transaction, so a failure anywhere leaves the WG
 * exactly as it was: an expense without splits, or expenses without the import
 * row that documents where they came from, would both be wrong balances.
 */
async function writeImport(
	tx: DbTransaction,
	input: CommitInput,
): Promise<ImportTransactionResult> {
	if (input.replay) {
		const [slot] = await tx
			.select({ body: idempotencyResponses.responseBody })
			.from(idempotencyResponses)
			.where(
				and(
					eq(idempotencyResponses.scope, input.replay.scope),
					eq(idempotencyResponses.key, input.replay.key),
				),
			)
			.limit(1)
			.for('update');
		if (!slot) throw new Error('idempotency_claim_missing');
		if (isCommitResult(slot.body)) return { replayed: true, result: slot.body };
		if (!isClaimPlaceholder(slot.body)) throw new Error('idempotency_claim_invalid');
	}

	if (await hasCapturingExpensePayment(tx, input.wg.id)) {
		throw new TransactionAbort('paypal_payment_pending');
	}
	const [imp] = await tx
		.insert(expenseImports)
		.values({
			wgId: input.wg.id,
			source: input.source,
			importedByMemberId: input.importedByMemberId,
			rowCountTotal: input.expenses.length,
			rawPayloadHash: input.rawPayloadHash,
			memberMapping: input.mapping as unknown as Record<string, unknown>,
		})
		.returning({ id: expenseImports.id });
	if (!imp) throw new Error('import_insert_failed');

	const errors: Array<{ index: number; reason: string }> = [];
	let inserted = 0;
	let skipped = 0;
	let totalAmountCents = 0;

	const duplicateKeys = input.skipDuplicates
		? await loadDuplicateKeys(tx, input.wg.id)
		: new Set<string>();

	for (let i = 0; i < input.expenses.length; i += 1) {
		const item = input.expenses[i];
		if (!item) continue;
		if (item.skip) {
			skipped += 1;
			continue;
		}
		const parsed = item.parsed;
		const prepared = prepareRow(input, parsed);
		if (!prepared.ok) {
			errors.push({ index: i, reason: prepared.reason });
			continue;
		}
		if (input.skipDuplicates && duplicateKeys.has(prepared.duplicateKey)) {
			skipped += 1;
			continue;
		}

		const expenseInsert = tx.insert(expenses).values({
			wgId: input.wg.id,
			paidByMemberId: prepared.paidByMemberId,
			amountCents: parsed.amountCents,
			currency: parsed.currency,
			description: parsed.description,
			importId: imp.id,
			importDuplicateKey: input.skipDuplicates ? prepared.duplicateKey : null,
			occurredAt: new Date(parsed.date),
		});
		const [row] = input.skipDuplicates
			? await expenseInsert
					.onConflictDoNothing({
						target: [expenses.wgId, expenses.importDuplicateKey],
						where: sql`${expenses.importDuplicateKey} IS NOT NULL`,
					})
					.returning({ id: expenses.id })
			: await expenseInsert.returning({ id: expenses.id });
		if (!row) {
			if (input.skipDuplicates) {
				skipped += 1;
				duplicateKeys.add(prepared.duplicateKey);
			} else {
				errors.push({ index: i, reason: 'insert_failed' });
			}
			continue;
		}

		await tx.insert(expenseSplits).values(
			prepared.splitRows.map((s) => ({
				expenseId: row.id,
				debtorMemberId: s.debtorMemberId,
				amountCents: s.amountCents,
				settledAt: settledAtForOwnShare(s.debtorMemberId, prepared.paidByMemberId),
			})),
		);
		inserted += 1;
		totalAmountCents += parsed.amountCents;
		duplicateKeys.add(prepared.duplicateKey);
	}

	await tx
		.update(expenseImports)
		.set({
			rowCountInserted: inserted,
			rowCountSkipped: skipped,
			errorCount: errors.length,
			finishedAt: new Date(),
		})
		.where(eq(expenseImports.id, imp.id));

	if (input.replay) {
		const result: CommitResult = { importId: imp.id, inserted, skipped, errors, warning: null };
		const rows = await tx
			.update(idempotencyResponses)
			.set({
				responseBody: result,
				expiresAt: new Date(Date.now() + RESPONSE_REPLAY_TTL_SECONDS * 1000),
			})
			.where(
				and(
					eq(idempotencyResponses.scope, input.replay.scope),
					eq(idempotencyResponses.key, input.replay.key),
				),
			)
			.returning({ scope: idempotencyResponses.scope });
		if (rows.length !== 1) throw new Error('idempotency_claim_missing');
	}

	return {
		replayed: false,
		value: { importId: imp.id, inserted, skipped, errors, totalAmountCents },
	};
}

export async function commitImport(input: CommitInput): Promise<CommitResult> {
	await assertMembersInWg(input);

	// The whole import is one transaction. It used to be a sequence of separate
	// statements with a hand-written repair on failure: delete the expenses
	// already written, delete the import row, both with `.catch(() => undefined)`
	// on top. That repair is itself a database call, and swallowing its failure
	// meant a half-written import stayed in the WG while the caller only saw an
	// error and imported the same file again.
	const transactionResult = await withExpensePaymentLock(input.wg.id, (tx) =>
		writeImport(tx, input),
	);
	if (transactionResult.replayed) return transactionResult.result;
	const { importId, inserted, skipped, errors, totalAmountCents } = transactionResult.value;

	// Everything below is deliberately outside the transaction: it informs the
	// WG about an import that already happened, so a failure here must not undo
	// the import itself.
	const importedLabel = `${inserted} ${inserted === 1 ? 'Ausgabe' : 'Ausgaben'}`;
	await postSystemNotice({
		wgId: input.wg.id,
		authorMemberId: input.importedByMemberId,
		kind: 'info',
		source: 'expense',
		content: `${input.importedByName} hat ${importedLabel} importiert (${input.source}).`,
	});

	await recordAuditEvent({
		wgId: input.wg.id,
		memberId: input.importedByMemberId,
		eventType: 'import.completed',
		entityType: 'expense_import',
		entityId: importId,
		summary: `${input.importedByName} hat ${importedLabel} importiert.`,
		metadata: {
			source: input.source,
			inserted,
			skipped,
			errorCount: errors.length,
			totalAmountCents,
		},
	});

	const { warning } = await dispatchNotificationSafely({
		wg: input.wg,
		event: 'import.completed',
		payload: {
			actorName: input.importedByName,
			inserted,
			totalAmountCents,
			amountFormatted: formatEuroCents(totalAmountCents, 'EUR'),
		},
		excludeMemberId: input.importedByMemberId,
	});

	return { importId, inserted, skipped, errors, warning };
}
