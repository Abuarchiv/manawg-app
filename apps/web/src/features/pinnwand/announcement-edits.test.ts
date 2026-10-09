import assert from 'node:assert/strict';
import test from 'node:test';
import { isRestorableDraft } from './announcement-edits';

test('only restores drafts that differ from the starting text', () => {
	assert.equal(isRestorableDraft({ content: 'neu' }, 'alt'), true);
	assert.equal(isRestorableDraft({ content: 'neu' }, ''), true);
	// Cancelled or untouched edits leave the original text behind: must not reopen the editor.
	assert.equal(isRestorableDraft({ content: 'alt' }, 'alt'), false);
	assert.equal(isRestorableDraft({ content: '' }, ''), false);
	assert.equal(isRestorableDraft(null, 'alt'), false);
	assert.equal(isRestorableDraft({}, 'alt'), false);
});
