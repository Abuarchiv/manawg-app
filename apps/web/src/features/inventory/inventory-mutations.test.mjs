import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const directory = path.dirname(fileURLToPath(import.meta.url));
const updatedAt = new Date('2026-09-29T10:00:00.000Z');

function loadMutations() {
	const wgInventoryItems = { id: 'id', wgId: 'wgId', quantity: 'quantity', updatedAt: 'updatedAt' };
	const source = transpileModule(
		readFileSync(path.join(directory, 'inventory-mutations.ts'), 'utf8'),
		{ compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } },
	).outputText;
	const module = { exports: {} };
	const overrides = {
		'@/core/db': {
			db: {},
			idempotencyResponses: {},
			shoppingItems: {},
			wgInventoryItems,
			wgInventoryLog: { name: 'log' },
		},
		'@/features/inventory/inventory': {
			buildShoppingPushPayload: () => ({}),
			clampQuantity: (value) => Math.min(Math.max(value, 0), 9999),
			isBelowThreshold: () => false,
		},
		'drizzle-orm': {
			and: (...parts) => parts,
			eq: (column, value) => [column, value],
			gt: () => null,
			sql: () => null,
		},
	};
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

/**
 * Another tap committed quantity 5 -> 6 after this transaction started: a
 * plain read still sees the stale 5, a locking read waits and sees the 6.
 */
function concurrentTapTx() {
	const row = { id: 'item-1', wgId: 'wg-1', quantity: 6, threshold: 0, updatedAt };
	const state = { locked: false, logs: [] };
	const tx = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => {
						const stale = Promise.resolve([{ ...row, quantity: 5 }]);
						return Object.assign(stale, {
							for: (mode) => {
								assert.equal(mode, 'update');
								state.locked = true;
								return Promise.resolve([{ ...row }]);
							},
						});
					},
				}),
			}),
		}),
		update: () => ({
			set: (updates) => ({
				where: (conditions) => ({
					returning: async () => {
						const matches = conditions.every(
							(condition) => !Array.isArray(condition) || row[condition[0]] === condition[1],
						);
						if (!matches) return [];
						Object.assign(row, updates);
						return [{ ...row }];
					},
				}),
			}),
		}),
		insert: () => ({
			values: async (value) => {
				state.logs.push(value);
			},
		}),
	};
	return { tx, row, state };
}

test('a concurrent +1 tap is applied on top of the committed quantity instead of 409', async () => {
	const { updateInventoryItemMutation } = loadMutations();
	const { tx, row, state } = concurrentTapTx();
	const result = await updateInventoryItemMutation(tx, {
		itemId: 'item-1',
		wgId: 'wg-1',
		memberId: 'member-1',
		quantityDelta: 1,
	});
	assert.equal(result.kind, 'ok');
	assert.equal(state.locked, true);
	assert.equal(row.quantity, 7);
	assert.equal(result.delta, 1);
	assert.deepEqual(
		state.logs.map((log) => log.delta),
		[1],
	);
});

test('an absolute write keeps its optimistic conflict check', async () => {
	const { updateInventoryItemMutation } = loadMutations();
	const { tx, row, state } = concurrentTapTx();
	const result = await updateInventoryItemMutation(tx, {
		itemId: 'item-1',
		wgId: 'wg-1',
		memberId: 'member-1',
		quantity: 3,
		expectedQuantity: 5,
		expectedUpdatedAt: updatedAt.toISOString(),
	});
	assert.equal(result.kind, 'conflict');
	assert.equal(state.locked, false);
	assert.equal(row.quantity, 6);
});
