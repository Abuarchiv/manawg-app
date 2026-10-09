import assert from 'node:assert/strict';
import test from 'node:test';
import { extractInviteCode } from './join-flow';

test('extracts the code from a shared invite text', () => {
	const text =
		'Komm in unsere WG „Altbau“ auf ManaWG: https://app.manawg.com/neu?code=MTE8PZAT\n(oder mit Code MTE8PZAT unter app.manawg.com beitreten)';
	assert.equal(extractInviteCode(text), 'MTE8PZAT');
});

test('extracts the code from a bare link and falls back to the "Code X" phrase', () => {
	assert.equal(extractInviteCode('https://app.manawg.com/neu?code=mte8pzat'), 'MTE8PZAT');
	assert.equal(extractInviteCode('Beitreten mit Code MTE8PZAT bitte'), 'MTE8PZAT');
});

test('returns an empty string when no valid code is present', () => {
	assert.equal(extractInviteCode('Komm in unsere WG'), '');
	assert.equal(extractInviteCode('ABCD 1234'), '');
	assert.equal(extractInviteCode('https://x.test/neu?code=kurz'), '');
});
