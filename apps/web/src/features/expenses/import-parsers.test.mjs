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
		if (specifier.startsWith('./') && !/\.[^/]+$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const { parseAmountToCents, parseSplitwiseCsv, parseSplidCsv } = await import(
	'./import-parsers.ts'
);
const { parseOcrText } = await import('./ocr.ts');

test('expense amounts preserve decimal and thousands separators without accepting junk', () => {
	assert.equal(parseAmountToCents('12,5'), 1250);
	assert.equal(parseAmountToCents('- 12,5'), -1250);
	assert.equal(parseAmountToCents('−12,5'), -1250);
	assert.equal(parseAmountToCents('12.50 EUR'), 1250);
	assert.equal(parseAmountToCents('1.234,56'), 123456);
	assert.equal(parseAmountToCents('1,234.56'), 123456);
	assert.equal(parseAmountToCents('1 234,56'), 123456);
	assert.equal(parseAmountToCents('1,234'), 123400);
	assert.equal(parseAmountToCents('12,34,56'), null);
	assert.equal(parseAmountToCents('12,5%'), null);
	assert.equal(parseAmountToCents('1 2'), null);
	assert.equal(parseAmountToCents('12 EUR USD'), null);
});

test('Splid imports one-decimal German amounts as cents', () => {
	const [expense] = parseSplidCsv(
		[
			'Datum;Beschreibung;Betrag;Bezahlt von;Teilnehmer',
			'26.09.2026;Strom;12,5;Anna;Anna|Bob',
		].join('\n'),
	);

	assert.equal(expense?.amountCents, 1250);
});

test('OCR shares the strict amount parser and ignores percentages', () => {
	assert.equal(
		parseOcrText('Internet 12.50 EUR', '2026-09-26T00:00:00.000Z').expenses[0]?.amountCents,
		1250,
	);
	assert.equal(
		parseOcrText('Gas 1.234,56 EUR', '2026-09-26T00:00:00.000Z').expenses[0]?.amountCents,
		123456,
	);
	assert.equal(
		parseOcrText('Gas 1 234,56 EUR', '2026-09-26T00:00:00.000Z').expenses[0]?.amountCents,
		123456,
	);
	assert.equal(
		parseOcrText('Taxi 12,50 pro Fahrt', '2026-09-26T00:00:00.000Z').expenses[0]?.amountCents,
		1250,
	);
	assert.equal(
		parseOcrText('BUS 12,50', '2026-09-26T00:00:00.000Z').expenses[0]?.amountCents,
		1250,
	);
	assert.equal(
		parseOcrText('GAS 12,50', '2026-09-26T00:00:00.000Z').expenses[0]?.amountCents,
		1250,
	);
	assert.deepEqual(parseOcrText('Rabatt 12.50 %', '2026-09-26T00:00:00.000Z').expenses, []);
	assert.deepEqual(parseOcrText('Storno -12.50 EUR', '2026-09-26T00:00:00.000Z').expenses, []);
	assert.deepEqual(parseOcrText('Storno - 12.50 EUR', '2026-09-26T00:00:00.000Z').expenses, []);
	assert.deepEqual(parseOcrText('Storno −12,50 EUR', '2026-09-26T00:00:00.000Z').expenses, []);
	assert.deepEqual(parseOcrText('Storno -€ 12,50', '2026-09-26T00:00:00.000Z').expenses, []);
	assert.deepEqual(parseOcrText('Storno - EUR 12.50', '2026-09-26T00:00:00.000Z').expenses, []);
	assert.deepEqual(parseOcrText('Gas 12.50 USD', '2026-09-26T00:00:00.000Z').expenses, []);
	assert.deepEqual(parseOcrText('CHF 12.50 Taxi', '2026-09-26T00:00:00.000Z').expenses, []);
	assert.deepEqual(parseOcrText('Datum 26.09.2026', '2026-09-26T00:00:00.000Z').expenses, []);
});

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
