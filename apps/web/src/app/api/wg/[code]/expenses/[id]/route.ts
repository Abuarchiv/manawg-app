import { recordAuditEvent } from '@/core/audit';
import { db, expenseSplits, expenses, wgMembers } from '@/core/db';
import {
	assertPrivateImageCanBeAttached,
	revokePrivateImageIfUnreferenced,
} from '@/core/db/private-image-deletions';
import { TransactionAbort } from '@/core/db/transaction';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import {
	badRequest,
	conflict,
	forbidden,
	notFound,
	serverError,
	tooMany,
} from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import { logApiError } from '@/core/infra/observability';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { currencySchema } from '@/core/validators/currency';
import { imageUrlSchema, isAllowedImageUrlForWg } from '@/core/validators/image-url';
import { MAX_SPLITS } from '@/features/expenses/expense-constants';
import {
	expenseAmountSchema,
	expenseDescriptionSchema,
	expenseSplitSchema,
	occurredAtSchema,
} from '@/features/expenses/expense-schemas';
import {
	hasCapturingExpensePayment,
	withExpensePaymentLock,
} from '@/features/expenses/server/expense-payments';
import {
	settledAtForOwnShare,
	splitValidationErrorCode,
	validateSplits,
} from '@/features/expenses/split-math';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const patchSchema = z.object({
	description: expenseDescriptionSchema.optional(),
	amountCents: expenseAmountSchema.optional(),
	currency: currencySchema.optional(),
	imageUrl: imageUrlSchema,
	occurredAt: occurredAtSchema.optional(),
	expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
	splits: z.array(expenseSplitSchema).min(1).max(MAX_SPLITS).optional(),
});

export const DELETE = withWgRoute<{ id: string }>('expense DELETE', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;

	const limited = await checkRateLimit(wgWriteLimiter, `expense:${wgId}:${auth.member.memberId}`);
	if (!limited.success) return tooMany();

	// Allow deletion by: the original payer OR any debtor in the expense splits.
	// This lets victims of fake expenses remove them without being the payer.
	const deletion = await withExpensePaymentLock(wgId, async (tx) => {
		const existing = await tx
			.select({
				paidByMemberId: expenses.paidByMemberId,
				description: expenses.description,
				amountCents: expenses.amountCents,
				imageUrl: expenses.imageUrl,
			})
			.from(expenses)
			.where(and(eq(expenses.id, id), eq(expenses.wgId, wgId)))
			.limit(1);
		const row = existing[0];
		if (!row) return { ok: false as const, response: notFound('expense_not_found') };

		const callerId = auth.member.memberId;
		if (row.paidByMemberId !== callerId) {
			const splitRow = await tx
				.select({ debtorMemberId: expenseSplits.debtorMemberId })
				.from(expenseSplits)
				.where(and(eq(expenseSplits.expenseId, id), eq(expenseSplits.debtorMemberId, callerId)))
				.limit(1);
			if (splitRow.length === 0) {
				return { ok: false as const, response: forbidden('not_owner', 'not_owner') };
			}
		}

		if (await hasCapturingExpensePayment(tx, wgId)) {
			return { ok: false as const, response: conflict('paypal_payment_pending') };
		}
		const deleted = await tx
			.delete(expenses)
			.where(and(eq(expenses.id, id), eq(expenses.wgId, wgId)))
			.returning({ id: expenses.id });
		if (deleted.length === 0) {
			return { ok: false as const, response: notFound('expense_not_found') };
		}
		await revokePrivateImageIfUnreferenced(tx, wgId, row.imageUrl);
		return { ok: true as const, row };
	});
	if (!deletion.ok) return deletion.response;
	const { row } = deletion;
	await recordAuditEvent({
		wgId,
		memberId: auth.member.memberId,
		eventType: 'expense.deleted',
		entityType: 'expense',
		entityId: id,
		summary: `${auth.member.name} hat ${row.description} entfernt.`,
		metadata: {
			description: row.description,
			amountCents: row.amountCents,
		},
	});
	return NextResponse.json({ deleted: true });
});

