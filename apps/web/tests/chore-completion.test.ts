import assert from 'node:assert/strict';
import test from 'node:test';

const {
	CHORE_COMPLETION_COPY,
	choreCompletionFeedback,
	completionRequestKey,
	submitChoreCompletion,
} = await import('../src/features/chores/chore-completion.ts');

const chore = { title: 'Bad putzen' };
const names = (id: string | null) => (id === 'anna' ? 'Anna' : undefined);

test('completionRequestKey is stable per occurrence', () => {
	const occurrence = { id: 'c1', nextDueAt: '2026-10-06T10:00:00.000Z' };
	assert.equal(completionRequestKey(occurrence), completionRequestKey({ ...occurrence }));
	assert.notEqual(
		completionRequestKey(occurrence),
		completionRequestKey({ ...occurrence, nextDueAt: '2026-10-13T10:00:00.000Z' }),
	);
});

test('a confirmed completion names the next date and assignee', () => {
	const feedback = choreCompletionFeedback(
		{
			kind: 'completed',
			next: { id: 'c1', nextDueAt: '2026-10-13T10:00:00.000Z', assignedMemberId: 'anna' },
		},
		chore,
		names,
	);
	assert.equal(feedback.tone, 'success');
	assert.match(feedback.message, /^Bad putzen erledigt\. Als Nächstes ist Anna am .+ dran\.$/);
	assert.equal(feedback.done, true);
	assert.equal(feedback.reload, true);
});

test('an unconfirmed completion still says it is done', () => {
	const feedback = choreCompletionFeedback({ kind: 'completed', next: null }, chore, names);
	assert.match(feedback.message, /^Bad putzen erledigt\./);
});

test('retryable failures keep the confirm step open', () => {
	for (const kind of [
		'failed',
		'insert_failed',
		'queue_blocked',
		'key_unavailable',
		'read_only',
		'session_expired',
	] as const) {
		const feedback = choreCompletionFeedback({ kind }, chore, names);
		assert.equal(feedback.tone, 'error', kind);
		assert.equal(feedback.done, false, kind);
	}
	assert.equal(
		choreCompletionFeedback({ kind: 'failed' }, chore, names).message,
		CHORE_COMPLETION_COPY.failed,
	);
});

test('a moved occurrence ends the confirm step and reloads the plan', () => {
	const feedback = choreCompletionFeedback({ kind: 'occurrence_changed' }, chore, names);
	assert.deepEqual(feedback, {
		tone: 'error',
		message: CHORE_COMPLETION_COPY.occurrenceChanged,
		toast: null,
		done: true,
		reload: true,
	});
});

test('an offline completion is a notice and needs no reload', () => {
	const feedback = choreCompletionFeedback({ kind: 'queued' }, chore, names);
	assert.equal(feedback.tone, 'notice');
	assert.equal(feedback.message, CHORE_COMPLETION_COPY.queued);
	assert.equal(feedback.reload, false);
});

test('maintenance and expired sessions are not reported as a generic failure', async () => {
	const realFetch = globalThis.fetch;
	const ctx = { wgId: 'wg', shareCode: 'ABC', memberId: 'm1', keys: new Map<string, string>() };
	const occurrence = {
		id: 'c1',
		title: 'Bad',
		nextDueAt: '2026-10-06T10:00:00.000Z',
		assignedMemberId: 'm1',
	};
	try {
		for (const [status, error, kind] of [
			[503, 'migration_read_only', 'read_only'],
			[401, 'auth_required', 'session_expired'],
		] as const) {
			globalThis.fetch = (async () =>
				new Response(JSON.stringify({ error }), {
					status,
					headers: { 'content-type': 'application/json' },
				})) as typeof fetch;
			assert.deepEqual(await submitChoreCompletion(ctx, occurrence), { kind });
		}
	} finally {
		globalThis.fetch = realFetch;
	}
});
