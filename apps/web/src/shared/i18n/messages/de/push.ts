export default {
	fallback: {
		wgName: 'deiner WG',
		someone: 'Jemand',
		expense: 'eine Ausgabe',
		fixedCostTemplate: 'Eine Fixkosten-Vorlage',
		creditor: 'jemandem',
		task: 'Eine Aufgabe',
		shoppingItem: 'etwas',
		event: 'Termin',
		supply: 'Vorrat',
		post: 'Beitrag',
		newMessage: 'Neue Nachricht',
		newReply: 'Neue Antwort',
		newMention: 'Neue Erwähnung',
		soon: 'demnächst',
	},
	eventTime: {
		allDay: '{date} (ganztägig)',
	},
	test: {
		title: 'ManaWG Test',
		body: 'Benachrichtigungen funktionieren für {wgName}.',
	},
	expenseCreated: {
		title: 'Neue Ausgabe',
		body: '{actorName} hat in {wgName} {title} für {amount} eingetragen.',
	},
	recurringCharged: {
		title: 'Neue Fixkosten-Buchung',
		body: 'Neue Fixkosten-Buchung: {description} {amount}',
	},
	expenseReminder: {
		title: 'Erinnerung',
		body: 'Noch offen bei {creditor}: {amount}.',
		bodyAged:
			'Noch offen bei {creditor}: {amount} (ältester Posten {days, plural, one {{days, number, ::group-off} Tag} other {{days, number, ::group-off} Tage}} alt).',
	},
	debtSettled: {
		title: 'Ausgleich eingetragen',
		received: '{actorName} hat den Eingang von {amount} von dir bestätigt.',
		paid: '{actorName} hat {amount} an dich beglichen. Stimmt das nicht, öffne die Ausgaben und widersprich dort.',
	},
	paymentVoided: {
		title: 'Barzahlung storniert',
		body: '{actorName} hat die Barzahlung über {amount} storniert. Der Betrag ist wieder offen.',
	},
	importCompleted: {
		title: 'Import abgeschlossen',
		body: '{actorName} hat {inserted, plural, one {{inserted, number, ::group-off} Ausgabe} other {{inserted, number, ::group-off} Ausgaben}} in {wgName} importiert.',
	},
	announcementPosted: {
		title: 'Neue Pinnwand-Nachricht',
		body: '{actorName} in {wgName}: {title}',
	},
	announcementCommented: {
		title: 'Neue Antwort',
		body: '{actorName} hat auf der Pinnwand geantwortet: {title}',
	},
	announcementResolved: {
		title: 'Pinnwand geklärt',
		body: '{actorName} hat einen Beitrag als geklärt markiert: {title}',
	},
	choreDue: {
		title: 'Putzplan',
		today: '{title} ist heute in {wgName} fällig.',
		tomorrow: '{title} ist morgen in {wgName} fällig.',
		onDate: '{title} ist am {date} in {wgName} fällig.',
		overdue:
			'{title} ist in {wgName} seit {days, plural, one {{days, number, ::group-off} Tag} other {{days, number, ::group-off} Tagen}} offen.',
		unassigned: 'Niemand ist zuständig.',
	},
	shoppingAdded: {
		title: 'Einkaufsliste',
		body: '{actorName} hat {title} in {wgName} hinzugefügt.',
	},
	eventCreated: {
		title: 'Neuer Termin',
		body: '{actorName} hat in {wgName} „{title}“ am {when} eingetragen.',
	},
	eventMoved: {
		title: 'Termin verschoben',
		series: '{actorName} hat die Terminserie „{title}“ in {wgName} verschoben.',
		single: '{actorName} hat „{title}“ in {wgName} auf den {when} verschoben.',
	},
	eventCancelled: {
		title: 'Termin abgesagt',
		series: '{actorName} hat die Terminserie „{title}“ in {wgName} abgesagt.',
		single: '{actorName} hat „{title}“ am {when} in {wgName} abgesagt.',
	},
	eventUpcoming: {
		title: 'Termin morgen',
		allDay: 'Morgen in {wgName}: „{title}“ am {when}.',
		timed: 'Morgen in {wgName}: „{title}“ am {when}.',
	},
	eventToday: {
		title: 'Termin heute',
		allDay: 'Heute in {wgName}: „{title}“ ist ganztägig.',
		ongoing: 'Heute in {wgName}: „{title}“ läuft noch.',
		timed: 'Heute in {wgName}: „{title}“ am {when}.',
	},
	lowStock: {
		title: 'Vorrat bald leer',
		body: 'Bald leer: {itemName} in {wgName}.',
		bodyDetail: 'Bald leer: {itemName} ({quantity} von {threshold}) in {wgName}.',
	},
	chatMessage: {
		title: 'Chat — {wgName}',
		body: '{sender}: {preview}',
	},
	chatMention: {
		title: '{sender} hat dich erwähnt',
		body: '{sender} hat dich erwähnt: {preview}',
	},
} as const;
