import assert from 'node:assert/strict';
import test from 'node:test';
import type { RejectedRow } from './import-types';

const { matchMembers, parseSplidCsv, parseSplitwiseCsv } = await import('./import-parsers');

test('parseSplitwiseCsv recovers the payer share from their net-balance column', () => {
	// Splitwise CSV convention: each person's column holds their NET balance for the row
	// (paid - ownShare for the payer, -share for everyone else), not their raw share. Taking
	// Math.abs() of every column would read the payer's net balance as their share, which is
	// wrong whenever the split is not 50/50 and would discard the real custom split as
	// unrepairable drift instead of importing it.
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

test('matchMembers does not guess between short names that differ by one letter', () => {
	const members = [{ id: 'tim', name: 'Tim' }];
	assert.equal(matchMembers(['Tom'], members).get('Tom'), null);
	assert.equal(matchMembers(['Jo'], [{ id: 'al', name: 'Al' }]).get('Jo'), null);
	assert.equal(matchMembers(['Anna'], [{ id: 'hana', name: 'Hana' }]).get('Anna'), null);
});

test('matchMembers still suggests longer names and flags them as fuzzy', () => {
	const fuzzy = new Set<string>();
	const matched = matchMembers(['Katharina'], [{ id: 'k', name: 'Katarina' }], fuzzy);
	assert.equal(matched.get('Katharina'), 'k');
	assert.deepEqual([...fuzzy], ['Katharina']);
	const exact = new Set<string>();
	assert.equal(matchMembers(['TIM'], [{ id: 'tim', name: 'Tim' }], exact).get('TIM'), 'tim');
	assert.equal(exact.size, 0);
});

test('matchMembers never reuses a member that another name already matches exactly', () => {
	const members = [{ id: 'katarina', name: 'Katarina' }];
	const matched = matchMembers(['Katarina', 'Katharina'], members);
	assert.equal(matched.get('Katarina'), 'katarina');
	assert.equal(matched.get('Katharina'), null);
});

test('parsers report rows they cannot read instead of dropping them silently', () => {
	const splitwise = [
		'Date,Description,Cost,Currency,Anna,Bob',
		'2026-01-15,Miete,30.00,EUR,15.00,-15.00',
		'kaputt,Strom,30.00,EUR,15.00,-15.00',
		'2026-01-16,Wasser,abc,EUR,15.00,-15.00',
	].join('\n');
	const rejected: RejectedRow[] = [];
	assert.equal(parseSplitwiseCsv(splitwise, rejected).length, 1);
	assert.deepEqual(rejected, [
		{ line: 3, reason: 'date_invalid', description: 'Strom' },
		{ line: 4, reason: 'amount_invalid', description: 'Wasser' },
	]);

	const splid = [
		'Datum,Beschreibung,Betrag,Bezahlt von,Teilnehmer',
		'2026-01-15,Pizza,12.00,,Anna',
	].join('\n');
	const splidRejected: RejectedRow[] = [];
	assert.equal(parseSplidCsv(splid, splidRejected).length, 0);
	assert.deepEqual(splidRejected, [{ line: 2, reason: 'payer_missing', description: 'Pizza' }]);
});
