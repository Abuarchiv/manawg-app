import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('../../..', import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const path = resolve(appRoot, 'src', `${specifier.slice(2)}.ts`);
			return nextResolve(pathToFileURL(path).href, context);
		}
		return nextResolve(specifier, context);
	},
});

const { parseSplitwiseCsv } = await import('./import-parsers.ts');

test('parseSplitwiseCsv recovers the payer share from their net-balance column', () => {
	// Splitwise CSV convention: each person's column holds their NET balance
	// for the row (paid - ownShare for the payer, -share for everyone else),
	// not their raw share. A previously used Math.abs() on every column,
	// which reads the payer's own net balance as their "share" — wrong
	// whenever the split isn't 50/50, and it silently discarded the real
	// custom split as unrepairable "drift" instead of importing it correctly.
	const csv = [
		'Date,Description,Cost,Currency,Anna,Bob',
		'2026-01-15,Miete,30.00,EUR,20.00,-20.00',
	].join('\n');

	const [expense] = parseSplitwiseCsv(csv);
	assert.ok(expense, 'expected one parsed expense');
	assert.equal(expense.amountCents, 3000);
	assert.equal(expense.paidByName, 'Anna');
	assert.equal(expense.warnings.includes('custom_splits_discarded'), false);

	const anna = expense.splits.find((s) => s.memberName === 'Anna');
	const bob = expense.splits.find((s) => s.memberName === 'Bob');
	// Anna paid 30 and her own share was 10 (net +20 = paid - ownShare).
	assert.equal(anna?.amountCents, 1000);
	// Bob's column already is his share (net -20 = -share).
	assert.equal(bob?.amountCents, 2000);
	assert.equal((anna?.amountCents ?? 0) + (bob?.amountCents ?? 0), expense.amountCents);
});

test('parseSplitwiseCsv still handles an equal split correctly', () => {
	const csv = [
		'Date,Description,Cost,Currency,Anna,Bob',
		'2026-01-15,Miete,30.00,EUR,15.00,-15.00',
	].join('\n');

	const [expense] = parseSplitwiseCsv(csv);
	assert.ok(expense);
	const anna = expense.splits.find((s) => s.memberName === 'Anna');
	const bob = expense.splits.find((s) => s.memberName === 'Bob');
	assert.equal(anna?.amountCents, 1500);
	assert.equal(bob?.amountCents, 1500);
});
