import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthWeakPasswordError } from '@supabase/supabase-js';
import { WEAK_PASSWORD_MESSAGE, isWeakPasswordError } from '../src/core/auth/password-errors.ts';

test('only rejected weak passwords get actionable feedback', () => {
	assert.equal(
		isWeakPasswordError(new AuthWeakPasswordError('Password is weak', 422, ['pwned'])),
		true,
	);
	assert.equal(isWeakPasswordError({ code: 'invalid_credentials' }), false);
	assert.equal(isWeakPasswordError({ weakPassword: { reasons: ['pwned'] } }), false);
	assert.match(WEAK_PASSWORD_MESSAGE, /wähle.*anderes/i);
});
