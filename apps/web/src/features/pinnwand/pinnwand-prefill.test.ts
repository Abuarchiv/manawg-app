import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPinnwandPrefill } from './pinnwand-prefill';

test('recognises the amount with € / EUR / Euro after or € before the number', () => {
	const cases: [string, string | null, string][] = [
		['Internet kostet 35 Euro im Monat', '35', 'Internet kostet im Monat'],
		['Putzmittel 5 euro', '5', 'Putzmittel'],
		['Strom € 35,50', '35,50', 'Strom'],
		['Pizza 35 EUR.', '35', 'Pizza'],
		['Miete 1.234,50 €', '1234,50', 'Miete'],
		['Nebenkosten 1.200 Euro', '1200', 'Nebenkosten'],
		['Pizza 12,5 EUR', '12,5', 'Pizza'],
		['Bier 35€', '35', 'Bier'],
	];
	for (const [input, amountStr, title] of cases) {
		assert.deepEqual(buildPinnwandPrefill(input), { title, amountStr }, input);
	}
});

test('does not mistake other words or numbers for an amount', () => {
	assert.equal(buildPinnwandPrefill('Das ist 5 europäisch').amountStr, null);
	assert.equal(buildPinnwandPrefill('Zimmer 12 Uhr').amountStr, null);
});