export const PATCH = withWgRoute<{ id: string }>('expense PATCH', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

	const parsed = await parseBody(req, patchSchema, {
		fieldErrors: {
			amountCents: 'amount_invalid',
			description: 'description_invalid',
			currency: 'currency_invalid',
			imageUrl: 'image_invalid',
			occurredAt: 'occurred_at_invalid',
			expectedUpdatedAt: 'expected_updated_at_invalid',
			splits: 'splits_invalid',
		},
	});
	if (!parsed.ok) return parsed.response;

	const { description, amountCents, currency, imageUrl, occurredAt, expectedUpdatedAt, splits } =
		parsed.data;

	// A total change without a matching splits array would silently desync
	// expenses.amountCents from sum(expenseSplits.amountCents) — the invariant
	// every balance calculation (computeBalances, computeNetBalances, ...)
	// relies on. Splits must be sent together with a new amount.
	if (amountCents !== undefined && !splits) {
		return badRequest('splits_required_with_amount');
	}

	if (splits) {
		const seenDebtors = new Set<string>();
		for (const split of splits) {
			if (seenDebtors.has(split.debtorMemberId)) {
				return badRequest('splits_duplicate_debtor');
			}
			seenDebtors.add(split.debtorMemberId);
		}
	}

	if (splits && amountCents !== undefined) {
		const splitCheck = validateSplits(amountCents, splits);
		if (!splitCheck.ok) {
			return badRequest(splitValidationErrorCode(splitCheck.reason));
		}
	}
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;
	if (!isAllowedImageUrlForWg(imageUrl, wgId)) return badRequest('image_invalid');

	const limited = await checkRateLimit(wgWriteLimiter, `expense:${wgId}:${auth.member.memberId}`);
	if (!limited.success) return tooMany();

	const existing = await db
		.select({
			paidByMemberId: expenses.paidByMemberId,
			amountCents: expenses.amountCents,
			updatedAt: expenses.updatedAt,
		})
		.from(expenses)
		.where(and(eq(expenses.id, id), eq(expenses.wgId, wgId)))
		.limit(1);
	const row = existing[0];
	if (!row) return notFound('expense_not_found');

	if (row.paidByMemberId !== auth.member.memberId) {
		return forbidden('not_payer', 'not_payer');
	}
	const expectedVersion = expectedUpdatedAt ? new Date(expectedUpdatedAt) : undefined;
	if (expectedVersion && row.updatedAt.getTime() !== expectedVersion.getTime()) {
		return conflict('expense_changed', 'expense_conflict');
	}
	if (splits) {
		const nextAmountCents = amountCents ?? row.amountCents;
		const splitCheck = validateSplits(nextAmountCents, splits);
		if (!splitCheck.ok) {
			return badRequest(splitValidationErrorCode(splitCheck.reason));
		}
	}

	const updates: Partial<typeof expenses.$inferInsert> = {};
	if (description !== undefined) updates.description = description;
	if (amountCents !== undefined) updates.amountCents = amountCents;
	if (currency !== undefined) updates.currency = currency;
	if (imageUrl !== undefined) updates.imageUrl = imageUrl ?? null;
	if (occurredAt !== undefined) updates.occurredAt = new Date(occurredAt);

	// The amount change and the replaced splits are one edit, so they are written in one
	// transaction: a failure leaves the old splits in place instead of an expense with none.
	try {
		await withExpensePaymentLock(wgId, async (tx) => {
			let previousImageUrl: string | null = null;
			if (imageUrl !== undefined) {
				const [currentImage] = await tx
					.select({ imageUrl: expenses.imageUrl })
					.from(expenses)
					.where(and(eq(expenses.id, id), eq(expenses.wgId, wgId)))
					.limit(1);
				if (!currentImage) throw new TransactionAbort('expense_not_found');
				previousImageUrl = currentImage.imageUrl;
				await assertPrivateImageCanBeAttached(tx, wgId, imageUrl ?? null, previousImageUrl);
			}
			if (
				(amountCents !== undefined || currency !== undefined || splits !== undefined) &&
				(await hasCapturingExpensePayment(tx, wgId))
			) {
				throw new TransactionAbort('paypal_payment_pending');
			}
			const previousSplits = splits
				? await tx
						.select({
							debtorMemberId: expenseSplits.debtorMemberId,
							amountCents: expenseSplits.amountCents,
							settledAt: expenseSplits.settledAt,
						})
						.from(expenseSplits)
						.where(eq(expenseSplits.expenseId, id))
				: [];
			if (splits) {
				const relevantDebtorIds = Array.from(
					new Set([
						...previousSplits.map((split) => split.debtorMemberId),
						...splits.map((split) => split.debtorMemberId),
					]),
				);
				const activeMembers = await tx
					.select({ id: wgMembers.id })
					.from(wgMembers)
					.where(
						and(
							eq(wgMembers.wgId, wgId),
							inArray(wgMembers.id, relevantDebtorIds),
							isNull(wgMembers.deactivatedAt),
						),
					);
				const activeDebtorIds = new Set(activeMembers.map((member) => member.id));
				const previousAmounts = new Map(
					previousSplits.map((split) => [split.debtorMemberId, split.amountCents]),
				);
				const nextAmounts = new Map(
					splits.map((split) => [split.debtorMemberId, split.amountCents]),
				);
				const changedInactiveSplit =
					splits.some(
						(split) =>
							!activeDebtorIds.has(split.debtorMemberId) &&
							previousAmounts.get(split.debtorMemberId) !== split.amountCents,
					) ||
					previousSplits.some(
						(split) =>
							!activeDebtorIds.has(split.debtorMemberId) &&
							nextAmounts.get(split.debtorMemberId) !== split.amountCents,
					);
				if (changedInactiveSplit) throw new TransactionAbort('member_not_in_wg');
			}

			const updateConditions = [eq(expenses.id, id), eq(expenses.wgId, wgId)];
			if (expectedVersion) {
				updateConditions.push(
					sql`date_trunc('milliseconds', ${expenses.updatedAt}) = ${expectedVersion}`,
				);
			}
			if (splits && amountCents === undefined) {
				updateConditions.push(eq(expenses.amountCents, row.amountCents));
			}
			const updateWhere = and(...updateConditions);
			const [updatedMarker] = await tx
				.update(expenses)
				.set({
					...updates,
					updatedAt: sql`greatest(clock_timestamp(), ${expenses.updatedAt} + interval '1 millisecond')`,
				})
				.where(updateWhere)
				.returning({ id: expenses.id });
			if (!updatedMarker) {
				const [current] = await tx
					.select({ id: expenses.id })
					.from(expenses)
					.where(and(eq(expenses.id, id), eq(expenses.wgId, wgId)))
					.limit(1);
				throw new TransactionAbort(current ? 'expense_changed' : 'expense_not_found');
			}
			if (imageUrl !== undefined) {
				await revokePrivateImageIfUnreferenced(tx, wgId, previousImageUrl, imageUrl ?? null);
			}

			if (!splits) return;

			// Read before deleting: a split that stays the same keeps the
			// settled flag it already had, so paying members are not asked
			// to pay again after an unrelated edit.
			const settledAtByUnchangedSplit = new Map(
				previousSplits.map((s) => [`${s.debtorMemberId}:${s.amountCents}`, s.settledAt] as const),
			);

			await tx.delete(expenseSplits).where(eq(expenseSplits.expenseId, id));
			const insertedSplits = await tx
				.insert(expenseSplits)
				.values(
					splits.map((s) => ({
						expenseId: id,
						debtorMemberId: s.debtorMemberId,
						amountCents: s.amountCents,
						settledAt:
							settledAtByUnchangedSplit.get(`${s.debtorMemberId}:${s.amountCents}`) ??
							settledAtForOwnShare(s.debtorMemberId, row.paidByMemberId),
					})),
				)
				.returning({ expenseId: expenseSplits.expenseId });
			if (insertedSplits.length === 0) throw new TransactionAbort('split_insert_failed');
		});
	} catch (writeErr) {
		if (writeErr instanceof TransactionAbort) {
			if (writeErr.code === 'image_removed') return conflict('image_removed', 'image_removed');
			if (writeErr.code === 'paypal_payment_pending') return conflict('paypal_payment_pending');
			if (writeErr.code === 'expense_not_found') return notFound('expense_not_found');
			if (writeErr.code === 'expense_changed')
				return conflict('expense_changed', 'expense_conflict');
			if (writeErr.code === 'member_not_in_wg') return badRequest('member_not_in_wg');
			return serverError(writeErr.code);
		}
		logApiError('[expense PATCH] update failed', writeErr);
		return serverError('split_insert_failed');
	}

	const updated = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
	const updatedRow = updated[0];
	if (!updatedRow) return serverError('fetch_failed');

	const updatedSplits = await db
		.select()
		.from(expenseSplits)
		.where(inArray(expenseSplits.expenseId, [id]));
	await recordAuditEvent({
		wgId,
		memberId: auth.member.memberId,
		eventType: 'expense.updated',
		entityType: 'expense',
		entityId: id,
		summary: `${auth.member.name} hat ${updatedRow.description} aktualisiert.`,
		metadata: {
			amountCents: updatedRow.amountCents,
			splitCount: updatedSplits.length,
		},
	});

	return NextResponse.json({ ...updatedRow, splits: updatedSplits });
});
