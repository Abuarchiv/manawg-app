import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitWithin } from './prepare-upload-image';

test('fitWithin shrinks the longer edge to the limit and keeps the ratio', () => {
	assert.deepEqual(fitWithin(8000, 6000, 2048), { width: 2048, height: 1536 });
	assert.deepEqual(fitWithin(3000, 6000, 2048), { width: 1024, height: 2048 });
});

test('fitWithin never scales a small image up', () => {
	assert.deepEqual(fitWithin(800, 600, 2048), { width: 800, height: 600 });
});
