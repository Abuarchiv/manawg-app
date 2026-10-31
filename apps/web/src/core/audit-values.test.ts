import assert from 'node:assert/strict';
import test from 'node:test';

const { auditValues } = await import('./audit-values');
const { AUDIT_EVENT_TYPES, auditFeedMessage } = await import('./audit-messages');
const { serverRenderContext } = await import('./i18n/render-context');

type Case = [eventType: string, metadata: Record<string, unknown>, summary: string];

/** German summaries as stored in the summary column. */
const GERMAN_SUMMARIES: Case[] = [
	['absence.created', {}, 'Anna hat eine Abwesenheit eingetragen.'],
	['absence.deleted', {}, 'Anna hat eine Abwesenheit entfernt.'],
	['announcement.comment.created', {}, 'Anna hat eine Antwort geschrieben.'],
	['announcement.comment.updated', {}, 'Anna hat eine Antwort aktualisiert.'],
	[
		'announcement.comment.deleted',
		{ moderated: true },
		'Anna hat als Admin eine Antwort entfernt.',
	],
	['announcement.comment.deleted', { moderated: false }, 'Anna hat eine Antwort entfernt.'],
	['announcement.reaction.added', { reaction: 'take' }, 'Anna hat mit „Übernehme ich“ reagiert.'],
	['announcement.reaction.added', { reaction: 'seen' }, 'Anna hat mit „Gesehen“ reagiert.'],
	['announcement.reaction.removed', {}, 'Anna hat eine Reaktion entfernt.'],
	['announcement.created', {}, 'Anna hat einen Pinnwand-Beitrag erstellt.'],
	['announcement.updated', {}, 'Anna hat einen Pinnwand-Beitrag aktualisiert.'],
	[
		'announcement.updated',
		{ status: 'resolved', statusChanged: true },
		'Anna hat einen Pinnwand-Beitrag als geklärt markiert.',
	],
	['announcement.deleted', {}, 'Anna hat einen Pinnwand-Beitrag entfernt.'],
	['calendar.feed_created', {}, 'Anna hat den Kalender-Feed angelegt.'],
	['calendar.feed_rotated', {}, 'Anna hat den Kalender-Feed erneuert.'],
	['calendar.feed_revoked', {}, 'Anna hat den Kalender-Feed widerrufen.'],
	['chat.message.created', {}, 'Anna hat im Chat eine Nachricht gesendet.'],
	['chat.message.edited', {}, 'Anna hat eine Chat-Nachricht bearbeitet.'],
	['chat.message.deleted', {}, 'Anna hat eine Chat-Nachricht gelöscht.'],
	['chore.created', { title: 'Bad' }, 'Anna hat Bad im Putzplan angelegt.'],
	['chore.updated', { title: 'Bad' }, 'Anna hat Bad aktualisiert.'],
	['chore.deleted', { title: 'Bad' }, 'Anna hat Bad aus dem Putzplan entfernt.'],
	['chore.completed', { title: 'Bad' }, 'Anna hat Bad erledigt.'],
	['event.created', { title: 'Grillen' }, 'Anna hat den Termin „Grillen“ angelegt.'],
	['event.updated', { title: 'Grillen' }, 'Anna hat den Termin „Grillen“ aktualisiert.'],
	[
		'event.updated',
		{ title: 'Yoga', action: 'cancel' },
		'Anna hat einen Termin der Serie „Yoga“ entfernt.',
	],
	[
		'event.updated',
		{ title: 'Yoga', action: 'move' },
		'Anna hat einen Termin der Serie „Yoga“ geändert.',
	],
	['event.deleted', { title: 'Grillen' }, 'Anna hat den Termin „Grillen“ entfernt.'],
	['expense.created', { description: 'Strom' }, 'Anna hat Strom eingetragen.'],
	['expense.updated', { description: 'Strom' }, 'Anna hat Strom aktualisiert.'],
	['expense.deleted', { description: 'Strom' }, 'Anna hat Strom entfernt.'],
	['expense.split.settled', { description: 'Strom' }, 'Anna hat einen Anteil für Strom beglichen.'],
	[
		'expense.split.reopened',
		{ description: 'Strom' },
		'Anna hat einen Anteil für Strom wieder geöffnet.',
	],
	['expense.debt.settled', { count: 1 }, 'Anna hat 1 offenen Anteil beglichen.'],
	['expense.debt.settled', { count: 3 }, 'Anna hat 3 offene Anteile beglichen.'],
	[
		'expense.debt.settled.manual',
		{ amountCents: 1234, currency: 'EUR' },
		'Anna hat eine Barzahlung über 12,34 € eingetragen.',
	],
	[
		'expense.debt.settled.manual.voided',
		{ amountCents: 1234, currency: 'EUR' },
		'Anna hat eine Barzahlung über 12,34 € storniert.',
	],
	[
		'expense.reminder.sent',
		{ debtorName: 'Ben', creditorName: 'Lena' },
		'Anna hat Ben an offene Schulden bei Lena erinnert.',
	],
	['import.completed', { inserted: 1 }, 'Anna hat 1 Ausgabe importiert.'],
	['import.completed', { inserted: 12 }, 'Anna hat 12 Ausgaben importiert.'],
	['import.completed', { inserted: 0 }, 'Anna hat 0 Ausgaben importiert.'],
	['import.undone', { removed: 1 }, 'Anna hat einen Import rückgängig gemacht (1 Ausgabe).'],
	['import.undone', { removed: 4 }, 'Anna hat einen Import rückgängig gemacht (4 Ausgaben).'],
	['inventory.created', { name: 'Seife' }, 'Anna hat Seife zu den Vorräten hinzugefügt.'],
	['inventory.updated', { name: 'Seife' }, 'Anna hat Seife in den Vorräten aktualisiert.'],
	['inventory.deleted', { name: 'Seife' }, 'Anna hat Seife aus den Vorräten entfernt.'],
	['inventory.deleted', { name: null }, 'Anna hat einen Vorrat aus den Vorräten entfernt.'],
	[
		'inventory.consumed',
		{ name: 'Seife', unit: 'piece', appliedDelta: -1.5 },
		'Anna hat 1,5 Stück Seife entnommen.',
	],
	[
		'inventory.consumed',
		{ name: 'Papier', unit: 'roll', appliedDelta: -2 },
		'Anna hat 2 Rollen Papier entnommen.',
	],

	[
		'inventory.consumed',
		{ name: 'Papier', unit: 'roll', appliedDelta: -1 },
		'Anna hat 1 Rolle Papier entnommen.',
	],

	['shopping.cleared_bought', { count: 1 }, 'Anna hat 1 erledigten Einkaufseintrag entfernt.'],
	['member.invited', {}, 'Anna hat eine Einladung per E-Mail verschickt.'],
	['member.joined', {}, 'Anna ist der WG per Einladung beigetreten.'],
	['member.reactivated', { name: 'Ben' }, 'Anna hat Ben wieder aktiviert.'],
	['member.deactivated', { name: 'Ben' }, 'Anna hat Ben als ausgezogen markiert.'],
	[
		'member.renamed',
		{ before: 'Ben', after: 'Benno', byOther: true },
		'Anna hat Ben in Benno umbenannt.',
	],
	[
		'member.renamed',
		{ before: 'Ben', after: 'Benno', byOther: false },
		'Anna hat sich umbenannt (vorher Ben).',
	],
	['member.admin_transferred', { name: 'Ben' }, 'Anna hat die Admin-Rolle an Ben übergeben.'],
	[
		'member.account_deletion_requested',
		{ name: 'Anna', newAdminName: null },
		'Anna hat die Kontolöschung angefragt und ist ausgezogen.',
	],
	[
		'member.account_deletion_requested',
		{ name: 'Anna', newAdminName: 'Lena' },
		'Anna hat die Kontolöschung angefragt und ist ausgezogen. Lena ist jetzt Admin.',
	],
	['notification.settings.updated', {}, 'Anna hat Benachrichtigungseinstellungen geändert.'],
	['notification.push.subscribed', {}, 'Anna hat Web Push aktiviert.'],
	['notification.push.unsubscribed', {}, 'Anna hat Web Push deaktiviert.'],
	['recurring.created', { description: 'Miete' }, 'Anna hat Miete als Fixkosten-Vorlage angelegt.'],
	['recurring.paused', { description: 'Miete' }, 'Anna hat die Fixkosten Miete pausiert.'],
	['recurring.resumed', { description: 'Miete' }, 'Anna hat die Fixkosten Miete reaktiviert.'],
	[
		'recurring.updated',
		{ description: 'Miete' },
		'Anna hat die Fixkosten-Vorlage Miete aktualisiert.',
	],
	['recurring.deleted', { description: 'Miete' }, 'Anna hat die Fixkosten-Vorlage Miete gelöscht.'],
	[
		'recurring.charged',
		{ description: 'Miete' },
		'Fixkosten-Buchung Miete wurde automatisch eingetragen.',
	],
	[
		'recurring.auto_paused',
		{ description: 'Miete' },
		'Fixkosten-Vorlage Miete wurde automatisch pausiert.',
	],
	[
		'recurring.advanced',
		{ description: 'Miete' },
		'Miete wurde aus einer Fixkosten-Vorlage übernommen.',
	],
	['shopping.created', { title: 'Brot' }, 'Anna hat Brot auf die Einkaufsliste gesetzt.'],
	['shopping.updated', { name: 'Brot' }, 'Anna hat Brot geändert.'],
	['shopping.bought', { name: 'Brot' }, 'Anna hat Brot gekauft.'],
	['shopping.reopened', { name: 'Brot' }, 'Anna hat Brot wieder geöffnet.'],
	['shopping.deleted', { name: 'Brot' }, 'Anna hat Brot aus der Einkaufsliste entfernt.'],
	['shopping.cleared_bought', { count: 4 }, 'Anna hat 4 erledigte Einkaufseinträge entfernt.'],
	['wg.created', {}, 'Anna hat die WG erstellt.'],
	['wg.updated', {}, 'Anna hat die WG-Einstellungen geändert.'],
	['wg.invite_created', {}, 'Anna hat eine Einladung erstellt.'],
	['wg.invite_revoked', {}, 'Anna hat eine Einladung widerrufen.'],
];

