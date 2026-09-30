import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = path.join(
	process.cwd(),
	'src/app/api/wg/[code]/expenses/[id]/splits/[splitId]/settle/route.ts',
);
const ids = Array.from(
	{ length: 32 },
	(_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
);
const [wgId, payerId, debtorId, thirdId, ...expenseIds] = ids;

const expensesTable = {
	id: 'expenses.id',
	wgId: 'expenses.wg_id',
	description: 'expenses.description',
	paidByMemberId: 'expenses.paid_by_member_id',
	currency: 'expenses.currency',
};
const splitsTable = {
	id: 'expense_splits.id',
	expenseId: 'expense_splits.expense_id',
	debtorMemberId: 'expense_splits.debtor_member_id',
	amountCents: 'expense_splits.amount_cents',
	settledAt: 'expense_splits.settled_at',
};
const membersTable = {
	id: 'wg_members.id',
	wgId: 'wg_members.wg_id',
	name: 'wg_members.name',
	color: 'wg_members.color',
};

function entry(
	expenseId,
	splitId,
	paidByMemberId,
	debtorMemberId,
	amountCents,
	currency = 'EUR',
	settledAt = null,
) {
	return {
		id: expenseId,
		wgId,
		description: `Expense ${expenseId}`,
		paidByMemberId,
		currency,
		splits: [{ id: splitId, expenseId, debtorMemberId, amountCents, settledAt }],
	};
}

function loadTypeScript(file, overrides = {}) {
	const output = transpileModule(readFileSync(file, 'utf8'), {
		compilerOptions: {
			esModuleInterop: true,
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
		},
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', output)(
		(name) => (Object.hasOwn(overrides, name) ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

async function post({
	expenses,
	payments = [],
	currentMemberId = debtorId,
	settled = true,
	target = expenses[0],
}) {
	const state = { audits: [], updates: [], lockActive: false };
	const members = [
		...new Set(
			expenses.flatMap((expense) => [
				expense.paidByMemberId,
				...expense.splits.map((split) => split.debtorMemberId),
			]),
		),
	].map((id) => ({ id, wgId, name: id, color: null }));

	function rowsFor(table, join) {
		if (table === expensesTable && join === splitsTable) {
			assert.equal(
				state.lockActive,
				true,
				'the global balance snapshot must be read under the payment lock',
			);
			return expenses.flatMap((expense) =>
				expense.splits.map((split) => ({
					expenseId: expense.id,
					paidByMemberId: expense.paidByMemberId,
					currency: expense.currency,
					description: expense.description,
					splitId: split.id,
					debtorMemberId: split.debtorMemberId,
					amountCents: split.amountCents,
					settledAt: split.settledAt,
				})),
			);
		}
		if (table === expensesTable) return expenses.filter((expense) => expense.id === target.id);
		if (table === splitsTable)
			return target.splits.filter((split) => split.id === target.splits[0].id);
		if (table === membersTable) return members;
		throw new Error(`Unexpected select table: ${String(table)}`);
	}

	const db = {
		select() {
			let table;
			let join;
			const query = {
				from(value) {
					table = value;
					return query;
				},
				innerJoin(value) {
					join = value;
					return query;
				},
				where() {
					const rows = rowsFor(table, join);
					const result = Promise.resolve(rows);
					result.limit = (count) => Promise.resolve(rows.slice(0, count));
					return result;
				},
			};
			return query;
		},
		update(table) {
			assert.equal(table, splitsTable);
			return {
				set(values) {
					state.updates.push(values);
					return {
						where() {
							return {
								returning: async () => {
									const split = target.splits[0];
									Object.assign(split, values);
									return [{ ...split }];
								},
							};
						},
					};
				},
			};
		},
	};

	const responseJson = (body, init) => Response.json(body, init);
	const mocks = {
		'@/core/audit': { recordAuditEvent: async (event) => state.audits.push(event) },
		'@/core/db': {
			db,
			expenses: expensesTable,
			expenseSplits: splitsTable,
			wgMembers: membersTable,
		},
		'@/core/errors': {
			badRequest: (error) => responseJson({ error }, { status: 400 }),
			conflict: (error) => responseJson({ error }, { status: 409 }),
			forbidden: (error) => responseJson({ error }, { status: 403 }),
			notFound: (error) => responseJson({ error }, { status: 404 }),
			requireVerifiedMember: () => null,
			tooMany: () => responseJson({ error: 'rate_limited' }, { status: 429 }),
		},
		'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId },
				member: { memberId: currentMemberId, name: 'Member', verified: true },
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/features/expenses/debt-reduction': loadTypeScript(
			path.join(process.cwd(), 'src/features/expenses/debt-reduction.ts'),
		),
		'@/features/expenses/expense-payments': {
			hasActiveExpensePayment: async () => false,
			loadCompletedExpensePayments: async () => payments,
			withExpensePaymentLock: async (_wgId, run) => {
				state.lockActive = true;
				try {
					return await run(db);
				} finally {
					state.lockActive = false;
				}
			},
		},
		'drizzle-orm': {
			and: (...conditions) => conditions,
			eq: (column, value) => ({ column, value }),
			isNotNull: (column) => ({ op: 'not-null', column }),
			isNull: (column) => ({ op: 'null', column }),
		},
		'next/server': { NextResponse: { json: responseJson } },
	};
	const route = loadTypeScript(routePath, mocks);
	const response = await route.POST(
		new Request('https://example.invalid/settle', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ settled }),
		}),
		{ code: 'MTE8PZAT', id: target.id, splitId: target.splits[0].id },
	);
	return { response, state, split: target.splits[0] };
}

test('refuses to mark a split settled when a completed payment already covers it', async () => {
	const target = entry(expenseIds[0], expenseIds[1], payerId, debtorId, 1200);
	const result = await post({
		expenses: [target],
		payments: [{ fromMemberId: debtorId, toMemberId: payerId, amountCents: 1200, currency: 'EUR' }],
		target,
	});

	assert.equal(result.response.status, 409);
	assert.deepEqual(await result.response.json(), { error: 'split_already_offset' });
	assert.equal(result.split.settledAt, null);
	assert.equal(result.state.updates.length, 0);
	assert.equal(result.state.audits.length, 0);
});

test('uses all members and blocks a split whose settlement would reverse a network balance', async () => {
	const target = entry(expenseIds[0], expenseIds[1], payerId, debtorId, 1000);
	const expenses = [
		target,
		entry(expenseIds[2], expenseIds[3], thirdId, payerId, 1000),
		entry(expenseIds[4], expenseIds[5], debtorId, thirdId, 1000),
		entry(expenseIds[6], expenseIds[7], thirdId, debtorId, 1000),
	];
	const result = await post({
		expenses,
		payments: [{ fromMemberId: debtorId, toMemberId: thirdId, amountCents: 1000, currency: 'EUR' }],
		target,
	});

	assert.equal(result.response.status, 409);
	assert.equal(result.split.settledAt, null);
	assert.equal(result.state.updates.length, 0);
});

test('requires the payer to still have enough creditor balance for the whole split', async () => {
	const target = entry(expenseIds[14], expenseIds[15], payerId, debtorId, 1000);
	const expenses = [target, entry(expenseIds[16], expenseIds[17], thirdId, payerId, 500)];
	const result = await post({ expenses, target });

	assert.equal(result.response.status, 409);
	assert.equal(result.state.updates.length, 0);
});

test('refuses to record the whole split when a completed payment only partly offsets it', async () => {
	const target = entry(expenseIds[8], expenseIds[9], payerId, debtorId, 1000);
	const result = await post({
		expenses: [target],
		payments: [{ fromMemberId: debtorId, toMemberId: payerId, amountCents: 600, currency: 'EUR' }],
		target,
	});

	assert.equal(result.response.status, 409);
	assert.equal(result.state.updates.length, 0);
});

test('allows settling an uncredited expense while debtor and payer residuals cover it', async () => {
	const target = entry(expenseIds[10], expenseIds[11], payerId, debtorId, 1000, 'EUR');
	const result = await post({ expenses: [target], target });

	assert.equal(result.response.status, 200);
	assert.ok(result.split.settledAt);
	assert.equal(result.state.audits[0]?.eventType, 'expense.split.settled');
});

test('keeps residual balances independent by currency', async () => {
	const target = entry(expenseIds[18], expenseIds[19], payerId, debtorId, 1000, 'EUR');
	const result = await post({
		expenses: [target],
		payments: [{ fromMemberId: debtorId, toMemberId: payerId, amountCents: 1000, currency: 'USD' }],
		target,
	});

	assert.equal(result.response.status, 200);
	assert.ok(result.split.settledAt);
});

test('allows reopening a manually settled split even when no residual debt remains', async () => {
	const target = entry(
		expenseIds[12],
		expenseIds[13],
		payerId,
		debtorId,
		1000,
		'EUR',
		new Date('2026-09-01T00:00:00.000Z'),
	);
	const result = await post({ expenses: [target], settled: false, target });

	assert.equal(result.response.status, 200);
	assert.equal(result.split.settledAt, null);
	assert.equal(result.state.audits[0]?.eventType, 'expense.split.reopened');
});
