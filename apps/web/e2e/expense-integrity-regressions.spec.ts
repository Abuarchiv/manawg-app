import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { z } from 'zod';

function loadTs<T>(filePath: string, overrides: Record<string, unknown> = {}): T {
	const compiled = transpileModule(readFileSync(filePath, 'utf8'), {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} as Record<string, unknown> };
	const realRequire = createRequire(filePath);
	const localRequire = (id: string): unknown =>
		Object.hasOwn(overrides, id) ? overrides[id] : realRequire(id);
	new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
	return module.exports as T;
}

const ROOT = process.cwd();
const EXPENSE_ROUTE = path.join(ROOT, 'src/app/api/wg/[code]/expenses/[id]/route.ts');
const SETTLE_ROUTE = path.join(
	ROOT,
	'src/app/api/wg/[code]/expenses/[id]/splits/[splitId]/settle/route.ts',
);
const RECURRING_ROUTE = path.join(ROOT, 'src/app/api/wg/[code]/recurring-expenses/[id]/route.ts');
const IMPORT_ROUTE = path.join(ROOT, 'src/app/api/wg/[code]/imports/commit/route.ts');
const IMPORT_COMMIT = path.join(ROOT, 'src/features/expenses/import-commit.ts');
const IMPORT_PARSERS = path.join(ROOT, 'src/features/expenses/import-parsers.ts');
const RECURRING_HELPERS = path.join(ROOT, 'src/features/expenses/recurring-expenses.ts');
const SPLIT_MATH = path.join(ROOT, 'src/features/expenses/split-math.ts');
const SPLIT_INPUT = path.join(ROOT, 'src/features/expenses/expense-split-input.ts');

const WG_ID = '989ac820-58b7-431f-9c65-28721264f333';
const EXPENSE_ID = '550e8400-e29b-41d4-a716-446655440000';
const CALLER_ID = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
const PAYER_ID = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';

test('expense edit keeps departed historical shares in manual splits', () => {
	const splitInput = loadTs<{
		isEqualExpenseSplit: (
			amountCents: number,
			splits: readonly { debtorMemberId: string; amountCents: number }[],
			members: readonly { id: string; active?: boolean }[],
		) => boolean;
		buildSplitsFromForm: (input: {
			splitMode: 'equal' | 'manual';
			members: readonly { id: string; active?: boolean }[];
			manualSplits: Record<string, string>;
			amountCents: number;
			rotationOffset: number;
		}) => unknown;
	}>(SPLIT_INPUT, {
		'@/core/utils/amount': {
			parseEuroAmount: (value: string) => Number(value.replace(',', '.')),
		},
		'@/core/utils/money': { CENTS_PER_EURO: 100 },
		'@/features/expenses/split-math': loadTs(SPLIT_MATH),
	});
	const departedId = 'f2e2a748-3888-44fc-8c3c-6badfcad5690';
	const members = [
		{ id: CALLER_ID, active: true },
		{ id: departedId, active: false },
	];
	const historicalSplits = [
		{ debtorMemberId: CALLER_ID, amountCents: 500 },
		{ debtorMemberId: departedId, amountCents: 500 },
	];
	const splitMode = splitInput.isEqualExpenseSplit(1000, historicalSplits, members)
		? 'equal'
		: 'manual';

	expect(splitMode).toBe('manual');
	expect(
		splitInput.buildSplitsFromForm({
			splitMode,
			members,
			manualSplits: { [CALLER_ID]: '5', [departedId]: '5' },
			amountCents: 1000,
			rotationOffset: 0,
		}),
	).toEqual({ ok: true, splits: historicalSplits });
	expect(
		splitInput.isEqualExpenseSplit(
			1000,
			[{ debtorMemberId: CALLER_ID, amountCents: 1000 }],
			members,
		),
	).toBe(true);
});

test('manual expense splits reject invalid entries and keep blank, zero, and valid shares', () => {
	const { parseEuroAmount } = loadTs<{
		parseEuroAmount: (value: string) => number | null;
	}>(path.join(ROOT, 'src/core/utils/amount.ts'));
	const splitInput = loadTs<{
		buildSplitsFromForm: (input: {
			splitMode: 'equal' | 'manual';
			members: readonly { id: string; active?: boolean }[];
			manualSplits: Record<string, string>;
			amountCents: number;
			rotationOffset: number;
		}) => unknown;
	}>(SPLIT_INPUT, {
		'@/core/utils/amount': { parseEuroAmount },
		'@/core/utils/money': { CENTS_PER_EURO: 100 },
		'@/features/expenses/split-math': loadTs(SPLIT_MATH),
	});
	const members = [
		{ id: CALLER_ID, active: true },
		{ id: PAYER_ID, active: true },
	];
	const build = (manualSplits: Record<string, string>) =>
		splitInput.buildSplitsFromForm({
			splitMode: 'manual',
			members,
			manualSplits,
			amountCents: 1000,
			rotationOffset: 0,
		});

	expect(build({ [CALLER_ID]: '10', [PAYER_ID]: '-5' })).toEqual({
		ok: false,
		reason: 'invalid_share',
	});
	expect(build({ [CALLER_ID]: '10', [PAYER_ID]: 'invalid' })).toEqual({
		ok: false,
		reason: 'invalid_share',
	});
	expect(build({ [CALLER_ID]: '6', [PAYER_ID]: '4' })).toEqual({
		ok: true,
		splits: [
			{ debtorMemberId: CALLER_ID, amountCents: 600 },
			{ debtorMemberId: PAYER_ID, amountCents: 400 },
		],
	});
	expect(build({ [CALLER_ID]: '10', [PAYER_ID]: '' })).toEqual({
		ok: true,
		splits: [{ debtorMemberId: CALLER_ID, amountCents: 1000 }],
	});
	expect(build({ [CALLER_ID]: '10', [PAYER_ID]: '0' })).toEqual({
		ok: true,
		splits: [
			{ debtorMemberId: CALLER_ID, amountCents: 1000 },
			{ debtorMemberId: PAYER_ID, amountCents: 0 },
		],
	});
});

function responseError(code: string, status: number): Response {
	return Response.json({ error: code }, { status });
}

test('recurring splits require a valid distribution, including zero-cent shares', () => {
	const { recurringSplitsMatchAmount } = loadTs<{
		recurringSplitsMatchAmount: (
			splits: Array<{ debtorMemberId: string; amountCents: number }>,
			amountCents: number,
		) => boolean;
	}>(RECURRING_HELPERS, {
		'@/core/utils/time': { parseTimestamp: () => null },
		'@/features/expenses/split-math': loadTs(SPLIT_MATH),
	});
	const first = { debtorMemberId: CALLER_ID, amountCents: 1 };
	const second = { debtorMemberId: PAYER_ID, amountCents: 0 };
	expect(recurringSplitsMatchAmount([first, second], 1)).toBe(true);
	expect(recurringSplitsMatchAmount([first, first], 2)).toBe(false);
	expect(
		recurringSplitsMatchAmount(
			[
				{ ...first, amountCents: -1 },
				{ ...second, amountCents: 2 },
			],
			1,
		),
	).toBe(false);
	expect(recurringSplitsMatchAmount([first, second], 2)).toBe(false);
});

