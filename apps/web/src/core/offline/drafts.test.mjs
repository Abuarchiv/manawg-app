import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcRoot = fileURLToPath(new URL('../..', import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const path = resolve(srcRoot, `${specifier.slice(2)}.ts`);
			return nextResolve(pathToFileURL(path).href, context);
		}
		return nextResolve(specifier, context);
	},
});

const { buildQueueEditDraft, buildQueueEditHref } = await import('./drafts.ts');

const action = (type, payload) => ({ id: `queued-${type}`, type, payload });

test('a queued absence opens in the Putzplan chore draft that the page reads', () => {
	const draft = buildQueueEditDraft(
		action('absence.create', {
			memberId: 'm1',
			startDate: '2026-10-01',
			endDate: '2026-10-03',
			reason: 'Urlaub',
		}),
	);
	assert.equal(draft?.module, 'chore');
	assert.equal(draft?.draft.queueEditId, 'queued-absence.create');
	assert.equal(draft?.draft.absenceStartDate, '2026-10-01');
	assert.equal(
		buildQueueEditHref('MTE8PZAT', 'chore', { openAbsencesPanel: true }),
		'/wg/MTE8PZAT/putzen?panel=absences',
	);
});

test('queued updates offer no edit draft because no form can apply them', () => {
	assert.equal(buildQueueEditDraft(action('shopping.update', { name: 'Milch' })), null);
	assert.equal(
		buildQueueEditDraft(action('expense.update', { description: 'Einkauf', amountCents: 100 })),
		null,
	);
});

test('create drafts still route to their owning page', () => {
	assert.equal(
		buildQueueEditDraft(action('shopping.create', { name: 'Milch' }))?.module,
		'shopping',
	);
	assert.equal(
		buildQueueEditDraft(action('expense.create', { description: 'x', amountCents: 100 }))?.module,
		'expense',
	);
	assert.equal(buildQueueEditHref('MTE8PZAT', 'shopping'), '/wg/MTE8PZAT/einkauf');
});

test('a queued recurring booking keeps its template link and expected due date', () => {
	const draft = buildQueueEditDraft(
		action('expense.create', {
			description: 'Miete',
			amountCents: 50000,
			paidByMemberId: 'm1',
			recurringExpenseId: 'rec-1',
			expectedRecurringNextDueAt: '2026-10-01T00:00:00.000Z',
		}),
	);
	assert.equal(draft?.module, 'expense');
	assert.equal(draft?.draft.recurringSourceId, 'rec-1');
	assert.equal(draft?.draft.recurringNextDueAt, '2026-10-01T00:00:00.000Z');
});

test('a plain queued expense carries no template link', () => {
	const draft = buildQueueEditDraft(
		action('expense.create', { description: 'Einkauf', amountCents: 100 }),
	);
	assert.equal(draft?.draft.recurringSourceId, undefined);
	assert.equal(draft?.draft.recurringNextDueAt, undefined);
});