const row = (eventType: string, metadata: Record<string, unknown>) =>
	auditValues({
		wgId: 'wg',
		memberId: 'm1',
		eventType,
		entityType: 'x',
		actorName: 'Anna',
		metadata,
	});

test('the German summary stays byte-identical to the sentence written before the catalog', () => {
	for (const [eventType, metadata, summary] of GERMAN_SUMMARIES) {
		assert.equal(row(eventType, metadata).summary, summary, eventType);
	}
});

test('every audit event type is covered by a byte-identity case', () => {
	const covered = new Set(GERMAN_SUMMARIES.map(([eventType]) => eventType));
	assert.deepEqual([...covered].sort(), [...AUDIT_EVENT_TYPES].sort());
});

test('the row keeps the sentence parameters in its metadata and has no content keys', () => {
	const stored = row('chore.completed', { title: 'Bad', nextAssignedMemberId: 'm2' });
	assert.deepEqual(JSON.parse(stored.metadataJson ?? '{}'), {
		title: 'Bad',
		nextAssignedMemberId: 'm2',
	});
	for (const [, metadata] of GERMAN_SUMMARIES) {
		for (const key of Object.keys(metadata)) assert.doesNotMatch(key, /^content/u);
	}
});

test('an event without its sentence parameters is refused', () => {
	assert.throws(() => row('chore.completed', {}), /chore\.completed/u);
	assert.throws(() => row('unknown.event', {}), /unknown\.event/u);
});