test('expense DELETE rechecks authorization and blocks an active capture under the payment lock', async () => {
	let locked = false;
	let callerIsDebtor = true;
	let removeDebtorAtLock = true;
	let capturing = false;
	let deleted = 0;
	let lockedReads = 0;
	let captureChecks = 0;
	const expenseRow = { paidByMemberId: PAYER_ID, description: 'Einkauf', amountCents: 1200 };
	const expenses = { name: 'expenses' };
	const expenseSplits = { name: 'expenseSplits' };

	const makeSelect = (insideTransaction: boolean) => {
		let table: unknown;
		const query = {
			from(nextTable: unknown) {
				table = nextTable;
				return query;
			},
			where() {
				if (insideTransaction) {
					if (!locked) throw new Error('transaction read escaped payment lock');
					lockedReads += 1;
				}
				return query;
			},
			limit: async () => {
				if (table === expenses) return [expenseRow];
				if (table === expenseSplits) {
					return callerIsDebtor ? [{ debtorMemberId: CALLER_ID }] : [];
				}
				return [];
			},
		};
		return query;
	};

	const tx = {
		select: () => makeSelect(true),
		delete: () => ({
			where() {
				return {
					returning: async () => {
						deleted += 1;
						return [{ id: EXPENSE_ID }];
					},
				};
			},
		}),
	};
	const withPaymentLock = async (
		_wgId: string,
		operation: (value: typeof tx) => Promise<unknown>,
	) => {
		locked = true;
		if (removeDebtorAtLock) callerIsDebtor = false;
		try {
			return await operation(tx);
		} finally {
			locked = false;
		}
	};
	const db = { select: () => makeSelect(false) };
	const route = loadTs<{ DELETE: (req: Request, ctx: unknown) => Promise<Response> }>(
		EXPENSE_ROUTE,
		{
			'@/core/audit': { recordAuditEvent: async () => undefined },
			'@/core/db': { db, expenseSplits, expenses, wgMembers: {} },
			'@/core/db/private-image-deletions': {
				assertPrivateImageCanBeAttached: async () => undefined,
				revokePrivateImageIfUnreferenced: async () => undefined,
			},
			'@/core/db/transaction': { TransactionAbort: class TransactionAbort extends Error {} },
			'@/core/errors': {
				badRequest: (code: string) => responseError(code, 400),
				conflict: (code: string) => responseError(code, 409),
				forbidden: (code: string) => responseError(code, 403),
				notFound: (code: string) => responseError(code, 404),
				requireVerifiedMember: () => null,
				serverError: (code: string) => responseError(code, 500),
				tooMany: () => responseError('too_many', 429),
			},
			'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
			'@/core/guards/require-wg-member': {
				requireWgMember: async () => ({
					ok: true,
					wg: { id: WG_ID },
					member: { memberId: CALLER_ID, name: 'Mina' },
				}),
			},
			'@/core/guards/with-wg-route': { withWgRoute: (_name: string, handler: unknown) => handler },
			'@/core/infra/observability': { logApiError: () => undefined },
			'@/core/rate-limit': {
				checkRateLimit: async () => ({ success: true }),
				wgWriteLimiter: {},
			},
			'@/core/validators/currency': { currencySchema: z.string() },
			'@/core/validators/image-url': {
				imageUrlSchema: z.string().nullable().optional(),
				isAllowedImageUrlForWg: () => true,
			},
			'@/features/expenses/expense-constants': {
				AMOUNT_MAX_CENTS: 100_000_000,
				AMOUNT_MIN_CENTS: 1,
			},
			'@/features/expenses/expense-payments': {
				withExpensePaymentLock: withPaymentLock,
				hasCapturingExpensePayment: async () => {
					captureChecks += 1;
					return capturing;
				},
			},
			'@/features/expenses/split-math': {
				settledAtForOwnShare: () => null,
				splitValidationErrorCode: () => 'splits_invalid',
				validateSplits: () => ({ ok: true }),
			},
		},
	);
	const response = await route.DELETE(new Request('http://localhost'), {
		code: 'MTE8PZAT',
		id: EXPENSE_ID,
	});

	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({ error: 'not_owner' });
	expect(lockedReads).toBe(2);
	expect(deleted).toBe(0);

	removeDebtorAtLock = false;
	callerIsDebtor = true;
	capturing = true;
	const captureResponse = await route.DELETE(new Request('http://localhost'), {
		code: 'MTE8PZAT',
		id: EXPENSE_ID,
	});
	expect(captureResponse.status).toBe(409);
	expect(await captureResponse.json()).toEqual({ error: 'paypal_payment_pending' });
	expect(captureChecks).toBe(1);
	expect(deleted).toBe(0);
});

type Predicate =
	| { kind: 'eq'; column: Column; value: unknown }
	| { kind: 'in'; column: Column; values: unknown[] }
	| { kind: 'null' | 'notNull'; column: Column }
	| { kind: 'millisEq'; value: unknown }
	| { kind: 'nextVersion' }
	| { kind: 'and'; values: Predicate[] };
type Column = { table: string; name: string };

function matches(row: Record<string, unknown>, predicate: Predicate): boolean {
	if (predicate.kind === 'and') return predicate.values.every((item) => matches(row, item));
	if (predicate.kind === 'millisEq') {
		return (
			typeof row.updatedAtPrecise === 'string' &&
			predicate.value instanceof Date &&
			new Date(row.updatedAtPrecise).getTime() === predicate.value.getTime()
		);
	}
	if (predicate.kind === 'nextVersion') return false;
	const value = row[predicate.column.name];
	if (predicate.kind === 'eq') {
		if (
			predicate.column.name === 'updatedAt' &&
			typeof row.updatedAtPrecise === 'string' &&
			predicate.value instanceof Date
		) {
			return row.updatedAtPrecise === predicate.value.toISOString();
		}
		return value === predicate.value;
	}
	if (predicate.kind === 'in') return predicate.values.includes(value);
	if (predicate.kind === 'null') return value === null || value === undefined;
	return value !== null && value !== undefined;
}

