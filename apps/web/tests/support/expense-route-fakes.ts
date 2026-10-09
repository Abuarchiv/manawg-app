// Shared fakes for the expense route tests: column/predicate stand-ins for drizzle operators, a
// swappable environment behind the module mocks every WG route needs, and request builders.
// Everything else (api-errors, parse-body, with-wg-route, split math, schemas) loads for real.
import { mock } from 'node:test';
import { TransactionAbort } from '../../src/core/db/transaction-abort.ts';

const SHARE_CODE = 'MTE8PZAT';
export const WG_ID = '989ac820-58b7-431f-9c65-28721264f333';
export const EXPENSE_ID = '550e8400-e29b-41d4-a716-446655440000';
export const CALLER_ID = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
export const PAYER_ID = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';

export type Column = { table: string; name: string };
export type Predicate =
	| { kind: 'eq'; column: Column; value: unknown }
	| { kind: 'in'; column: Column; values: unknown[] }
	| { kind: 'null' | 'notNull'; column: Column }
	| { kind: 'millisEq'; value: unknown }
	| { kind: 'nextVersion' }
	| { kind: 'and'; values: Predicate[] };

/** Evaluates a predicate built by {@link predicateOperators} against one row. */
export function matches(row: Record<string, unknown>, predicate: Predicate): boolean {
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

const predicateOperators = {
	and: (...values: Predicate[]): Predicate => ({ kind: 'and', values }),
	asc: () => undefined,
	desc: () => undefined,
	eq: (column: Column, value: unknown): Predicate => ({ kind: 'eq', column, value }),
	gt: () => undefined,
	inArray: (column: Column, values: unknown[]): Predicate => ({ kind: 'in', column, values }),
	isNotNull: (column: Column): Predicate => ({ kind: 'notNull', column }),
	isNull: (column: Column): Predicate => ({ kind: 'null', column }),
	lt: () => undefined,
	or: () => undefined,
	sql: (strings: TemplateStringsArray, _column: unknown, value: unknown): Predicate =>
		strings[0]?.includes('greatest') ? { kind: 'nextVersion' } : { kind: 'millisEq', value },
};

/** A table whose columns are `{ table, name }` pairs created on first access. */
function fakeTable(table: string): Record<string, Column> {
	return new Proxy({} as Record<string, Column>, {
		get: (_target, name) => ({ table, name: String(name) }),
	});
}

/** An object whose methods forward to whatever `get()` returns at call time. */
export function delegate<T extends object>(get: () => T): T {
	return new Proxy({} as T, {
		get:
			(_target, key) =>
			(...args: unknown[]) =>
				(get() as Record<PropertyKey, (...rest: unknown[]) => unknown>)[key]?.(...args),
	});
}

/** A thenable query whose rows come from `rows()` when awaited, or from `.limit()`. */
export function thenableQuery(rows: () => unknown[]) {
	const query = {
		limit: async () => rows().slice(0, 1),
		// biome-ignore lint/suspicious/noThenProperty: Drizzle queries are thenable; the fake resolves on await.
		then<TResult1 = unknown[], TResult2 = never>(
			onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
			onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
		): PromiseLike<TResult1 | TResult2> {
			return Promise.resolve(rows()).then(onfulfilled, onrejected);
		},
	};
	return query;
}

/** The `error` field of a JSON error response. */
export async function errorOf(response: Response): Promise<string> {
	return ((await response.json()) as { error: string }).error;
}

/** A route context with the given extra params; typed `never` so it fits any route signature. */
export function routeContext(params: Record<string, string> = {}): never {
	return { params: Promise.resolve({ code: SHARE_CODE, ...params }) } as never;
}

/** A JSON request; typed `never` so it fits any route signature. */
export function jsonRequest(
	method: string,
	body?: unknown,
	headers: Record<string, string> = {},
): never {
	return new Request('http://localhost', {
		method,
		headers: { 'content-type': 'application/json', ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	}) as never;
}

type Fn = (...args: never[]) => unknown;

export interface RouteEnv {
	/** The fake `db` behind `@/core/db`. */
	db: Record<string, Fn>;
	requireWgMember: Fn;
	payments: { withExpensePaymentLock: Fn; hasCapturingExpensePayment: Fn };
}

/** Table stand-ins behind the mocked `@/core/db`; fake queries compare them by identity. */
export const tables = {
	expenseImports: fakeTable('expenseImports'),
	expensePayments: fakeTable('expensePayments'),
	expenseSplits: fakeTable('expenseSplits'),
	expenses: fakeTable('expenses'),
	idempotencyResponses: fakeTable('idempotencyResponses'),
	recurringExpenses: fakeTable('recurringExpenses'),
	wgMembers: fakeTable('wgMembers'),
};

const authorizedMember = async () => ({
	ok: true,
	wg: { id: WG_ID, name: 'WG', shareCode: SHARE_CODE },
	member: { memberId: CALLER_ID, name: 'Mina' },
});

/**
 * Registers the module mocks the expense routes share and returns the environment they read at
 * call time. Call before dynamically importing a route.
 */
export function installWgRouteMocks(): RouteEnv {
	const env: RouteEnv = {
		db: {},
		requireWgMember: authorizedMember,
		payments: {
			withExpensePaymentLock: (async (_wgId: string, work: (tx: unknown) => unknown) =>
				work({})) as Fn,
			hasCapturingExpensePayment: async () => false,
		},
	};
	mock.module('drizzle-orm', { namedExports: predicateOperators });
	mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => undefined } });
	mock.module('@/features/expenses/server/settle-notify', {
		namedExports: {
			notifySettlement: async () => undefined,
			announcePayPalSettlement: async () => undefined,
		},
	});
	mock.module('@/core/db', { namedExports: { ...tables, db: delegate(() => env.db) } });
	mock.module('@/core/db/private-image-deletions', {
		namedExports: {
			assertPrivateImageCanBeAttached: async () => undefined,
			revokePrivateImageIfUnreferenced: async () => undefined,
		},
	});
	mock.module('@/core/db/transaction', {
		namedExports: {
			TransactionAbort,
			withTransaction: async () => {
				throw new Error('unexpected plain transaction');
			},
		},
	});
	mock.module('@/core/guards/admin', {
		namedExports: { isWgAdmin: async () => false, requireOwnerOrAdmin: async () => null },
	});
	mock.module('@/core/guards/api-auth', {
		namedExports: {
			UUID_PATTERN: /^[0-9a-f-]{36}$/i,
			isUuid: (value: string) => /^[0-9a-f-]{36}$/i.test(value),
		},
	});
	mock.module('@/core/guards/require-wg-member', {
		namedExports: { requireWgMember: (...args: never[]) => env.requireWgMember(...args) },
	});
	mock.module('@/core/infra/observability', {
		namedExports: { captureException: () => undefined, logApiError: () => undefined },
	});
	mock.module('@/core/rate-limit', {
		namedExports: {
			checkRateLimit: async () => ({ success: true }),
			expensesReadLimiter: {},
			importCommitLimiter: {},
			wgWriteLimiter: {},
		},
	});
	mock.module('@/features/expenses/server/expense-payments', {
		namedExports: {
			PAYPAL_ORDER_TTL_MS: 3 * 60 * 60 * 1000,
			hasActiveExpensePayment: async () => false,
			loadCompletedExpensePayments: async () => [],
			hasCapturingExpensePayment: (...args: never[]) =>
				env.payments.hasCapturingExpensePayment(...args),
			withExpensePaymentLock: (...args: never[]) => env.payments.withExpensePaymentLock(...args),
		},
	});
	return env;
}