test('the feed renders the same sentence per locale and the reader own verb forms', () => {
	const de = serverRenderContext('de');
	const en = serverRenderContext('en');
	const feed = (ctx: typeof de, self: boolean) => {
		const message = auditFeedMessage('chore.completed', { title: 'Bad' }, ctx.locale, self);
		return message ? ctx.render(message) : null;
	};
	assert.equal(feed(de, false), 'hat Bad erledigt.');
	assert.equal(feed(de, true), 'hast Bad erledigt.');
	assert.equal(feed(en, false), 'marked Bad as done.');
	assert.equal(feed(en, true), 'marked Bad as done.');
});

test('German keeps the reader-own wording of the earlier client rewrite', () => {
	const de = serverRenderContext('de');
	const own = (eventType: string, metadata: Record<string, unknown>) => {
		const message = auditFeedMessage(eventType, metadata, 'de', true);
		return message ? de.render(message) : null;
	};
	assert.equal(
		own('member.renamed', { before: 'Ben', after: 'Benno', byOther: false }),
		'hast sich umbenannt (vorher Ben).',
	);
	assert.equal(
		own('member.account_deletion_requested', { name: 'Anna', newAdminName: null }),
		'hast die Kontolöschung angefragt und ist ausgezogen.',
	);
});

test('English renders amounts, counts and units in the reader locale', () => {
	const en = serverRenderContext('en');
	const say = (eventType: string, metadata: Record<string, unknown>) => {
		const message = auditFeedMessage(eventType, metadata, 'en', false);
		return message ? en.render(message) : null;
	};
	assert.equal(
		say('expense.debt.settled.manual', { amountCents: 1234, currency: 'EUR' }),
		'recorded a cash payment of €12.34.',
	);
	assert.equal(say('expense.debt.settled', { count: 1 }), 'settled 1 open share.');
	assert.equal(
		say('inventory.consumed', { name: 'Soap', unit: 'piece', appliedDelta: -1.5 }),
		'took 1.5 pcs of Soap.',
	);
	for (const [unit, appliedDelta, expected] of [
		['roll', -1, 'took 1 roll of Paper.'],
		['roll', -2, 'took 2 rolls of Paper.'],
		['pack', -1.5, 'took 1.5 packs of Paper.'],
	] as const) {
		assert.equal(say('inventory.consumed', { name: 'Paper', unit, appliedDelta }), expected);
	}
	assert.equal(
		say('member.renamed', { before: 'Ben', after: 'Benno', byOther: false }),
		'changed their name (was Ben).',
	);
	assert.equal(
		say('announcement.reaction.added', { reaction: 'take' }),
		'reacted with “I’ll take it”.',
	);
	assert.equal(
		say('event.updated', { title: 'Yoga', action: 'cancel' }),
		'removed an occurrence of the series “Yoga”.',
	);
});

test('a row without its parameters has no sentence, so the stored summary is shown', () => {
	assert.equal(
		auditFeedMessage('chore.completed', { nextAssignedMemberId: 'x' }, 'en', false),
		null,
	);
	assert.equal(auditFeedMessage('chore.completed', null, 'en', false), null);
});
