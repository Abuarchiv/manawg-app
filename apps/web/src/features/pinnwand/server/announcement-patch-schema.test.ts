import assert from 'node:assert/strict';
import test from 'node:test';
import { patchAnnouncementSchema } from './announcement-patch-schema';

test('rejects an empty or unknown-only patch', () => {
	assert.equal(patchAnnouncementSchema.safeParse({}).success, false);
	assert.equal(patchAnnouncementSchema.safeParse({ pin: true }).success, false);
	assert.equal(patchAnnouncementSchema.safeParse({ pinned: true, foo: 1 }).success, false);
});

test('accepts a single known field and trims content', () => {
	assert.equal(patchAnnouncementSchema.safeParse({ pinned: false }).success, true);
	assert.equal(patchAnnouncementSchema.safeParse({ status: 'resolved' }).success, true);
	const edited = patchAnnouncementSchema.safeParse({ content: '  Neu  ', kind: 'problem' });
	assert.deepEqual(edited.success && edited.data, { content: 'Neu', kind: 'problem' });
});

test('rejects blank, oversized and unknown values', () => {
	assert.equal(patchAnnouncementSchema.safeParse({ content: '   ' }).success, false);
	assert.equal(patchAnnouncementSchema.safeParse({ content: 'x'.repeat(2001) }).success, false);
	assert.equal(patchAnnouncementSchema.safeParse({ kind: 'nope' }).success, false);
});