test('split settle authenticates before lookup and scopes expenses to the WG', async () => {
	const expenses = {
		id: { table: 'expenses', name: 'id' },
		wgId: { table: 'expenses', name: 'wgId' },
		description: { table: 'expenses', name: 'description' },
		paidByMemberId: { table: 'expenses', name: 'paidByMemberId' },
	};
	const foreignExpense = {
		id: EXPENSE_ID,
		wgId: '3c149bad-33c6-4a32-bb6d-196a65d1e741',
		description: 'Private Ausgabe',
		paidByMemberId: PAYER_ID,
	};
	let authorized = false;
	let lookups = 0;
	const db = {
		select: () => {
			lookups += 1;
			let condition: Predicate;
			return {
				from: () => ({
					where: (nextCondition: Predicate) => {
						condition = nextCondition;
						return {
							limit: async () => (matches(foreignExpense, condition) ? [foreignExpense] : []),
						};
					},
				}),
			};
		},
	};
	const route = loadTs<{ POST: (req: Request, ctx: unknown) => Promise<Response> }>(SETTLE_ROUTE, {
		'@/core/audit': { recordAuditEvent: async () => undefined },
		'@/core/db': { db, expenses, expenseSplits: {} },
		'@/core/errors': {
			badRequest: (code: string) => responseError(code, 400),
			conflict: (code: string) => responseError(code, 409),
			forbidden: (code: string) => responseError(code, 403),
			notFound: (code: string) => responseError(code, 404),
			requireVerifiedMember: () => null,
			tooMany: () => responseError('too_many', 429),
		},
		'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
		'@/core/guards/require-wg-member': {
			requireWgMember: async () =>
				authorized
					? { ok: true, wg: { id: WG_ID }, member: { memberId: CALLER_ID } }
					: { ok: false, response: responseError('unauthorized', 401) },
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_name: string, handler: unknown) => handler },
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/features/expenses/expense-payments': {
			hasActiveExpensePayment: async () => false,
			withExpensePaymentLock: async () => undefined,
		},
		'drizzle-orm': {
			eq: (column: Column, value: unknown): Predicate => ({ kind: 'eq', column, value }),
			and: (...values: Predicate[]): Predicate => ({ kind: 'and', values }),
			isNull: (column: Column): Predicate => ({ kind: 'null', column }),
			isNotNull: (column: Column): Predicate => ({ kind: 'notNull', column }),
		},
	});
	const request = () =>
		new Request('http://localhost', { method: 'POST', body: JSON.stringify({ settled: true }) });
	for (const id of [EXPENSE_ID, PAYER_ID]) {
		const response = await route.POST(request(), { code: 'MTE8PZAT', id, splitId: CALLER_ID });
		expect(response.status).toBe(401);
	}
	expect(lookups).toBe(0);
	authorized = true;
	const response = await route.POST(request(), {
		code: 'MTE8PZAT',
		id: EXPENSE_ID,
		splitId: CALLER_ID,
	});
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: 'expense_not_found' });
	expect(lookups).toBe(1);
});

