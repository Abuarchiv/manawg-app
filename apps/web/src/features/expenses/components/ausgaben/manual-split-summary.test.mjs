import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('../../../../..', import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const path = resolve(appRoot, 'src', `${specifier.slice(2)}.ts`);
			return nextResolve(pathToFileURL(path).href, context);
		}
		return nextResolve(specifier, context);
	},
});

const { distributeRemainderCents } = await import('./manual-split-distribute.ts');

const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('tops up empty fields when too little was entered', () => {
	const next = distributeRemainderCents({ a: '10,00' }, members, 2000);
	// 20€ split across the two empty members (b, c), 10€ each.
	assert.equal(next.b, '10,00');
	assert.equal(next.c, '10,00');
	assert.equal(next.a, '10,00');
});

test('claws excess back from filled fields instead of going negative', () => {
	// Regression: overshooting by 5€ used to target the empty "c" field,
	// driving it to -5,00 — a value the input can't parse back out, so it
	// silently vanished from the sum instead of fixing the overage.
	const next = distributeRemainderCents({ a: '15,00', b: '20,00' }, members, -500);
	assert.notEqual(next.c, '-5,00');
	assert.equal(next.c ?? '', '');
	// The 5€ excess is clawed back from the two filled fields (a, b).
	const totalCents = 1500 + 2000 - 500;
	const aCents = Math.round(Number.parseFloat(next.a.replace(',', '.')) * 100);
	const bCents = Math.round(Number.parseFloat(next.b.replace(',', '.')) * 100);
	assert.equal(aCents + bCents, totalCents);
	assert.ok(aCents >= 0 && bCents >= 0);
});

test('clamps a filled field at zero rather than going negative', () => {
	const next = distributeRemainderCents({ a: '2,00' }, [{ id: 'a' }], -500);
	assert.equal(next.a, '0,00');
});

test('redistributes a clamped reduction across the remaining filled fields', () => {
	const next = distributeRemainderCents({ a: '1,00', b: '99,00' }, members, -5000);
	assert.equal(next.a, '0,00');
	assert.equal(next.b, '50,00');
});

test('leaves inactive shares untouched while redistributing active members', () => {
	const next = distributeRemainderCents(
		{ a: '1,00', b: '99,00', inactive: '25,00' },
		[{ id: 'a' }, { id: 'b' }],
		-5000,
	);
	assert.equal(next.a, '0,00');
	assert.equal(next.b, '50,00');
	assert.equal(next.inactive, '25,00');
});

test('no-op when the remainder is already zero', () => {
	const current = { a: '10,00', b: '10,00' };
	const next = distributeRemainderCents(current, members, 0);
	assert.deepEqual(next, current);
});

test('never writes a negative amount, even when the excess sits outside the targets', () => {
	// Regression (#492): the only over-allocated share belongs to someone who
	// is not a target (a moved-out member). The targets can't absorb it, but
	// they must stay at zero rather than turn into unparsable "-x,xx" strings.
	const next = distributeRemainderCents({ inactive: '30,00' }, members, -1000);
	for (const value of Object.values(next)) {
		assert.ok(!value.startsWith('-'), `negative amount ${value}`);
	}
	assert.equal(next.inactive, '30,00');
});

test('is pure: same input, same output, input left untouched', () => {
	// Regression (#493): the leftover counter used to live in a closure that
	// the state updater mutated, so a second (StrictMode) invocation lost cents.
	const current = Object.freeze({ a: '10,00' });
	const first = distributeRemainderCents(current, members, 2001);
	const second = distributeRemainderCents(current, members, 2001);
	assert.deepEqual(first, second);
	assert.deepEqual(current, { a: '10,00' });
	const cents = Object.values(first).reduce(
		(sum, v) => sum + Math.round(Number.parseFloat(v.replace(',', '.')) * 100),
		0,
	);
	assert.equal(cents, 1000 + 2001);
});
