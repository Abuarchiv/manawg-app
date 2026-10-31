export default {
	summary: '{actorName} {text}',
	absenceCreated: {
		feed: '{self, select, yes {hast} other {hat}} eine Abwesenheit eingetragen.',
	},
	absenceDeleted: {
		feed: '{self, select, yes {hast} other {hat}} eine Abwesenheit entfernt.',
	},
	announcementCommentCreated: {
		feed: '{self, select, yes {hast} other {hat}} eine Antwort geschrieben.',
	},
	announcementCommentUpdated: {
		feed: '{self, select, yes {hast} other {hat}} eine Antwort aktualisiert.',
	},
	announcementCommentDeleted: {
		feed: '{self, select, yes {hast} other {hat}} {moderated, select, yes {als Admin eine Antwort} other {eine Antwort}} entfernt.',
	},
	announcementReactionAdded: {
		feed: '{self, select, yes {hast} other {hat}} mit „{reaction}“ reagiert.',
	},
	announcementReactionRemoved: {
		feed: '{self, select, yes {hast} other {hat}} eine Reaktion entfernt.',
	},
	announcementCreated: {
		feed: '{self, select, yes {hast} other {hat}} einen Pinnwand-Beitrag erstellt.',
	},
	announcementUpdated: {
		feed: '{self, select, yes {hast} other {hat}} {change, select, resolved {einen Pinnwand-Beitrag als geklärt markiert.} open {einen Pinnwand-Beitrag wieder geöffnet.} other {einen Pinnwand-Beitrag aktualisiert.}}',
	},
	announcementDeleted: {
		feed: '{self, select, yes {hast} other {hat}} einen Pinnwand-Beitrag entfernt.',
	},
	calendarFeedCreated: {
		feed: '{self, select, yes {hast} other {hat}} den Kalender-Feed angelegt.',
	},
	calendarFeedRotated: {
		feed: '{self, select, yes {hast} other {hat}} den Kalender-Feed erneuert.',
	},
	calendarFeedRevoked: {
		feed: '{self, select, yes {hast} other {hat}} den Kalender-Feed widerrufen.',
	},
	chatMessageCreated: {
		feed: '{self, select, yes {hast} other {hat}} im Chat eine Nachricht gesendet.',
	},
	chatMessageEdited: {
		feed: '{self, select, yes {hast} other {hat}} eine Chat-Nachricht bearbeitet.',
	},
	chatMessageDeleted: {
		feed: '{self, select, yes {hast} other {hat}} eine Chat-Nachricht gelöscht.',
	},
	choreCreated: {
		feed: '{self, select, yes {hast} other {hat}} {title} im Putzplan angelegt.',
	},
	choreUpdated: {
		feed: '{self, select, yes {hast} other {hat}} {title} aktualisiert.',
	},
	choreDeleted: {
		feed: '{self, select, yes {hast} other {hat}} {title} aus dem Putzplan entfernt.',
	},
	choreCompleted: {
		feed: '{self, select, yes {hast} other {hat}} {title} erledigt.',
	},
	eventCreated: {
		feed: '{self, select, yes {hast} other {hat}} den Termin „{title}“ angelegt.',
	},
	eventUpdated: {
		feed: '{self, select, yes {hast} other {hat}} {occurrence, select, cancel {einen Termin der Serie „{title}“ entfernt.} change {einen Termin der Serie „{title}“ geändert.} other {den Termin „{title}“ aktualisiert.}}',
	},
	eventDeleted: {
		feed: '{self, select, yes {hast} other {hat}} den Termin „{title}“ entfernt.',
	},
	expenseCreated: {
		feed: '{self, select, yes {hast} other {hat}} {description} eingetragen.',
	},
	expenseUpdated: {
		feed: '{self, select, yes {hast} other {hat}} {description} aktualisiert.',
	},
	expenseDeleted: {
		feed: '{self, select, yes {hast} other {hat}} {description} entfernt.',
	},
	expenseSplitSettled: {
		feed: '{self, select, yes {hast} other {hat}} einen Anteil für {description} beglichen.',
	},
	expenseSplitReopened: {
		feed: '{self, select, yes {hast} other {hat}} einen Anteil für {description} wieder geöffnet.',
	},
	expenseDebtSettled: {
		feed: '{self, select, yes {hast} other {hat}} {count, plural, one {# offenen Anteil} other {# offene Anteile}} beglichen.',
	},
	expenseDebtSettledManual: {
		feed: '{self, select, yes {hast} other {hat}} eine Barzahlung über {amount} eingetragen.',
	},
	expenseDebtSettledManualVoided: {
		feed: '{self, select, yes {hast} other {hat}} eine Barzahlung über {amount} storniert.',
	},
	expenseReminderSent: {
		feed: '{self, select, yes {hast} other {hat}} {debtorName} an offene Schulden bei {creditorName} erinnert.',
	},
	importCompleted: {
		feed: '{self, select, yes {hast} other {hat}} {inserted, plural, one {# Ausgabe} other {# Ausgaben}} importiert.',
	},
	importUndone: {
		feed: '{self, select, yes {hast} other {hat}} einen Import rückgängig gemacht ({removed, plural, one {# Ausgabe} other {# Ausgaben}}).',
	},
	inventoryCreated: {
		feed: '{self, select, yes {hast} other {hat}} {name} zu den Vorräten hinzugefügt.',
	},
	inventoryUpdated: {
		feed: '{self, select, yes {hast} other {hat}} {name} in den Vorräten aktualisiert.',
	},
	inventoryDeleted: {
		feed: '{self, select, yes {hast} other {hat}} {hasName, select, yes {{name}} other {einen Vorrat}} aus den Vorräten entfernt.',
	},
	inventoryConsumed: {
		feed: '{self, select, yes {hast} other {hat}} {quantity} {unitKey, select, piece {Stück} litre {L} kilogram {kg} roll {{count, plural, =1 {Rolle} other {Rollen}}} pack {{count, plural, =1 {Packung} other {Packungen}}} other {{unit}}} {name} entnommen.',
	},
	memberInvited: {
		feed: '{self, select, yes {hast} other {hat}} eine Einladung per E-Mail verschickt.',
	},
	memberJoined: {
		feed: '{self, select, yes {bist} other {ist}} der WG per Einladung beigetreten.',
	},
	memberReactivated: {
		feed: '{self, select, yes {hast} other {hat}} {name} wieder aktiviert.',
	},
	memberDeactivated: {
		feed: '{self, select, yes {hast} other {hat}} {name} als ausgezogen markiert.',
	},
	memberRenamed: {
		feed: '{self, select, yes {hast} other {hat}} {byOther, select, yes {{before} in {after} umbenannt.} other {sich umbenannt (vorher {before}).}}',
	},
	memberAdminTransferred: {
		feed: '{self, select, yes {hast} other {hat}} die Admin-Rolle an {name} übergeben.',
	},
	memberAccountDeletionRequested: {
		feed: '{self, select, yes {hast} other {hat}} die Kontolöschung angefragt und ist ausgezogen.{hasNewAdmin, select, yes { {newAdminName} ist jetzt Admin.} other {}}',
	},
	notificationSettingsUpdated: {
		feed: '{self, select, yes {hast} other {hat}} Benachrichtigungseinstellungen geändert.',
	},
	notificationPushSubscribed: {
		feed: '{self, select, yes {hast} other {hat}} Web Push aktiviert.',
	},
	notificationPushUnsubscribed: {
		feed: '{self, select, yes {hast} other {hat}} Web Push deaktiviert.',
	},
	recurringCreated: {
		feed: '{self, select, yes {hast} other {hat}} {description} als Fixkosten-Vorlage angelegt.',
	},
	recurringPaused: {
		feed: '{self, select, yes {hast} other {hat}} die Fixkosten {description} pausiert.',
	},
	recurringResumed: {
		feed: '{self, select, yes {hast} other {hat}} die Fixkosten {description} reaktiviert.',
	},
	recurringUpdated: {
		feed: '{self, select, yes {hast} other {hat}} die Fixkosten-Vorlage {description} aktualisiert.',
	},
	recurringDeleted: {
		feed: '{self, select, yes {hast} other {hat}} die Fixkosten-Vorlage {description} gelöscht.',
	},
	recurringCharged: {
		feed: 'Fixkosten-Buchung {description} wurde automatisch eingetragen.',
	},
	recurringAutoPaused: {
		feed: 'Fixkosten-Vorlage {description} wurde automatisch pausiert.',
	},
	recurringAdvanced: {
		feed: '{description} wurde aus einer Fixkosten-Vorlage übernommen.',
	},
	shoppingCreated: {
		feed: '{self, select, yes {hast} other {hat}} {title} auf die Einkaufsliste gesetzt.',
	},
	shoppingUpdated: {
		feed: '{self, select, yes {hast} other {hat}} {name} geändert.',
	},
	shoppingBought: {
		feed: '{self, select, yes {hast} other {hat}} {name} gekauft.',
	},
	shoppingReopened: {
		feed: '{self, select, yes {hast} other {hat}} {name} wieder geöffnet.',
	},
	shoppingDeleted: {
		feed: '{self, select, yes {hast} other {hat}} {name} aus der Einkaufsliste entfernt.',
	},
	shoppingClearedBought: {
		feed: '{self, select, yes {hast} other {hat}} {count, plural, one {# erledigten Einkaufseintrag} other {# erledigte Einkaufseinträge}} entfernt.',
	},
	wgCreated: {
		feed: '{self, select, yes {hast} other {hat}} die WG erstellt.',
	},
	wgUpdated: {
		feed: '{self, select, yes {hast} other {hat}} die WG-Einstellungen geändert.',
	},
	wgInviteCreated: {
		feed: '{self, select, yes {hast} other {hat}} eine Einladung erstellt.',
	},
	wgInviteRevoked: {
		feed: '{self, select, yes {hast} other {hat}} eine Einladung widerrufen.',
	},
	timeline: {
		system: 'System',
		shoppingBought: '{name} gekauft',
		shoppingAdded: '{name} hinzugefügt',
		choreDone: '{title} erledigt',
		recurringFromTemplate: '{description} aus Vorlage erstellt',
		recurringCreated: '{description} als Fixkosten-Vorlage angelegt',
		recurringLabel: 'Fixkosten',
		absenceAway: '{self, select, yes {bist} other {ist}} abwesend',
		absenceEntered: 'Abwesenheit eingetragen',
	},
	detail: {
		kind: 'Typ: {kind}',
		withImage: 'mit Bild',
		pushOn: 'Web Push aktiv',
		pushOff: 'Web Push aus',
		quietHours: 'Ruhezeit {start}-{end} Uhr',
		quietHoursOff: 'Ruhezeit aus',
		splitCount: '{count, plural, one {# Aufteilung} other {# Aufteilungen}}',
		reaction: 'Reaktion: {reaction}',
		everyDays: '{days, plural, =1 {täglich} other {alle # Tage}}',
		everyMonths: '{months, plural, =1 {monatlich} other {alle # Monate}}',
		away: 'abwesend {range}',
		nextDue: 'nächste Fälligkeit {date}',
		shares: '{count, plural, one {# Anteil} other {# Anteile}}',
		fields: {
			pushOptIn: 'Web Push',
			notifyAnnouncements: 'Pinnwand',
			notifyChores: 'Putzplan',
			notifyExpenses: 'Ausgaben',
			notifyShopping: 'Einkäufe',
			notifyInventory: 'Vorräte',
			notifyReminders: 'Erinnerungen',
			notifyChat: 'Chat',
			notifyEvents: 'Kalender',
			notifyStatementEmail: 'Monatsabrechnung per E-Mail',
			quietStartHour: 'Ruhezeit Start',
			quietEndHour: 'Ruhezeit Ende',
		},
	},
} as const;