test('expense PATCH preserves split integrity with fractional timestamps and concurrent amount changes', async () => {
	const expenses = {
		id: { table: 'expenses', name: 'id' },
		wgId: { table: 'expenses', name: 'wgId' },
		paidByMemberId: { table: 'expenses', name: 'paidByMemberId' },
		amountCents: { table: 'expenses', name: 'amountCents' },
		updatedAt: { table: 'expenses', name: 'updatedAt' },
		description: { table: 'expenses', name: 'description' },
		currency: { table: 'expenses', name: 'currency' },
		imageUrl: { table: 'expenses', name: 'imageUrl' },
	};
	const expenseSplits = {
		expenseId: { table: 'expenseSplits', name: 'expenseId' },
		debtorMemberId: { table: 'expenseSplits', name: 'debtorMemberId' },
		amountCents: { table: 'expenseSplits', name: 'amountCents' },
		settledAt: { table: 'expenseSplits', name: 'settledAt' },
	};
	const wgMembers = {
		id: { table: 'wgMembers', name: 'id' },
		wgId: { table: 'wgMembers', name: 'wgId' },
		deactivatedAt: { table: 'wgMembers', name: 'deactivatedAt' },
	};
	const debtorId = 'f2e2a748-3888-44fc-8c3c-6badfcad5690';
	const departedId = '9f2f0a21-b135-4d08-b1bd-846b034e7e90';
	const initialUpdatedAt = new Date('2026-09-20T00:00:00.123Z');
	const concurrentUpdatedAt = new Date('2026-09-20T00:00:00.123Z');
	let mutateAtLock = true;
	let capturing = false;
	let currentExpense = {
		id: EXPENSE_ID,
		wgId: WG_ID,
		paidByMemberId: CALLER_ID,
		amountCents: 1200,
		updatedAt: initialUpdatedAt,
		updatedAtPrecise: '2026-09-20T00:00:00.123456Z',
		description: 'Einkauf',
		currency: 'EUR',
		imageUrl: null,
	};
	let currentSplits: Array<Record<string, unknown>> = [
		{ expenseId: EXPENSE_ID, debtorMemberId: debtorId, amountCents: 1200, settledAt: null },
	];
	const operators = {
		eq: (column: Column, value: unknown): Predicate => ({ kind: 'eq', column, value }),
		inArray: (column: Column, values: unknown[]): Predicate => ({ kind: 'in', column, values }),
		isNull: (column: Column): Predicate => ({ kind: 'null', column }),
		and: (...values: Predicate[]): Predicate => ({ kind: 'and', values }),
		sql: (strings: TemplateStringsArray, _column: unknown, value: unknown): Predicate =>
			strings[0]?.includes('greatest') ? { kind: 'nextVersion' } : { kind: 'millisEq', value },
	};
	const members = [
		{ id: debtorId, wgId: WG_ID, deactivatedAt: null },
		{ id: CALLER_ID, wgId: WG_ID, deactivatedAt: null },
		{ id: departedId, wgId: WG_ID, deactivatedAt: new Date('2026-09-01T00:00:00.000Z') },
	];
	const makeSelect = () => {
		let table: unknown;
		let condition: Predicate | undefined;
		const rows = () => {
			const allRows =
				table === expenses
					? [currentExpense]
					: table === expenseSplits
						? currentSplits
						: table === wgMembers
							? members
							: [];
			return allRows.filter((row) => !condition || matches(row, condition));
		};
		const query = {
			from(nextTable: unknown) {
				table = nextTable;
				return query;
			},
			where(nextCondition: Predicate) {
				condition = nextCondition;
				return query;
			},
			limit: async () => rows().slice(0, 1),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle queries are thenable; the fake applies the predicate on await.
			then<TResult1 = unknown[], TResult2 = never>(
				onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
				onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
			): PromiseLike<TResult1 | TResult2> {
				return Promise.resolve(rows()).then(onfulfilled, onrejected);
			},
		};
		return query;
	};
	const tx = {
		select: makeSelect,
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: (condition: Predicate) => ({
					returning: async () => {
						if (!matches(currentExpense, condition)) return [];
						const updatedAt =
							(values.updatedAt as Predicate).kind === 'nextVersion'
								? new Date(Math.max(Date.now(), currentExpense.updatedAt.getTime() + 1))
								: (values.updatedAt as Date);
						currentExpense = {
							...currentExpense,
							...values,
							updatedAt,
							updatedAtPrecise: updatedAt.toISOString(),
						};
						return [{ id: EXPENSE_ID }];
					},
				}),
			}),
		}),
		delete: (table: unknown) => ({
			where: (condition: Predicate) => {
				if (table === expenseSplits) {
					currentSplits = currentSplits.filter((split) => !matches(split, condition));
				}
				return Promise.resolve([]);
			},
		}),
		insert: (table: unknown) => ({
			values: (values: Array<Record<string, unknown>>) => ({
				returning: async () => {
					if (table === expenseSplits) currentSplits = values;
					return values.map(() => ({ expenseId: EXPENSE_ID }));
				},
			}),
		}),
	};
	const db = { select: makeSelect };
	const route = loadTs<{ PATCH: (req: Request, ctx: unknown) => Promise<Response> }>(
		EXPENSE_ROUTE,
		{
			'@/core/audit': { recordAuditEvent: async () => undefined },
			'@/core/db': { db, expenseSplits, expenses, wgMembers },
			'@/core/db/private-image-deletions': {
				assertPrivateImageCanBeAttached: async () => undefined,
				revokePrivateImageIfUnreferenced: async () => undefined,
			},
			'@/core/db/transaction': {
				TransactionAbort: class TransactionAbort extends Error {
					constructor(readonly code: string) {
						super(code);
					}
				},
			},
			'@/core/errors': {
				badRequest: (code: string) => responseError(code, 400),
				conflict: (code: string) => responseError(code, 409),
				forbidden: (code: string) => responseError(code, 403),
				notFound: (code: string) => responseError(code, 404),
				requireVerifiedMember: () => null,
				serverError: (code: string) => responseError(code, 500),
				tooMany: () => responseError('too_many', 429),
			},
			'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
			'@/core/guards/require-wg-member': {
				requireWgMember: async () => ({
					ok: true,
					wg: { id: WG_ID },
					member: { memberId: CALLER_ID, name: 'Mina' },
				}),
			},
			'@/core/guards/with-wg-route': { withWgRoute: (_name: string, handler: unknown) => handler },
			'@/core/infra/observability': { logApiError: () => undefined },
			'@/core/rate-limit': {
				checkRateLimit: async () => ({ success: true }),
				wgWriteLimiter: {},
			},
			'@/core/validators/currency': { currencySchema: z.string() },
			'@/core/validators/image-url': {
				imageUrlSchema: z.string().nullable().optional(),
				isAllowedImageUrlForWg: () => true,
			},
			'@/features/expenses/expense-constants': {
				AMOUNT_MAX_CENTS: 100_000_000,
				AMOUNT_MIN_CENTS: 1,
			},
			'@/features/expenses/expense-payments': {
				hasCapturingExpensePayment: async () => capturing,
				withExpensePaymentLock: async (
					_wgId: string,
					operation: (value: typeof tx) => Promise<unknown>,
				) => {
					if (mutateAtLock) {
						currentExpense = {
							...currentExpense,
							amountCents: 2000,
							updatedAt: concurrentUpdatedAt,
							updatedAtPrecise: '2026-09-20T00:00:00.123789Z',
						};
						currentSplits = [
							{
								expenseId: EXPENSE_ID,
								debtorMemberId: debtorId,
								amountCents: 2000,
								settledAt: null,
							},
						];
					}
					return operation(tx);
				},
			},
			'@/features/expenses/split-math': {
				...loadTs<Record<string, unknown>>(SPLIT_MATH),
			},
			'drizzle-orm': operators,
		},
	);
	const response = await route.PATCH(
		new Request('http://localhost', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				expectedUpdatedAt: initialUpdatedAt.toISOString(),
				splits: [{ debtorMemberId: debtorId, amountCents: 1200 }],
			}),
		}),
		{ code: 'MTE8PZAT', id: EXPENSE_ID },
	);

	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: 'expense_changed' });
	expect(currentExpense.amountCents).toBe(2000);
	expect(currentSplits).toEqual([
		{ expenseId: EXPENSE_ID, debtorMemberId: debtorId, amountCents: 2000, settledAt: null },
	]);

	mutateAtLock = false;
	const priorVersion = new Date('2100-01-01T00:00:00.000Z');
	currentExpense = {
		...currentExpense,
		updatedAt: priorVersion,
		updatedAtPrecise: priorVersion.toISOString(),
	};
	const ordinaryResponse = await route.PATCH(
		new Request('http://localhost', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				expectedUpdatedAt: currentExpense.updatedAt.toISOString(),
				splits: [{ debtorMemberId: debtorId, amountCents: 2000 }],
			}),
		}),
		{ code: 'MTE8PZAT', id: EXPENSE_ID },
	);
	expect(ordinaryResponse.status).toBe(200);
	expect(currentExpense.updatedAt.getTime()).toBeGreaterThan(priorVersion.getTime());
	const mismatchedResponse = await route.PATCH(
		new Request('http://localhost', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				splits: [{ debtorMemberId: debtorId, amountCents: 1900 }],
			}),
		}),
		{ code: 'MTE8PZAT', id: EXPENSE_ID },
	);
	expect(mismatchedResponse.status).toBe(400);
	expect(await mismatchedResponse.json()).toEqual({ error: 'splits_sum_mismatch' });
	expect(currentExpense.amountCents).toBe(2000);
	expect(currentSplits).toEqual([
		{ expenseId: EXPENSE_ID, debtorMemberId: debtorId, amountCents: 2000, settledAt: null },
	]);

	const historicalSplits = [
		{
			expenseId: EXPENSE_ID,
			debtorMemberId: CALLER_ID,
			amountCents: 1000,
			settledAt: new Date('2026-09-10T00:00:00.000Z'),
		},
		{ expenseId: EXPENSE_ID, debtorMemberId: departedId, amountCents: 1000, settledAt: null },
	];
	currentSplits = historicalSplits;
	const unchangedHistoricalResponse = await route.PATCH(
		new Request('http://localhost', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				description: 'Historischer Einkauf',
				splits: [
					{ debtorMemberId: CALLER_ID, amountCents: 1000 },
					{ debtorMemberId: departedId, amountCents: 1000 },
				],
			}),
		}),
		{ code: 'MTE8PZAT', id: EXPENSE_ID },
	);
	expect(unchangedHistoricalResponse.status).toBe(200);
	expect(currentSplits).toEqual(historicalSplits);

	const removedHistoricalResponse = await route.PATCH(
		new Request('http://localhost', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				description: 'Versucht den historischen Anteil zu entfernen',
				splits: [{ debtorMemberId: CALLER_ID, amountCents: 2000 }],
			}),
		}),
		{ code: 'MTE8PZAT', id: EXPENSE_ID },
	);
	expect(removedHistoricalResponse.status).toBe(400);
	expect(await removedHistoricalResponse.json()).toEqual({ error: 'member_not_in_wg' });
	expect(currentExpense.description).toBe('Historischer Einkauf');
	expect(currentSplits).toEqual(historicalSplits);

	currentSplits = [
		{ expenseId: EXPENSE_ID, debtorMemberId: CALLER_ID, amountCents: 2000, settledAt: null },
	];
	const newlyIntroducedResponse = await route.PATCH(
		new Request('http://localhost', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				description: 'Darf keinen neuen inaktiven Anteil anlegen',
				splits: [
					{ debtorMemberId: CALLER_ID, amountCents: 1000 },
					{ debtorMemberId: departedId, amountCents: 1000 },
				],
			}),
		}),
		{ code: 'MTE8PZAT', id: EXPENSE_ID },
	);
	expect(newlyIntroducedResponse.status).toBe(400);
	expect(await newlyIntroducedResponse.json()).toEqual({ error: 'member_not_in_wg' });
	expect(currentExpense.description).toBe('Historischer Einkauf');
	expect(currentSplits).toEqual([
		{ expenseId: EXPENSE_ID, debtorMemberId: CALLER_ID, amountCents: 2000, settledAt: null },
	]);
	capturing = true;
	const blockedFinancialEdit = await route.PATCH(
		new Request('http://localhost', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ currency: 'USD' }),
		}),
		{ code: 'MTE8PZAT', id: EXPENSE_ID },
	);
	expect(blockedFinancialEdit.status).toBe(409);
	expect(await blockedFinancialEdit.json()).toEqual({ error: 'paypal_payment_pending' });
	expect(currentExpense.currency).toBe('EUR');
	const cosmeticEdit = await route.PATCH(
		new Request('http://localhost', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ description: 'Nur Text' }),
		}),
		{ code: 'MTE8PZAT', id: EXPENSE_ID },
	);
	expect(cosmeticEdit.status).toBe(200);
	expect(currentExpense.description).toBe('Nur Text');
});

