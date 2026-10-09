import {
	AMOUNT_MAX_CENTS,
	AMOUNT_MIN_CENTS,
	DESCRIPTION_MAX_LENGTH,
} from '@/features/expenses/expense-constants';
import { z } from 'zod';

/**
 * Request-body building blocks shared by the expense and recurring-expense
 * routes, so a limit changed in one place applies to every write path.
 */

/** One debtor's share. Zero is allowed: a member can be part of a split without owing. */
export const expenseSplitSchema = z.object({
	debtorMemberId: z.string().uuid(),
	amountCents: z
		.number()
		.int('amountCents must be an integer')
		.min(0, 'amountCents must not be negative'),
});

export const expenseAmountSchema = z
	.number()
	.int('amountCents must be an integer')
	.min(AMOUNT_MIN_CENTS)
	.max(AMOUNT_MAX_CENTS);

export const expenseDescriptionSchema = z.string().trim().min(1).max(DESCRIPTION_MAX_LENGTH);

const DAY_MS = 24 * 60 * 60 * 1000;
/** Local noon plus time zone offsets can put "today" up to a day ahead of the server clock. */
const OCCURRED_AT_MAX_FUTURE_MS = 2 * DAY_MS;
const OCCURRED_AT_MAX_AGE_MS = 5 * 365 * DAY_MS;

/** The day an expense happened: not meaningfully in the future and at most about five years back. */
export const occurredAtSchema = z
	.string()
	.datetime({ offset: true })
	.refine((value) => {
		const time = Date.parse(value);
		const now = Date.now();
		return time <= now + OCCURRED_AT_MAX_FUTURE_MS && time >= now - OCCURRED_AT_MAX_AGE_MS;
	});
