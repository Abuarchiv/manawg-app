import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const path = resolve(appRoot, 'src', `${specifier.slice(2)}.ts`);
			return nextResolve(pathToFileURL(path).href, context);
		}
		return nextResolve(specifier, context);
	},
});

const drafts = await import('../src/core/offline/drafts.ts');
const queue = await import('../src/core/offline/offline-queue.ts');

const SHARE_CODE = 'ABC123';
const MEMBER = 'member-1';
const identity = { wgId: 'wg-1', shareCode: SHARE_CODE, memberId: MEMBER };
const NOW = Date.parse('2026-09-29T10:00:00.000Z');
const UUID = '3f8a1b2c-4d5e-4f60-8172-93a4b5c6d7e8';

function queuedActions() {
	return [
		queue.createQueuedShoppingItem({ ...identity, name: 'Hafermilch', quantity: '2', now: NOW }),
		queue.createQueuedChore({
			...identity,
			title: 'Badezimmer',
			intervalDays: 7,
			assignedMemberId: MEMBER,
			now: NOW,
		}),
		queue.createQueuedAbsence({
			...identity,
			absenceMemberId: MEMBER,
			startDate: '2026-10-01T00:00:00.000Z',
			endDate: '2026-10-03T23:59:59.999Z',
			reason: 'Urlaub',
			now: NOW,
		}),
	];
}

test('#505: rows created offline carry a synthetic id that no route will accept', () => {
	for (const action of queuedActions()) {
		assert.equal(
			queue.isServerRowId(action.id),
			false,
			`${action.type} must not look like a server id`,
		);
	}
	assert.equal(queue.isServerRowId(UUID), true);
});

test('#505: removing a queued row drops it from the queue instead of sending DELETE', () => {
	const [shopping, chore, absence] = queuedActions();
	for (const action of [shopping, chore, absence]) {
		const removal = queue.resolveLocalRowRemoval([action], SHARE_CODE, action.id);
		assert.ok(removal, `${action.type} must be resolvable locally`);
		assert.equal(removal.dropped, true);
		assert.deepEqual(removal.queue, []);
	}
});

test('#505: server-issued ids still go through the API', () => {
	const [shopping] = queuedActions();
	assert.equal(queue.resolveLocalRowRemoval([shopping], SHARE_CODE, UUID), null);
});

test('#505: a synthetic id without a queue entry is still removed locally', () => {
	const removal = queue.resolveLocalRowRemoval(
		[],
		SHARE_CODE,
		`shopping:${SHARE_CODE}:${NOW}:milch`,
	);
	assert.ok(removal);
	assert.equal(removal.dropped, false);
	assert.deepEqual(removal.queue, []);
});

test('#505: entries of other WGs are never dropped', () => {
	const [shopping] = queuedActions();
	const removal = queue.resolveLocalRowRemoval([shopping], 'OTHER1', shopping.id);
	assert.ok(removal);
	assert.equal(removal.dropped, false);
	assert.deepEqual(removal.queue, [shopping]);
});

test('#506: absence queue drafts use the module the Putzplan reads', () => {
	const action = {
		id: `absence:${SHARE_CODE}:${NOW}:${MEMBER}`,
		type: 'absence.create',
		shareCode: SHARE_CODE,
		memberId: MEMBER,
		createdAt: new Date(NOW).toISOString(),
		payload: {
			memberId: MEMBER,
			startDate: '2026-10-01T00:00:00.000Z',
			endDate: '2026-10-03T23:59:59.999Z',
			reason: 'Urlaub',
		},
	};
	const queueDraft = drafts.buildQueueEditDraft(action);
	assert.ok(queueDraft);
	assert.equal(queueDraft.module, 'chore');
	assert.equal(
		drafts.buildDraftKey(SHARE_CODE, MEMBER, queueDraft.module),
		drafts.buildDraftKey(SHARE_CODE, MEMBER, 'chore'),
	);

	const pageSource = readFileSync(
		new URL('../src/app/wg/[code]/putzen/page.tsx', import.meta.url),
		'utf8',
	);
	assert.match(
		pageSource,
		/buildDraftKey\(wg\.shareCode, identity\.memberId, 'chore'\)/,
		'the Putzplan must read the chore draft key the queue writes',
	);
});

test('#506: a cleared queue edit counts as an empty Putzplan draft again', () => {
	const cleared = {
		title: '',
		intervalDays: 7,
		recurrenceType: 'days',
		assignedMemberId: '',
		absenceMemberId: MEMBER,
		absenceStartDate: '',
		absenceEndDate: '',
		absenceReason: '',
		queueEditId: null,
		queueEditType: null,
	};
	assert.equal(drafts.isEmptyModuleDraft('chore', cleared, MEMBER), true);
	assert.equal(
		drafts.isEmptyModuleDraft(
			'chore',
			{
				...cleared,
				queueEditId: `absence:${SHARE_CODE}:${NOW}:${MEMBER}`,
				queueEditType: 'absence.create',
				absenceStartDate: '2026-10-01T00:00:00.000Z',
			},
			MEMBER,
		),
		false,
		'an open queue edit must stay protected from the conflict guard',
	);
});