test('both recurring expense PATCH routes guard financial edits without blocking ordinary changes', async () => {
	const OTHER_MEMBER_ID = 'd35ea6ee-e297-4a90-b6df-3e78ce47b395';
	const recurringExpenses = {
		id: { table: 'recurringExpenses', name: 'id' },
		wgId: { table: 'recurringExpenses', name: 'wgId' },
		pausedAt: { table: 'recurringExpenses', name: 'pausedAt' },
	};
	const wgMembers = {
		id: { table: 'wgMembers', name: 'id' },
		wgId: { table: 'wgMembers', name: 'wgId' },
		deactivatedAt: { table: 'wgMembers', name: 'deactivatedAt' },
	};
	const template = {
		id: EXPENSE_ID,
		wgId: WG_ID,
		createdByMemberId: CALLER_ID,
		description: 'Miete',
		amountCents: 1200,
		paidByMemberId: CALLER_ID,
		intervalMonths: 1,
		nextDueAt: new Date('2026-10-01T00:00:00.000Z'),
		anchorAt: new Date('2026-10-01T00:00:00.000Z'),
		lastCreatedAt: null,
		pausedAt: null,
		splitsJson: JSON.stringify([{ debtorMemberId: CALLER_ID, amountCents: 1200 }]),
		createdAt: new Date('2026-09-01T00:00:00.000Z'),
	};
	const memberRows = [
		{ id: CALLER_ID, wgId: WG_ID, deactivatedAt: null },
		{ id: PAYER_ID, wgId: WG_ID, deactivatedAt: null },
		{ id: OTHER_MEMBER_ID, wgId: WG_ID, deactivatedAt: null },
	];
	let updates = 0;
	const db = {
		select: () => {
			let table: unknown;
			const query = {
				from(nextTable: unknown) {
					table = nextTable;
					return query;
				},
				where(condition: Predicate) {
					const rows =
						table === wgMembers ? memberRows.filter((row) => matches(row, condition)) : [template];
					const result = Promise.resolve(rows) as Promise<unknown[]> & {
						limit: (count: number) => Promise<unknown[]>;
					};
					result.limit = async () => (table === recurringExpenses ? [template] : []);
					return result;
				},
			};
			return query;
		},
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => ({
					returning: async () => {
						updates += 1;
						Object.assign(template, values);
						return [template];
					},
				}),
			}),
		}),
	};
	const expenseFeatures = loadTs<Record<string, unknown>>(
		path.join(ROOT, 'src/features/expenses/expenses.ts'),
		{
			'@/core/activity-feed': {},
			'@/core/audit': {},
			'@/core/db': {},
			'@/core/db/transaction': {},
			'@/core/guards/api-auth': {},
			'@/core/notifications/notification-dispatch': {},
			'@/core/utils/money': {},
			'@/features/expenses/split-math': {},
			'drizzle-orm': {},
		},
	);
	const splitMath = loadTs<Record<string, unknown>>(SPLIT_MATH);
	const recurringHelpers = loadTs<Record<string, unknown>>(RECURRING_HELPERS, {
		'@/core/utils/time': { parseTimestamp: (value: string) => Date.parse(value) },
		'@/features/expenses/split-math': splitMath,
	});
	const errors = {
		apiError: (code: string, status: number) => responseError(code, status),
		badRequest: (code: string) => responseError(code, 400),
		conflict: (code: string) => responseError(code, 409),
		notFound: (code: string) => responseError(code, 404),
		serverError: (code: string) => responseError(code, 500),
		tooMany: () => responseError('too_many', 429),
	};
	const auth = {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: WG_ID, name: 'WG', shareCode: 'MTE8PZAT' },
			member: { memberId: CALLER_ID, name: 'Mina' },
		}),
	};
	const operators = {
		and: (...values: Predicate[]): Predicate => ({ kind: 'and', values }),
		asc: () => undefined,
		eq: (column: Column, value: unknown): Predicate => ({ kind: 'eq', column, value }),
		gt: () => undefined,
		inArray: (column: Column, values: unknown[]): Predicate => ({ kind: 'in', column, values }),
		isNotNull: (column: Column): Predicate => ({ kind: 'notNull', column }),
		isNull: (column: Column): Predicate => ({ kind: 'null', column }),
		sql: () => undefined,
	};
	const common = {
		'@/core/audit': { recordAuditEvent: async () => undefined },
		'@/core/db': { db, recurringExpenses, wgMembers },
		'@/core/errors': errors,
		'@/core/guards/admin': { requireOwnerOrAdmin: async () => null },
		'@/core/guards/require-wg-member': auth,
		'@/core/guards/with-wg-route': { withWgRoute: (_name: string, handler: unknown) => handler },
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			wgWriteLimiter: {},
		},
		'@/core/validators/currency': { currencySchema: z.string() },
		'@/features/expenses/expenses': expenseFeatures,
		'@/features/expenses/recurring-expenses': recurringHelpers,
		'drizzle-orm': operators,
	};
	const collectionRoute = loadTs<{
		PATCH: (req: Request, ctx: unknown) => Promise<Response>;
	}>(path.join(ROOT, 'src/app/api/wg/[code]/recurring-expenses/route.ts'), {
		...common,
		'@/core/db/transaction': { TransactionAbort: class TransactionAbort extends Error {} },
		'@/core/guards/idempotency': {
			ReplayCache: class {
				get() {
					return null;
				}
				remember() {}
				reserve() {
					return null;
				}
			},
			claimReplaySlotWithRetry: async () => ({ won: true }),
			replayKey: () => 'replay-key',
		},
		'@/core/guards/route-preamble': { readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }) },
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 7 * 24 * 60 * 60,
			getCachedResponse: async () => null,
			readIdempotencyKey: () => null,
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/features/expenses/expense-payments': {
			withExpensePaymentLock: async (_wgId: string, operation: (tx: unknown) => Promise<unknown>) =>
				operation({}),
		},
		'@/features/expenses/split-math': splitMath,
	});
	const itemRoute = loadTs<{
		PATCH: (req: Request, ctx: unknown) => Promise<Response>;
	}>(path.join(ROOT, 'src/app/api/wg/[code]/recurring-expenses/[id]/route.ts'), {
		...common,
		'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
	});
	const collectionEndpoint = {
		route: collectionRoute,
		context: { code: 'MTE8PZAT' },
	};
	const itemEndpoint = {
		route: itemRoute,
		context: { code: 'MTE8PZAT', id: EXPENSE_ID },
	};
	const endpoints = [collectionEndpoint, itemEndpoint];
	const send = async (endpoint: (typeof endpoints)[number], body: Record<string, unknown>) => {
		const response = await endpoint.route.PATCH(
			new Request('http://localhost', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
			endpoint.context,
		);
		return { status: response.status, body: await response.json() };
	};
	const results = [];
	for (const endpoint of endpoints) {
		results.push(
			await send(endpoint, {
				id: EXPENSE_ID,
				paidByMemberId: PAYER_ID,
				splits: [{ debtorMemberId: PAYER_ID, amountCents: 1200 }],
			}),
		);
	}

	expect({ results, updates }).toEqual({
		results: [
			{ status: 403, body: { error: 'paid_by_must_include_caller' } },
			{ status: 403, body: { error: 'paid_by_must_include_caller' } },
		],
		updates: 0,
	});

	const positiveCallerShare = await send(collectionEndpoint, {
		id: EXPENSE_ID,
		paidByMemberId: PAYER_ID,
		splits: [
			{ debtorMemberId: PAYER_ID, amountCents: 1199 },
			{ debtorMemberId: CALLER_ID, amountCents: 1 },
		],
	});
	const selfPayer = await send(itemEndpoint, {
		paidByMemberId: CALLER_ID,
		splits: [{ debtorMemberId: CALLER_ID, amountCents: 1200 }],
	});
	const legacySplits = [{ debtorMemberId: PAYER_ID, amountCents: 1200 }];
	const reorderedLegacySplits = [
		{ debtorMemberId: PAYER_ID, amountCents: 900 },
		{ debtorMemberId: OTHER_MEMBER_ID, amountCents: 300 },
	];
	Object.assign(template, {
		amountCents: 1200,
		paidByMemberId: PAYER_ID,
		splitsJson: JSON.stringify(legacySplits),
		pausedAt: null,
	});
	const unchangedForeignPayerEdits = [];
	for (const endpoint of endpoints) {
		for (const splits of [legacySplits, reorderedLegacySplits]) {
			Object.assign(template, {
				description: 'Miete',
				amountCents: 1200,
				paidByMemberId: PAYER_ID,
				splitsJson: JSON.stringify(splits),
			});
			unchangedForeignPayerEdits.push(
				await send(endpoint, {
					id: EXPENSE_ID,
					description: 'Miete angepasst',
					amountCents: 1200,
					paidByMemberId: PAYER_ID,
					intervalMonths: 1,
					nextDueAt: '2026-10-01T00:00:00.000Z',
					splits: [...splits].reverse(),
				}),
			);
		}
	}
	Object.assign(template, {
		description: 'Miete',
		amountCents: 1200,
		paidByMemberId: PAYER_ID,
		splitsJson: JSON.stringify(legacySplits),
	});
	const updatesBeforeRejectedEdits = updates;
	const rejectedFinancialEdits = [];
	for (const endpoint of endpoints) {
		rejectedFinancialEdits.push(
			await send(endpoint, {
				id: EXPENSE_ID,
				amountCents: 1300,
				paidByMemberId: PAYER_ID,
				splits: [{ debtorMemberId: PAYER_ID, amountCents: 1300 }],
			}),
			await send(endpoint, {
				id: EXPENSE_ID,
				amountCents: 1200,
				paidByMemberId: PAYER_ID,
				splits: [
					{ debtorMemberId: PAYER_ID, amountCents: 1000 },
					{ debtorMemberId: OTHER_MEMBER_ID, amountCents: 200 },
				],
			}),
			await send(endpoint, {
				id: EXPENSE_ID,
				amountCents: 1200,
				paidByMemberId: OTHER_MEMBER_ID,
				splits: legacySplits,
			}),
		);
	}
	const ordinaryChanges = [
		await send(collectionEndpoint, { id: EXPENSE_ID, description: 'Miete angepasst' }),
		await send(collectionEndpoint, {
			id: EXPENSE_ID,
			nextDueAt: '2026-11-01T00:00:00.000Z',
		}),
		await send(collectionEndpoint, {
			id: EXPENSE_ID,
			expectedNextDueAt: template.nextDueAt.toISOString(),
		}),
		await send(itemEndpoint, { description: 'Miete angepasst' }),
		await send(itemEndpoint, { nextDueAt: '2026-12-01T00:00:00.000Z' }),
		await send(itemEndpoint, { paused: true }),
		await send(itemEndpoint, { paused: false }),
	];

	expect(positiveCallerShare.status).toBe(200);
	expect(selfPayer.status).toBe(200);
	expect(unchangedForeignPayerEdits.map((result) => result.status)).toEqual([200, 200, 200, 200]);
	expect(rejectedFinancialEdits.map((result) => result.status)).toEqual([
		403, 403, 403, 403, 403, 403,
	]);
	expect(updates).toBe(updatesBeforeRejectedEdits + 7);
	expect(ordinaryChanges.map((result) => result.status)).toEqual([
		200, 200, 200, 200, 200, 200, 200,
	]);
});

