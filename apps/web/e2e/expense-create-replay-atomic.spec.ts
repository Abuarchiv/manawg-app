import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
	expenseSplits,
	expenses,
	idempotencyResponses,
	recurringExpenses,
	wgMembers,
} from '../src/core/db/schema';

const ROOT = process.cwd();
const requireFromWeb = createRequire(path.join(ROOT, 'package.json'));
const WG_ID = '989ac820-58b7-431f-9c65-28721264f333';
const MEMBER_ID = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
const EXPENSE_ID = '550e8400-e29b-41d4-a716-446655440000';
const SPLIT_ID = 'f2e2a748-3888-44fc-8c3c-6badfcad5690';
const KEY = 'retry-key';

function loadTs<T>(file: string, overrides: Record<string, unknown>): T {
	const compiled = transpileModule(readFileSync(file, 'utf8'), {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} as T };
	new Function('require', 'module', 'exports', compiled)(
		(name: string) => (Object.hasOwn(overrides, name) ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

type Kind = 'expense' | 'recurring';
type ReplayRow = { body: Record<string, unknown>; expiresAt: Date };

function harness(kind: Kind, warning: null | 'notification_delivery_failed' = null) {
	const dialect = new PgDialect();
	const state = {
		slot: {
			body: { _claimed: true },
			expiresAt: new Date(Date.now() + 60_000),
		} as ReplayRow | null,
		created: [] as string[],
		sideEffects: 0,
		failBaseWrite: false,
		warningWrite: 'success' as 'success' | 'miss' | 'throw',
		baseWhere: '',
		warningWhere: '',
		warningSet: '',
		warningSetHasExpiry: false,
		errors: [] as string[],
	};
	let tail = Promise.resolve();
	const withExpensePaymentLock = async (
		_wgId: string,
		operation: (tx: unknown) => Promise<unknown>,
	) => {
		const previous = tail;
		let release: () => void = () => undefined;
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		const draft = structuredClone({ slot: state.slot, created: state.created });
		const tx = {
			addExpense() {
				draft.created.push(EXPENSE_ID);
			},
			select: () => ({
				from: () => ({
					where: () => ({
						limit: () => ({
							for: async () =>
								draft.slot ? [{ body: draft.slot.body, expiresAt: draft.slot.expiresAt }] : [],
						}),
					}),
				}),
			}),
			insert: (table: unknown) => ({
				values: (value: Record<string, unknown>) => ({
					returning: async () => {
						if (table !== recurringExpenses) throw new Error('unexpected insert');
						draft.created.push(EXPENSE_ID);
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
			update: (table: unknown) => ({
				set: (values: { responseBody: unknown; expiresAt: Date }) => ({
					where: (condition: Parameters<typeof dialect.sqlToQuery>[0]) => ({
						returning: async () => {
							if (table !== idempotencyResponses) throw new Error('unexpected update');
							state.baseWhere = dialect.sqlToQuery(condition).sql;
							if (state.failBaseWrite) throw new Error('replay_write_failed');
							if (!draft.slot || draft.slot.body._claimed !== true) return [];
							draft.slot = {
								body: JSON.parse(JSON.stringify(values.responseBody)) as Record<string, unknown>,
								expiresAt: values.expiresAt,
							};
							return [{ scope: 'claimed' }];
						},
					}),
				}),
			}),
		};
		try {
			const result = await operation(tx);
			state.slot = draft.slot;
			state.created = draft.created;
			return result;
		} finally {
			release();
		}
	};
	const db = {
		select: () => {
			const query = {
				from: () => query,
				where: () => query,
				// biome-ignore lint/suspicious/noThenProperty: Drizzle selects are thenable.
				then: (resolve: (rows: unknown[]) => unknown) =>
					Promise.resolve([{ id: MEMBER_ID }]).then(resolve),
			};
			return query;
		},
		insert: () => {
			throw new Error('business insert escaped transaction');
		},
		update: (table: unknown) => ({
			set: (values: {
				responseBody: Parameters<typeof dialect.sqlToQuery>[0];
				expiresAt?: Date;
			}) => ({
				where: (condition: Parameters<typeof dialect.sqlToQuery>[0]) => ({
					returning: async () => {
						if (table !== idempotencyResponses) throw new Error('unexpected warning update');
						state.warningSet = dialect.sqlToQuery(values.responseBody).sql;
						state.warningWhere = dialect.sqlToQuery(condition).sql;
						state.warningSetHasExpiry = values.expiresAt !== undefined;
						if (state.warningWrite === 'throw') throw new Error('warning_write_failed');
						if (state.warningWrite === 'miss' || !state.slot) return [];
						state.slot.body.warning = warning;
						return [{ scope: 'claimed' }];
					},
				}),
			}),
		}),
	};
	const abort = class TransactionAbort extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	};
	const responseError = (code: string, status: number) =>
		Response.json({ error: code }, { status });
	const splitMath = loadTs<Record<string, unknown>>(
		path.join(ROOT, 'src/features/expenses/split-math.ts'),
		{},
	);
	const common = {
		'@/core/audit': {
			recordAuditEvent: async () => {
				state.sideEffects += 1;
			},
		},
		'@/core/db': {
			db,
			expenseSplits,
			expenses,
			idempotencyResponses,
			recurringExpenses,
			wgMembers,
		},
		'@/core/db/private-image-deletions': {
			assertPrivateImageCanBeAttached: async () => undefined,
		},
		'@/core/db/transaction': { TransactionAbort: abort },
		'@/core/errors': {
			apiError: (code: string, status: number) => responseError(code, status),
			badRequest: (code: string) => responseError(code, 400),
			conflict: (code: string) => responseError(code, 409),
			notFound: (code: string) => responseError(code, 404),
			serverError: () => responseError('server_error', 500),
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
					return { owned: true, resolve: () => undefined, reject: () => undefined };
				}
			},
			claimReplaySlotWithRetry: async () => ({ won: true }),
			replayKey: () => 'local-key',
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: WG_ID, shareCode: 'MTE8PZAT', name: 'WG' },
				member: { memberId: MEMBER_ID, name: 'Mina' },
			}),
		},
		'@/core/guards/route-preamble': { readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }) },
		'@/core/guards/with-wg-route': { withWgRoute: (_name: string, handler: unknown) => handler },
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 7 * 24 * 60 * 60,
			getCachedResponse: async () => null,
			readIdempotencyKey: (req: Request) => req.headers.get('idempotency-key'),
			setCachedResponse: () => {
				throw new Error('post-commit cache write');
			},
		},
		'@/core/infra/observability': {
			logApiError: (message: string, err: unknown) => {
				state.errors.push(`${message}: ${String(err)}`);
			},
		},
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/core/validators/currency': { currencySchema: requireFromWeb('zod').z.string() },
		'@/features/expenses/expense-payments': {
			hasCapturingExpensePayment: async () => false,
			withExpensePaymentLock,
		},
		'@/features/expenses/split-math': splitMath,
	};
	const file = path.join(
		ROOT,
		kind === 'expense'
			? 'src/app/api/wg/[code]/expenses/route.ts'
			: 'src/app/api/wg/[code]/recurring-expenses/route.ts',
	);
	const route = loadTs<{ POST: (req: Request, ctx: unknown) => Promise<Response> }>(file, {
		...common,
		'@/core/validators/image-url': {
			imageUrlSchema: requireFromWeb('zod').z.string().nullable().optional(),
			isAllowedImageUrlForWg: () => true,
		},
		'@/features/expenses/expenses': {
			checkPaidByGuard: () => ({ ok: true }),
			findExpenseMemberIds: async () => new Set([MEMBER_ID]),
			insertExpenseWithSplits: async (
				tx: { addExpense: () => void },
				input: Record<string, unknown>,
			) => {
				tx.addExpense();
				return {
					expense: { id: EXPENSE_ID, ...input },
					splits: [
						{ id: SPLIT_ID, expenseId: EXPENSE_ID, debtorMemberId: MEMBER_ID, amountCents: 1200 },
					],
				};
			},
			recordExpenseCreatedSideEffects: async () => {
				state.sideEffects += 1;
				return warning;
			},
			resolveExpensePayer: (_payer: unknown, caller: string) => caller,
		},
		'@/features/expenses/recurring-expenses': { parseRecurringSplits: JSON.parse },
	});
	const request = () =>
		new Request('http://localhost', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': KEY },
			body: JSON.stringify(
				kind === 'expense'
					? {
							description: 'Einkauf',
							amountCents: 1200,
							splits: [{ debtorMemberId: MEMBER_ID, amountCents: 1200 }],
						}
					: {
							description: 'Miete',
							amountCents: 1200,
							paidByMemberId: MEMBER_ID,
							nextDueAt: new Date(Date.now() + 86_400_000).toISOString(),
							splits: [{ debtorMemberId: MEMBER_ID, amountCents: 1200 }],
						},
			),
		});
	const post = async () => route.POST(request(), { params: Promise.resolve({ code: 'MTE8PZAT' }) });
	return { state, post };
}

