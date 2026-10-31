/** Why a queued offline action could not be sent: a title and a detail per cause. */
export default {
	noConnection: {
		title: 'Noch keine Verbindung',
		detail: 'Die Aktion bleibt gespeichert und wird erneut versucht, sobald das Netz zurück ist.',
	},
	rateLimited: {
		title: 'Zu viele Anfragen',
		detail: 'Die Aktion bleibt in der Warteschlange und wird gleich automatisch erneut gesendet.',
	},
	tooLarge: {
		title: 'Bild oder Eintrag ist zu groß',
		detail: 'Entferne den Anhang oder wähle ein kleineres Bild und versuche es erneut.',
	},
	accessMissing: {
		title: 'Zugriff fehlt',
		detail: 'Öffne die WG erneut oder prüfe, ob dein Mitglied noch Zugriff hat.',
	},
	sessionExpired: {
		title: 'Sitzung abgelaufen',
		detail: 'Melde dich neu an und versuche die Aktion danach erneut.',
	},
	targetGone: {
		title: 'Ziel nicht mehr gefunden',
		detail:
			'Der Eintrag oder die WG wurde inzwischen geändert. Prüfe die Aktion vor dem erneuten Versuch.',
	},
	serverNotReady: {
		title: 'Server gerade nicht bereit',
		detail: 'Die Aktion bleibt in der Warteschlange. Versuche es gleich erneut.',
	},
	syncFailed: {
		title: 'Synchronisierung fehlgeschlagen',
		detail: 'Die Aktion bleibt in der Warteschlange. Versuche es später noch einmal.',
	},
	rejected: {
		title: 'Vom Server abgelehnt',
		detail: 'Die Aktion wird nicht erneut gesendet. Bearbeite oder verwirf sie hier.',
	},
	maintenance: {
		title: 'App in Wartung',
		detail:
			'Die Aktion bleibt in der Warteschlange und wird gesendet, sobald die Wartung vorbei ist.',
	},
	memberInvalid: {
		title: 'Mitglied nicht mehr gültig',
		detail:
			'Öffne die WG erneut oder tritt mit einem aktuellen Einladungslink bei, bevor du diese Aktion sendest.',
	},
	movedOut: {
		title: 'Du bist ausgezogen',
		detail:
			'Dein Mitglied ist in dieser WG als ausgezogen markiert. Neu anmelden hilft nicht. Frag die WG, ob sie dich wieder aufnimmt, bevor du diese Aktion sendest.',
	},
	memberInAction: {
		title: 'Mitglied in Aktion prüfen',
		detail:
			'Ein beteiligtes Mitglied ist nicht mehr in der WG. Bearbeite Zuweisung oder Aufteilung vor dem erneuten Senden.',
	},
	flatLinkInvalid: {
		title: 'WG-Link nicht mehr gültig',
		detail:
			'Prüfe den Einladungslink oder lass dir einen neuen Einladungslink geben, bevor du diese Aktion sendest.',
	},
	templateMissing: {
		title: 'Fixkosten-Vorlage fehlt',
		detail:
			'Die Vorlage existiert nicht mehr. Entferne diese Offline-Aktion oder erstelle die Fixkosten neu.',
	},
	recurringPaused: {
		title: 'Fixkosten pausiert',
		detail:
			'Die Fixkosten sind inzwischen pausiert. Entferne diese Offline-Aktion oder setze die Fixkosten fort.',
	},
	shoppingMissing: {
		title: 'Einkauf fehlt',
		detail:
			'Der Artikel existiert nicht mehr. Entferne diese Offline-Aktion oder lege den Einkauf neu an.',
	},
	templateChanged: {
		title: 'Fixkosten-Vorlage geändert',
		detail:
			'Jemand hat die Vorlage inzwischen geändert. Entferne diese Offline-Aktion und buche die Fixkosten mit dem aktuellen Stand.',
	},
	shoppingChanged: {
		title: 'Einkaufsstatus geändert',
		detail:
			'Jemand hat den Artikel inzwischen geändert. Prüfe den aktuellen Stand, bevor du die Aktion neu anlegst.',
	},
	choreChanged: {
		title: 'Putztermin geändert',
		detail:
			'Der Termin wurde inzwischen erledigt oder neu zugewiesen. Prüfe den aktuellen Plan, bevor du die Aktion neu anlegst.',
	},
	choreMissing: {
		title: 'Putzplan-Aufgabe fehlt',
		detail:
			'Die Aufgabe existiert nicht mehr. Entferne diese Offline-Aktion oder lege die Aufgabe neu an.',
	},
	expenseChanged: {
		title: 'Ausgabe geändert',
		detail:
			'Jemand hat die Ausgabe inzwischen geändert. Prüfe die aktuellen Werte, bevor du die Änderung erneut vormerkst.',
	},
	expenseSettled: {
		title: 'Anteil schon beglichen',
		detail:
			'Ein Anteil wurde inzwischen beglichen. Verwirf die Änderung und bearbeite die Ausgabe neu.',
	},
	recurringAdvanced: {
		title: 'Fixkosten schon übernommen',
		detail:
			'Diese Fixkosten wurden für diese Fälligkeit schon übernommen. Entferne diese Offline-Aktion und prüfe die Ausgaben.',
	},
	expenseMissing: {
		title: 'Ausgabe fehlt',
		detail:
			'Die Ausgabe existiert nicht mehr. Entferne diese Offline-Aktion oder erfasse die Ausgabe neu.',
	},
	splitMissing: {
		title: 'Ausgabenanteil fehlt',
		detail:
			'Der Anteil existiert nicht mehr. Entferne diese Offline-Aktion oder prüfe die Ausgabe erneut.',
	},
	imageInvalid: {
		title: 'Anhang prüfen',
		detail: 'Entferne den Anhang oder wähle ein gültiges Bild, bevor du erneut sendest.',
	},
	amountInvalid: {
		title: 'Betrag prüfen',
		detail: 'Bearbeite Betrag und Aufteilung, bevor du diese Aktion erneut sendest.',
	},
	currencyInvalid: {
		title: 'Währung prüfen',
		detail: 'Erfasse die Ausgabe neu mit der aktuellen Euro-Währung.',
	},
	splitsInvalid: {
		title: 'Aufteilung prüfen',
		detail: 'Bearbeite Betrag und Aufteilung, bevor du diese Aktion erneut sendest.',
	},
	entryInvalid: {
		title: 'Eintrag prüfen',
		detail: 'Bearbeite die markierten Felder, bevor du diese Aktion erneut sendest.',
	},
	kindInvalid: {
		title: 'Kategorie prüfen',
		detail: 'Wähle eine aktuelle Pinnwand-Kategorie, bevor du den Beitrag erneut sendest.',
	},
	sourceInvalid: {
		title: 'Quelllink prüfen',
		detail: 'Entferne den alten Quelllink oder erfasse den Pinnwand-Beitrag neu.',
	},
	quantityInvalid: {
		title: 'Menge prüfen',
		detail: 'Kürze oder entferne die Mengenangabe, bevor du diesen Einkauf erneut sendest.',
	},
	dateInvalid: {
		title: 'Datum prüfen',
		detail: 'Bearbeite Datum oder Zeitraum, bevor du diese Aktion erneut sendest.',
	},
	absenceOverlaps: {
		title: 'Abwesenheit überschneidet sich',
		detail:
			'Für diese Person gibt es im Zeitraum schon eine Abwesenheit. Entferne diese Offline-Aktion oder passe den Zeitraum an.',
	},
	actionInvalid: {
		title: 'Offline-Aktion prüfen',
		detail:
			'Die gespeicherte Aktion passt nicht mehr zur aktuellen App. Entferne sie und erfasse den Eintrag neu.',
	},
	targetInvalid: {
		title: 'Ziel prüfen',
		detail:
			'Die gespeicherte Ziel-ID ist ungültig. Entferne diese Offline-Aktion und öffne den Eintrag neu.',
	},
	statusInvalid: {
		title: 'Status prüfen',
		detail: 'Prüfe den Einkaufsstatus, bevor du diese Aktion erneut sendest.',
	},
	intervalInvalid: {
		title: 'Intervall prüfen',
		detail: 'Bearbeite das Intervall, bevor du diese Aktion erneut sendest.',
	},
	reasonInvalid: {
		title: 'Grund prüfen',
		detail: 'Kürze oder entferne den Abwesenheitsgrund, bevor du diese Aktion erneut sendest.',
	},
	choreIncomplete: {
		title: 'Putzplan unvollständig gespeichert',
		detail:
			'Die Aufgabe wurde möglicherweise rotiert, aber nicht im Verlauf protokolliert. Lade den Putzplan neu und prüfe den Verlauf vor dem erneuten Senden.',
	},
	expenseIncomplete: {
		title: 'Ausgabe unvollständig gespeichert',
		detail:
			'Die Ausgabe oder ihre Aufteilung wurde nicht vollständig gespeichert. Lade die Ausgaben neu und prüfe den Eintrag vor dem erneuten Senden.',
	},
	saveUnconfirmed: {
		title: 'Speichern nicht bestätigt',
		detail:
			'Der Server hat den Eintrag nicht bestätigt. Lade die WG neu und prüfe, ob die Aktion bereits angekommen ist.',
	},
	removeUnconfirmed: {
		title: 'Entfernen nicht bestätigt',
		detail:
			'Der Server hat das Entfernen nicht bestätigt. Lade die WG neu und prüfe den Eintrag vor dem erneuten Senden.',
	},
	updateUnconfirmed: {
		title: 'Aktualisierung nicht bestätigt',
		detail:
			'Der Server hat die Änderung nicht bestätigt. Lade die WG neu und prüfe den aktuellen Stand vor dem erneuten Senden.',
	},
} as const;