test('recurring expense PATCH rejects an inactive payer', async () => {
	const wgMembers = {
		id: { table: 'wgMembers', name: 'id' },
		wgId: { table: 'wgMembers', name: 'wgId' },
		deactivatedAt: { table: 'wgMembers', name: 'deactivatedAt' },
	};
	const recurringExpenses = {
		id: { table: 'recurringExpenses', name: 'id' },
		wgId: { table: 'recurringExpenses', name: 'wgId' },
		pausedAt: { table: 'recurringExpenses', name: 'pausedAt' },
	};
	const inactiveId = '24ba761e-a429-45c3-a311-18e9a44b9be8';
	const activeDebtorId = 'f2e2a748-3888-44fc-8c3c-6badfcad5690';
	const template = {
		id: EXPENSE_ID,
		wgId: WG_ID,
		createdByMemberId: CALLER_ID,
		description: 'Miete',
		amountCents: 1200,
		paidByMemberId: CALLER_ID,
		intervalMonths: 1,
		nextDueAt: new Date('2026-10-01T00:00:00.000Z'),
		lastCreatedAt: null,
		pausedAt: null,
		splitsJson: JSON.stringify([{ debtorMemberId: activeDebtorId, amountCents: 1200 }]),
		createdAt: new Date('2026-09-01T00:00:00.000Z'),
	};
	const memberRows = [
		{ id: activeDebtorId, wgId: WG_ID, deactivatedAt: null },
		{ id: inactiveId, wgId: WG_ID, deactivatedAt: new Date('2026-09-10T00:00:00.000Z') },
	];

	const operators = {
		eq: (column: Column, value: unknown): Predicate => ({ kind: 'eq', column, value }),
		inArray: (column: Column, values: unknown[]): Predicate => ({ kind: 'in', column, values }),
		isNull: (column: Column): Predicate => ({ kind: 'null', column }),
		isNotNull: (column: Column): Predicate => ({ kind: 'notNull', column }),
		and: (...values: Predicate[]): Predicate => ({ kind: 'and', values }),
	};
	const db = {
		select: () => {
			let table: unknown;
			let condition: Predicate | undefined;
			const rows = () =>
				table === recurringExpenses
					? [template]
					: table === wgMembers
						? memberRows.filter((row) => !condition || matches(row, condition))
						: [];
			const query = {
				from(nextTable: unknown) {
					table = nextTable;
					return query;
				},
				where(nextCondition: Predicate) {
					condition = nextCondition;
					return query;
				},
				limit: async () => rows().slice(0, 1),
				// biome-ignore lint/suspicious/noThenProperty: Drizzle queries are thenable; the fake applies the predicate on await.
				then<TResult1 = unknown[], TResult2 = never>(
					onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
					onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
				): PromiseLike<TResult1 | TResult2> {
					return Promise.resolve(rows()).then(onfulfilled, onrejected);
				},
			};
			return query;
		},
		update: () => ({
			set: () => ({
				where: () => ({ returning: async () => [template] }),
			}),
		}),
	};
	const recurringHelpers = loadTs<Record<string, unknown>>(RECURRING_HELPERS, {
		'@/core/utils/time': { parseTimestamp: () => null },
		'@/features/expenses/split-math': loadTs(SPLIT_MATH),
	});
	const response = await loadTs<{
		PATCH: (req: Request, ctx: unknown) => Promise<Response>;
	}>(RECURRING_ROUTE, {
		'@/core/audit': { recordAuditEvent: async () => undefined },
		'@/core/db': { db, recurringExpenses, wgMembers },
		'@/core/errors': {
			badRequest: (code: string) => responseError(code, 400),
			notFound: (code: string) => responseError(code, 404),
			tooMany: () => responseError('too_many', 429),
		},
		'@/core/guards/admin': { requireOwnerOrAdmin: async () => null },
		'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: WG_ID },
				member: { memberId: CALLER_ID, name: 'Mina' },
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_name: string, handler: unknown) => handler },
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			wgWriteLimiter: {},
		},
		'@/core/validators/currency': { currencySchema: z.string() },
		'@/features/expenses/expenses': { checkPaidByGuard: () => ({ ok: true }) },
		'@/features/expenses/recurring-expenses': recurringHelpers,
		'drizzle-orm': operators,
	}).PATCH(
		new Request('http://localhost', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ paidByMemberId: inactiveId }),
		}),
		{ code: 'MTE8PZAT', id: EXPENSE_ID },
	);

	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: 'member_not_in_wg' });
});

