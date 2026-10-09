import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRejectedPendingUpload, pendingUploadErrorMessage } from './image-upload-errors';

test('a 4xx answer to the upload PUT is final and explained', () => {
	const err = new Error('upload-failed:403');
	assert.equal(isRejectedPendingUpload(err), true);
	assert.match(pendingUploadErrorMessage(err) ?? '', /abgelehnt/);
});

test('timeouts, rate limits and 5xx answers stay silently retryable', () => {
	for (const status of [408, 429, 500, 503]) {
		const err = new Error(`upload-failed:${status}`);
		assert.equal(isRejectedPendingUpload(err), false);
		assert.equal(pendingUploadErrorMessage(err), null);
	}
});
