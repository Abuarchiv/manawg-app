import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhoneInput } from './phone';

test('normalises common German phone formats to E.164', () => {
	for (const input of [
		'+49 170 1234567',
		'+49-170-1234567',
		'0049 170 1234567',
		'+49 (0)170 1234567',
		' +49 (170) 123/4567 ',
	]) {
		assert.equal(normalizePhoneInput(input), '+491701234567', input);
	}
});

test('does not guess a country for national numbers', () => {
	assert.equal(normalizePhoneInput('0170 1234567'), '01701234567');
});