test('import route ignores mapping conflicts on skipped rows', async () => {
	const parsedExpense = {
		date: '2026-09-01T00:00:00.000Z',
		description: 'Alte Ausgabe',
		amountCents: 500,
		currency: 'EUR' as const,
		paidByName: 'Ausgetretene Person',
		splits: [{ memberName: 'Ausgetretene Person', amountCents: 500 }],
		warnings: [],
	};
	const parser = loadTs<Record<string, unknown>>(IMPORT_PARSERS, {
		'@/core/utils/money': { CENTS_PER_EURO: 100 },
		'@/features/expenses/expense-constants': { AMOUNT_MAX_CENTS: 100_000_000 },
	});
	let committed: Record<string, unknown> | undefined;
	const response = await loadTs<{
		POST: (req: Request, ctx: unknown) => Promise<Response>;
	}>(IMPORT_ROUTE, {
		'@/core/errors': {
			badRequest: (code: string) => responseError(code, 400),
			serverError: () => responseError('server_error', 500),
			tooMany: () => responseError('too_many', 429),
		},
		'@/core/guards/idempotency': {
			ReplayCache: class {
				get() {
					return null;
				}
				remember() {}
				reserve() {
					return null;
				}
			},
			claimReplaySlotWithRetry: async () => ({ won: true }),
			replayKey: () => 'replay-key',
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: WG_ID, name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId: CALLER_ID, name: 'Mina' },
			}),
		},
		'@/core/guards/route-preamble': {
			readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }),
		},
		'@/core/idempotency': {
			getCachedResponse: async () => null,
			readIdempotencyKey: () => null,
			setCachedResponse: async () => undefined,
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			importCommitLimiter: {},
		},
		'@/features/expenses/import-body': {
			MAX_CSV_BYTES: 100_000,
			MAX_OCR_BYTES: 100_000,
			readImportJsonBody: async (req: Request) => ({ ok: true, value: await req.json() }),
		},
		'@/features/expenses/import-commit': {
			commitImport: async (input: Record<string, unknown>) => {
				committed = input;
				return { importId: 'import-1', inserted: 0, skipped: 1, errors: [], warning: null };
			},
		},
		'@/features/expenses/import-hash': { hashPayload: () => 'payload-hash' },
		'@/features/expenses/import-parsers': {
			...parser,
			parseSplitwiseCsv: () => [parsedExpense],
			parseSplidCsv: () => [parsedExpense],
		},
		'@/features/expenses/ocr': { parseOcrText: () => ({ expenses: [parsedExpense] }) },
	}).POST(
		new Request('http://localhost', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				source: 'splitwise_csv',
				payload: 'ignored row',
				memberMapping: {},
				previewPayloadHash: 'payload-hash',
				skipIndexes: [0],
			}),
		}),
		{ params: Promise.resolve({ code: 'MTE8PZAT' }) },
	);

	expect(response.status).toBe(200);
	expect(committed?.expenses).toEqual([{ parsed: parsedExpense, skip: true }]);
});