for (const kind of ['expense', 'recurring'] as const) {
	test(`${kind} creation rolls back when durable replay write fails, then retries once`, async () => {
		const { state, post } = harness(kind);
		state.failBaseWrite = true;
		expect((await post()).status).toBe(500);
		expect(state.created).toEqual([]);
		expect(state.slot?.body).toEqual({ _claimed: true });
		state.failBaseWrite = false;
		expect((await post()).status, state.errors.join('\n')).toBe(200);
		expect(state.created).toEqual([EXPENSE_ID]);
		expect(state.slot?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
		expect(state.baseWhere).toContain('_claimed');
	});

	test(`${kind} concurrent lease winners replay one committed creation`, async () => {
		const { state, post } = harness(kind);
		const responses = await Promise.all([post(), post()]);
		expect(
			responses.map((response) => response.status),
			state.errors.join('\n'),
		).toEqual([200, 200]);
		expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
			state.slot?.body,
			state.slot?.body,
		]);
		expect(state.created).toEqual([EXPENSE_ID]);
		expect(state.sideEffects).toBe(1);
	});
}

test('expense warning update is conditional and preserves the replay expiry', async () => {
	const { state, post } = harness('expense', 'notification_delivery_failed');
	const response = await post();
	expect(response.status).toBe(200);
	expect((await response.json()).warning).toBe('notification_delivery_failed');
	expect(state.slot?.body.warning).toBe('notification_delivery_failed');
	expect(state.warningSet).toContain('jsonb_set');
	expect(state.warningWhere).toContain('expires_at');
	expect(state.warningWhere).toContain('expense');
	expect(state.warningSetHasExpiry).toBe(false);

	const missed = harness('expense', 'notification_delivery_failed');
	missed.state.warningWrite = 'miss';
	expect((await (await missed.post()).json()).warning).toBeNull();
	expect(missed.state.slot?.body.warning).toBeNull();
});