const sampleActions = {
	'shopping.create': { name: 'Hafermilch', quantity: '2' },
	'shopping.update': { itemId: UUID, name: 'Hafermilch', bought: true },
	'announcement.create': { content: 'Putzplan aktualisiert', kind: 'info', imageUrl: null },
	'absence.create': {
		memberId: MEMBER,
		startDate: '2026-10-01T00:00:00.000Z',
		endDate: '2026-10-03T23:59:59.999Z',
		reason: 'Urlaub',
	},
	'chore.create': {
		title: 'Badezimmer',
		intervalDays: 7,
		recurrenceType: 'days',
		assignedMemberId: MEMBER,
	},
	'chore.complete': { choreId: UUID },
	'expense.create': {
		description: 'Strom',
		amountCents: 4250,
		paidByMemberId: MEMBER,
		splits: [{ debtorMemberId: MEMBER, amountCents: 4250 }],
		imageUrl: null,
	},
	'expense.update': {
		expenseId: UUID,
		description: 'Strom',
		amountCents: 4250,
		paidByMemberId: MEMBER,
		splits: [{ debtorMemberId: MEMBER, amountCents: 4250 }],
	},
	'recurring.create': {
		description: 'Miete',
		amountCents: 90000,
		paidByMemberId: MEMBER,
		intervalMonths: 1,
		nextDueAt: '2026-10-01T00:00:00.000Z',
		splits: [{ debtorMemberId: MEMBER, amountCents: 90000 }],
	},
	'recurring.advance': { recurringExpenseId: UUID },
};

function sampleAction(type) {
	return {
		id: `${type}:${SHARE_CODE}:${NOW}`,
		type,
		shareCode: SHARE_CODE,
		memberId: MEMBER,
		createdAt: new Date(NOW).toISOString(),
		payload: sampleActions[type],
	};
}

test('#513: queue edit links route only when an owning form exists', () => {
	assert.equal(
		drafts.buildQueueEditActionHref(SHARE_CODE, 'shopping.create'),
		`/wg/${SHARE_CODE}/einkauf`,
	);
	assert.equal(drafts.buildQueueEditActionHref(SHARE_CODE, 'shopping.update'), null);
	assert.equal(
		drafts.buildQueueEditActionHref(SHARE_CODE, 'expense.create'),
		`/wg/${SHARE_CODE}/ausgaben`,
	);
	assert.equal(drafts.buildQueueEditActionHref(SHARE_CODE, 'expense.update'), null);
	assert.equal(
		drafts.buildQueueEditActionHref(SHARE_CODE, 'recurring.create'),
		`/wg/${SHARE_CODE}/ausgaben`,
	);
	assert.equal(
		drafts.buildQueueEditActionHref(SHARE_CODE, 'announcement.create'),
		`/wg/${SHARE_CODE}/pinnwand`,
	);
	assert.equal(
		drafts.buildQueueEditActionHref(SHARE_CODE, 'absence.create'),
		`/wg/${SHARE_CODE}/putzen?panel=absences`,
	);
	assert.equal(
		drafts.buildQueueEditActionHref(SHARE_CODE, 'chore.create'),
		`/wg/${SHARE_CODE}/putzen`,
	);
	assert.equal(drafts.buildQueueEditActionHref(SHARE_CODE, 'chore.complete'), null);
	assert.equal(drafts.buildQueueEditActionHref(SHARE_CODE, 'recurring.advance'), null);
});

test('#513: every action that produces a draft has an owning page', () => {
	for (const type of Object.keys(sampleActions)) {
		const action = sampleAction(type);
		const editDraft = drafts.buildQueueEditDraft(action);
		const href = drafts.buildQueueEditActionHref(SHARE_CODE, action.type);
		if (!editDraft) {
			assert.equal(href, null, `${type} has no draft, so it must not guess a page`);
			continue;
		}
		assert.ok(href, `${type} offers "Bearbeiten" and must therefore route somewhere`);
		// The page it routes to must read the module the draft is written to.
		const routedModule = href.includes('/einkauf')
			? 'shopping'
			: href.includes('/ausgaben')
				? 'expense'
				: href.includes('/pinnwand')
					? 'announcement'
					: 'chore';
		assert.equal(
			editDraft.module,
			routedModule,
			`${type} draft module must match the page it opens (${href})`,
		);
	}
});