test('import helper does not validate member mappings for skipped rows', async () => {
	const expenseImports = { name: 'expenseImports' };
	let memberLookups = 0;
	const db = {
		select: () => {
			memberLookups += 1;
			return {
				from: () => ({ where: async () => [] }),
			};
		},
	};
	const tx = {
		insert: (table: unknown) => ({
			values: () => ({
				returning: async () => (table === expenseImports ? [{ id: 'import-1' }] : []),
			}),
		}),
		update: () => ({ set: () => ({ where: async () => undefined }) }),
	};
	const withPaymentLock = async (
		_wgId: string,
		operation: (value: typeof tx) => Promise<unknown>,
	) => operation(tx);
	const commitImport = loadTs<{
		commitImport: (input: unknown) => Promise<{ skipped: number }>;
	}>(IMPORT_COMMIT, {
		'@/core/activity-feed': { postSystemNotice: async () => undefined },
		'@/core/idempotency': { RESPONSE_REPLAY_TTL_SECONDS: 7 * 24 * 60 * 60 },
		'@/core/audit': { recordAuditEvent: async () => undefined },
		'@/core/db': { db, expenseImports, expenseSplits: {}, expenses: {}, wgMembers: {} },
		'@/core/notifications/notification-dispatch': {
			dispatchNotificationSafely: async () => ({ warning: null }),
		},
		'@/core/utils/money': { formatEuroCents: () => '0,00 €' },
		'@/features/expenses/expense-payments': {
			hasCapturingExpensePayment: async () => false,
			withExpensePaymentLock: withPaymentLock,
		},
		'@/features/expenses/split-math': { settledAtForOwnShare: () => null },
	});
	const foreignMemberId = '24ba761e-a429-45c3-a311-18e9a44b9be8';
	const result = await commitImport.commitImport({
		wg: { id: WG_ID, name: 'WG', shareCode: 'MTE8PZAT' },
		source: 'splitwise_csv',
		importedByMemberId: CALLER_ID,
		importedByName: 'Mina',
		expenses: [
			{
				parsed: {
					date: '2026-09-01T00:00:00.000Z',
					description: 'Alte Ausgabe',
					amountCents: 500,
					currency: 'EUR',
					paidByName: 'Ausgetretene Person',
					splits: [{ memberName: 'Ausgetretene Person', amountCents: 500 }],
					warnings: [],
				},
				skip: true,
			},
		],
		mapping: { 'Ausgetretene Person': foreignMemberId },
		skipDuplicates: false,
		rawPayloadHash: 'hash',
	});

	expect(result.skipped).toBe(1);
	expect(memberLookups).toBe(0);
});

test('payer guard failures explain how to correct an expense and recurring template', () => {
	const messages = loadTs<{
		expenseSaveErrorMessage: (error: string) => string;
		recurringTemplateSaveErrorMessage: (error: string) => string;
	}>(path.join(ROOT, 'src/features/expenses/expense-errors.ts'), {
		'@/core/errors/generic-error-codes': {
			isAuthInvalidated: () => false,
			isInvalidShareCode: () => false,
			isNetworkError: () => false,
			isRetryableServerError: () => false,
		},
	});

	expect(messages.expenseSaveErrorMessage('paid_by_must_include_caller')).toContain('Anteil');
	expect(messages.recurringTemplateSaveErrorMessage('paid_by_must_include_caller')).toContain(
		'Anteil',
	);
});

test('recurring expense creation requires the caller to bear a positive share', async () => {
	let memberRows = [{ id: PAYER_ID }];
	const recurringExpenses = {};
	let insertCount = 0;
	const tx = {
		insert: () => ({
			values: (value: Record<string, unknown>) => ({
				returning: async () => {
					insertCount += 1;
					return [
						{
							...value,
							id: EXPENSE_ID,
							createdAt: new Date(),
							lastCreatedAt: null,
							pausedAt: null,
						},
					];
				},
			}),
		}),
	};
	const expenseFeatures = loadTs<Record<string, unknown>>(
		path.join(ROOT, 'src/features/expenses/expenses.ts'),
		{
			'@/core/activity-feed': {},
			'@/core/audit': {},
			'@/core/db': {},
			'@/core/db/transaction': {},
			'@/core/guards/api-auth': {},
			'@/core/notifications/notification-dispatch': {},
			'@/core/utils/money': {},
			'@/features/expenses/split-math': {},
			'drizzle-orm': {},
		},
	);
	const route = loadTs<{
		POST: (req: Request, ctx: unknown) => Promise<Response>;
	}>(path.join(ROOT, 'src/app/api/wg/[code]/recurring-expenses/route.ts'), {
		'@/core/audit': { recordAuditEvent: async () => undefined },
		'@/core/db': {
			db: {
				select: () => ({ from: () => ({ where: async () => memberRows }) }),
			},
			idempotencyResponses: {},
			recurringExpenses,
			wgMembers: {},
		},
		'@/core/db/transaction': {
			TransactionAbort: class TransactionAbort extends Error {},
		},
		'@/core/errors': {
			apiError: (code: string, status: number) => responseError(code, status),
			badRequest: (code: string) => responseError(code, 400),
			conflict: (code: string) => responseError(code, 409),
			notFound: (code: string) => responseError(code, 404),
			serverError: (code: string) => responseError(code, 500),
			tooMany: () => responseError('too_many', 429),
		},
		'@/core/guards/admin': { requireOwnerOrAdmin: async () => null },
		'@/core/guards/idempotency': {
			ReplayCache: class {
				get() {
					return null;
				}
				remember() {}
				reserve() {
					return null;
				}
			},
			claimReplaySlotWithRetry: async () => ({ won: true }),
			replayKey: () => 'replay-key',
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: WG_ID, name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId: CALLER_ID, name: 'Mina' },
			}),
		},
		'@/core/guards/route-preamble': {
			readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_name: string, handler: unknown) => handler },
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 7 * 24 * 60 * 60,
			getCachedResponse: async () => null,
			readIdempotencyKey: () => null,
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			wgWriteLimiter: {},
		},
		'@/core/validators/currency': { currencySchema: z.string() },
		'@/features/expenses/expense-payments': {
			withExpensePaymentLock: async (_wgId: string, operation: (tx: unknown) => Promise<unknown>) =>
				operation(tx),
		},
		'@/features/expenses/expenses': expenseFeatures,
		'@/features/expenses/recurring-expenses': { parseRecurringSplits: JSON.parse },
		'@/features/expenses/split-math': loadTs(SPLIT_MATH),
		'drizzle-orm': {
			and: (...conditions: unknown[]) => conditions,
			asc: () => undefined,
			eq: () => undefined,
			gt: () => undefined,
			inArray: () => undefined,
			isNull: () => undefined,
			sql: () => undefined,
		},
	});
	const post = (splits: Array<{ debtorMemberId: string; amountCents: number }>) =>
		route.POST(
			new Request('http://localhost', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					description: 'Miete',
					amountCents: 1200,
					paidByMemberId: PAYER_ID,
					nextDueAt: new Date(Date.now() + 86_400_000).toISOString(),
					splits,
				}),
			}),
			{ params: Promise.resolve({ code: 'MTE8PZAT' }) },
		);

	const fabricated = await post([{ debtorMemberId: PAYER_ID, amountCents: 1200 }]);
	expect(fabricated.status).toBe(403);
	expect(await fabricated.json()).toEqual({ error: 'paid_by_must_include_caller' });
	expect(insertCount).toBe(0);

	memberRows = [{ id: PAYER_ID }, { id: CALLER_ID }];
	const zeroShare = await post([
		{ debtorMemberId: PAYER_ID, amountCents: 1200 },
		{ debtorMemberId: CALLER_ID, amountCents: 0 },
	]);
	expect(zeroShare.status).toBe(403);
	expect(await zeroShare.json()).toEqual({ error: 'paid_by_must_include_caller' });
	expect(insertCount).toBe(0);

	const includedCaller = await post([
		{ debtorMemberId: PAYER_ID, amountCents: 1199 },
		{ debtorMemberId: CALLER_ID, amountCents: 1 },
	]);
	expect(includedCaller.status).toBe(200);
	expect(insertCount).toBe(1);
});
