import assert from 'node:assert/strict';
import test from 'node:test';
import { safeNextPath } from './next-path.ts';

test('keeps same-origin paths with query and hash', () => {
	assert.equal(safeNextPath('/wg/MTE8PZAT/einkauf?x=1#a'), '/wg/MTE8PZAT/einkauf?x=1#a');
	assert.equal(safeNextPath('/a/../wg'), '/wg');
});

test('never returns a path that a browser resolves to another host', () => {
	for (const value of [
		null,
		'',
		'https://evil.com',
		'//evil.com',
		'/\\evil.com',
		'/.//evil.com',
		'/%2e//evil.com',
		'/a/..//evil.com',
		'/./%2F/evil.com',
	]) {
		const next = safeNextPath(value);
		assert.equal(
			new URL(next, 'https://app.manawg.com/neu').origin,
			'https://app.manawg.com',
			String(value),
		);
	}
});
