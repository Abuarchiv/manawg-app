import assert from 'node:assert/strict';
import test from 'node:test';
import { occurredAtSchema } from './expense-schemas';

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

test('occurredAt accepts today and past days within five years', () => {
	assert.equal(occurredAtSchema.safeParse(at(0)).success, true);
	assert.equal(occurredAtSchema.safeParse(at(-30 * DAY_MS)).success, true);
	assert.equal(occurredAtSchema.safeParse(at(-4 * 365 * DAY_MS)).success, true);
});

test('occurredAt rejects far future dates and dates older than five years', () => {
	assert.equal(occurredAtSchema.safeParse(at(3 * DAY_MS)).success, false);
	assert.equal(occurredAtSchema.safeParse(at(-6 * 365 * DAY_MS)).success, false);
	assert.equal(occurredAtSchema.safeParse('2026-13-40').success, false);
});
