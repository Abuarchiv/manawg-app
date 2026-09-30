import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));

function loadTypeScript(relativePath, overrides = {}) {
	const source = transpileModule(readFileSync(path.join(process.cwd(), relativePath), 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (Object.hasOwn(overrides, name) ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

const { computeBalances } = loadTypeScript('src/features/expenses/debts.ts', {
	'@/core/utils/time': { MS_PER_DAY: 86_400_000 },
});
const { buildSettlementSummary, computeDirectDebts, computeNetBalances, simplifyDebts } =
	loadTypeScript('src/features/expenses/debt-reduction.ts');

const members = [
	{ id: 'A', name: 'A', color: null },
	{ id: 'B', name: 'B', color: null },
];

function expense(paidByMemberId, debtorMemberId, amountCents, currency = 'EUR') {
	return {
		paidByMemberId,
		currency,
		occurredAt: '2026-09-27T00:00:00.000Z',
		splits: [{ debtorMemberId, amountCents, settledAt: null }],
	};
}

function payment(fromMemberId, toMemberId, amountCents, currency = 'EUR') {
	return { fromMemberId, toMemberId, amountCents, currency };
}

function directRows(debts) {
	return debts.map(({ fromId, toId, cents, currency }) => ({ fromId, toId, cents, currency }));
}

function pairRows(debts) {
	return debts.map(({ debtorId, creditorId, amountCents, currency }) => ({
		fromId: debtorId,
		toId: creditorId,
		cents: amountCents,
		currency,
	}));
}

function canonicalDebts(expenses, payments) {
	return directRows(simplifyDebts(computeNetBalances(expenses, members, payments)));
}

test('reducing an expense keeps its overpayment as debt in the reverse direction', () => {
	const expenses = [expense('A', 'B', 500)];
	const payments = [payment('B', 'A', 1000)];
	const expected = [{ fromId: 'A', toId: 'B', cents: 500, currency: 'EUR' }];

	assert.deepEqual(pairRows(computeBalances(expenses, payments)), expected);
	assert.deepEqual(directRows(computeDirectDebts(expenses, members, payments)), expected);
	assert.deepEqual(canonicalDebts(expenses, payments), expected);
});

test('deleting an expense keeps the full payment as reverse debt', () => {
	const payments = [payment('B', 'A', 1000)];
	const expected = [{ fromId: 'A', toId: 'B', cents: 1000, currency: 'EUR' }];

	assert.deepEqual(pairRows(computeBalances([], payments)), expected);
	assert.deepEqual(directRows(computeDirectDebts([], members, payments)), expected);
	assert.deepEqual(canonicalDebts([], payments), expected);
});

test('reverse residuals combine with existing debt without crossing currencies', () => {
	const expenses = [expense('A', 'B', 500), expense('B', 'A', 300)];
	const payments = [payment('B', 'A', 1000), payment('B', 'A', 1000, 'USD')];
	const expected = [
		{ fromId: 'A', toId: 'B', cents: 800, currency: 'EUR' },
		{ fromId: 'A', toId: 'B', cents: 1000, currency: 'USD' },
	];

	assert.deepEqual(pairRows(computeBalances(expenses, payments)), expected);
	assert.deepEqual(directRows(computeDirectDebts(expenses, members, payments)), expected);
	assert.deepEqual(canonicalDebts(expenses, payments), expected);
});

test('direct summaries preserve gross positive debts in both directions', () => {
	const expenses = [expense('B', 'A', 300), expense('A', 'B', 200)];
	const direct = [
		{ fromId: 'A', toId: 'B', cents: 300, currency: 'EUR' },
		{ fromId: 'B', toId: 'A', cents: 200, currency: 'EUR' },
	];

	assert.deepEqual(directRows(computeDirectDebts(expenses, members)), direct);
	assert.equal(buildSettlementSummary(expenses, members).directCount, 2);
	assert.deepEqual(pairRows(computeBalances(expenses)), [
		{ fromId: 'A', toId: 'B', cents: 100, currency: 'EUR' },
	]);
});

test('direct and net summaries ignore payments from departed members', () => {
	const historicalPayment = [payment('departed', 'A', 1000)];

	assert.deepEqual(computeDirectDebts([], members, historicalPayment), []);
	assert.deepEqual(canonicalDebts([], historicalPayment), []);
});
