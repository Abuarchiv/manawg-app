export default {
	title: 'Ausgaben importieren',
	back: 'Zurück zu Ausgaben',
	stepOf: 'Schritt {step} von 5',
	progressAria: 'Import: Schritt {step} von 5',
	boundary: {
		title: 'Import-Assistent konnte nicht geladen werden',
		body: 'Beim Laden des Import-Assistenten ist ein Fehler aufgetreten. Bitte versuche es erneut oder kehre zur WG-Übersicht zurück.',
	},
	actions: {
		back: 'Zurück',
		createPreview: 'Vorschau erstellen',
		continueToPreview: 'Weiter zur Vorschau',
		import: 'Importieren ({count})',
		toExpenses: 'Zu den Ausgaben',
	},
	source: {
		heading: 'Importquelle wählen',
		splitwise: { title: 'Splitwise CSV', hint: 'Datei aus Splitwise' },
		splid: { title: 'Splid CSV', hint: 'Datei aus Splid' },
		screenshot: { title: 'Screenshot', hint: 'Foto oder Bildschirmfoto' },
	},
	input: {
		headingImage: 'Bild hinzufügen',
		headingFile: 'Export-Datei auswählen',
		screenshot: {
			ariaLabel: 'Screenshot auswählen',
			fallback: 'Bild auswählen',
			hint: 'Foto oder Bildschirmfoto bis 10 MB. Nur Eurobeträge (EUR) werden erkannt.',
			running: 'Bild wird ausgewertet. Das kann 30 Sekunden dauern.',
			summary: 'Ergebnis prüfen oder korrigieren',
			label: 'Erkannte Daten',
			placeholder: 'Ergebnis hier prüfen und korrigieren',
		},
		csv: {
			ariaLabel: 'CSV-Datei auswählen',
			fallback: 'Datei auswählen',
			hint: 'Export-Datei bis 5 MB.',
			summary: 'Oder Inhalt einfügen',
			label: 'Inhalt des Exports',
			placeholder: 'Füge den Inhalt deines Exports hier ein',
		},
		errors: {
			imageTooLarge: 'Das Bild ist zu groß (max. 10 MB).',
			csvTooLarge: 'Die CSV-Datei ist zu groß (max. 5 MB).',
			fileUnreadable: 'Die Datei konnte nicht gelesen werden. Wähle sie erneut aus.',
			ocrNeedsReload:
				'Texterkennung konnte nicht geladen werden. Prüfe die Internetverbindung und lade die Seite neu, bevor du es erneut versuchst.',
			ocrInit:
				'Texterkennung konnte nicht initialisiert werden. Prüfe die Internetverbindung und versuche es erneut.',
			ocrFailed: 'Texterkennung fehlgeschlagen. Versuche es mit einem klareren Bild.',
		},
	},
	mapping: {
		heading: 'Namen WG-Mitgliedern zuordnen',
		open: 'Ordne die Namen zu, die noch offen sind.',
		fuzzy: 'Einige Namen wurden nur nach Ähnlichkeit zugeordnet. Bitte prüfen.',
		allRecognised: 'Alle Namen automatisch erkannt. Bitte prüfen.',
		noNames: 'Keine Namen erkannt.',
		suggestion: 'Vorschlag, bitte prüfen',
		selectAria: 'Mitglied für {name} wählen',
		unassigned: 'Noch zuordnen',
		skip: 'Nicht übernehmen (Zeilen überspringen)',
		skipHint: 'Ausgaben mit {name} werden nicht importiert, z. B. weil die Person ausgezogen ist.',
		required: 'Bitte WG-Mitglied auswählen.',
	},
	preview: {
		heading: 'Vorschau',
		selected: '{count} ausgewählt',
		hint: 'Prüfe Beträge und Anteile. Nicht gewünschte Einträge abwählen.',
		skipDuplicates: 'Duplikate überspringen',
		skipDuplicatesHint: 'Gleiches Datum, Beschreibung, Betrag und zahlende Person.',
		empty: 'Keine Ausgaben gefunden',
		listAria: 'Import-Vorschau',
		entryAria: 'Eintrag {number} importieren',
		paidBy: 'bezahlt von {name}',
		willSkip: 'wird übersprungen',
		unmatched: '{name} (nicht zugeordnet)',
		splitAria: 'Aufteilung',
		rejectedTitle:
			'{count, plural, one {{count, number, ::group-off} Zeile konnte nicht gelesen werden} other {{count, number, ::group-off} Zeilen konnten nicht gelesen werden}}',
		rejectedDetails: 'Details anzeigen',
		rejectedRow: 'Zeile {line}: {description} ({reason})',
	},
	result: {
		heading: 'Import abgeschlossen',
		warningTitle: 'Hinweis zur Benachrichtigung',
		warningFailed:
			'Der Import wurde gespeichert, aber die WG-Benachrichtigung konnte nicht an alle zugestellt werden.',
		warningUnknown:
			'Der Import wurde gespeichert, aber die Zustellung der WG-Benachrichtigung konnte nicht bestätigt werden.',
		rejectedTitle: 'Nicht übernommene Einträge',
		rejectedEntry: 'Eintrag {number}: {reason}',
		rejectedEntryWithRow: 'Eintrag {number} ({description}, {date}, {amount}): {reason}',
	},
	progress: {
		aria: 'Import läuft',
		pending: 'Import läuft…',
		failed: 'Import fehlgeschlagen',
		withErrors: 'Mit Fehlern',
		withoutErrors: 'Ohne Fehler',
		retry: 'Bitte erneut versuchen.',
		summary:
			'{inserted} importiert · {skipped} übersprungen · {errors, plural, one {{errors, number, ::group-off} Fehler} other {{errors, number, ::group-off} Fehler}}',
	},
	leave: {
		title: 'Import-Eingaben verwerfen?',
		description:
			'Die bisher eingegebenen Daten und Zuordnungen gehen verloren. Es werden keine neuen Ausgaben importiert.',
		keep: 'Weiterbearbeiten',
		discard: 'Verwerfen',
	},
	history: {
		title: 'Frühere Importe',
		loadFailed: 'Frühere Importe konnten nicht geladen werden.',
		splitwise: 'Splitwise',
		splid: 'Splid',
		screenshot: 'Screenshot',
		other: 'Import',
		description: '{source} vom {date}',
		entry:
			'{description}: {count, plural, one {{count, number, ::group-off} Ausgabe} other {{count, number, ::group-off} Ausgaben}}',
		entryBy:
			'{description}: {count, plural, one {{count, number, ::group-off} Ausgabe} other {{count, number, ::group-off} Ausgaben}}, von {author}',
	},
	undo: {
		button: 'Import rückgängig machen',
		confirm: 'Wirklich alle importierten Ausgaben entfernen',
		buttonAria: 'Import rückgängig machen: {description}',
		confirmAria: 'Wirklich alle importierten Ausgaben entfernen: {description}',
		cancel: 'Abbrechen',
		doneUnknown: 'Import rückgängig gemacht.',
		done: 'Import rückgängig gemacht: {count, plural, one {{count, number, ::group-off} Ausgabe} other {{count, number, ::group-off} Ausgaben}} entfernt.',
		errors: {
			settled:
				'Einige Anteile dieses Imports sind schon bezahlt. Entferne die Ausgaben einzeln, wenn sie falsch sind.',
			notOwner: 'Nur wer importiert hat oder ein Admin kann diesen Import rückgängig machen.',
			notFound: 'Dieser Import ist nicht mehr vorhanden.',
			fallback: 'Der Import konnte nicht rückgängig gemacht werden.',
		},
	},
	errors: {
		failedPreview: 'Vorschau fehlgeschlagen',
		failedImport: 'Import fehlgeschlagen',
		rateLimited: 'Zu viele Importversuche. Warte kurz und versuche es erneut.',
		retryLater: 'Der Import konnte gerade nicht verarbeitet werden. Versuche es gleich erneut.',
		sessionExpired: 'Öffne die WG erneut, damit deine Mitgliedschaft geladen wird.',
		wgUnavailable: 'Die WG wurde nicht gefunden. Öffne den aktuellen WG-Link erneut.',
		invalidShareCode: 'Der WG-Link ist ungültig. Öffne die WG erneut.',
		authInvalidated: 'Deine WG-Zuordnung fehlt. Tritt der WG erneut bei.',
		memberDeactivated: 'Deine Mitgliedschaft ist nicht mehr aktiv. Tritt der WG erneut bei.',
		memberNotInWg: 'Mindestens eine Zuordnung gehört nicht mehr zu dieser WG. Prüfe die Zuordnung.',
		mappingIncomplete: 'Bitte ordne alle Namen einem WG-Mitglied zu.',
		payloadChanged: 'Die Eingabe wurde nach der Vorschau geändert. Erstelle die Vorschau neu.',
		payloadTooLarge:
			'Die Datei ist zu groß. Wähle eine kleinere Datei (CSV bis 5 MB, Bild bis 10 MB).',
		tooManyRows:
			'Die Datei hat zu viele Zeilen (max. 2.000). Teile den Export in mehrere Dateien auf.',
		unsupportedCurrency:
			'Diese Datei enthält keine unterstützte Währung. Verwende einen Export in Euro (EUR).',
		emptyPayload: 'Keine Ausgaben gefunden. Prüfe die Datei und versuche es erneut.',
		rowsUnreadable:
			'Keine Zeile der Datei konnte gelesen werden. Prüfe Datum, Betrag und zahlende Person in der Datei.',
		invalidSkipIndexes: 'Die Auswahl ist veraltet. Öffne die Vorschau erneut.',
		previewHashRequired: 'Die Vorschau fehlt. Erstelle sie erneut.',
		invalidBody:
			'Die Importdaten konnten nicht gelesen werden. Prüfe den Export und versuche es erneut.',
		payerUnmapped: 'Die zahlende Person konnte nicht zugeordnet werden. Prüfe die Zuordnung.',
		noValidSplits: 'Keine gültige Aufteilung gefunden. Prüfe die Anteile.',
		splitSumMismatch: 'Die Anteile ergeben nicht den Gesamtbetrag. Prüfe die Datei.',
		paidByMustIncludeCaller:
			'Du kannst nur Ausgaben importieren, die du bezahlt hast oder an denen du beteiligt bist. Komplette WG-Historien importiert der Admin.',
		insertFailed: 'Dieser Eintrag konnte nicht gespeichert werden. Versuche es erneut.',
		importInsertFailed:
			'Der Import konnte gerade nicht gespeichert werden. Versuche es gleich erneut.',
		fallback: 'Der Import konnte nicht abgeschlossen werden. Versuche es erneut.',
	},
	recovery: {
		mapping: 'Zuordnung prüfen',
		preview: 'Vorschau öffnen',
		input: 'Eingabe korrigieren',
		retry: 'Erneut versuchen',
	},
	rejected: {
		dateInvalid: 'Datum nicht lesbar',
		amountInvalid: 'Betrag nicht lesbar',
		noParticipants: 'Keine beteiligte Person',
		payerMissing: 'Zahlende Person fehlt',
		multiplePayers: 'Mehrere zahlende Personen – bitte von Hand erfassen',
		currencyUnsupported: 'Fremdwährung – importiert wird nur EUR',
		fallback: 'Zeile nicht importierbar',
	},
	warnings: {
		quoted: '„{name}“',
		list: '{head}, {tail}',
		unknownColumns:
			'{count, plural, one {Spalte {columns} wurde nicht erkannt und ignoriert.} other {Spalten {columns} wurden nicht erkannt und ignoriert.}}',
		splitsDrift:
			'Die Aufteilung wich minimal vom Gesamtbetrag ab und wurde automatisch angeglichen.',
		splitsDiscarded:
			'Die eigene Aufteilung wich zu stark vom Gesamtbetrag ab und wurde verworfen — stattdessen gleichmäßig aufgeteilt.',
		ocr: 'Aus dem Bild erkannt: Prüfe Datum, Betrag und zahlende Person. Die Ausgabe wird nur der zahlenden Person zugeordnet, es entsteht keine Schuld.',
		fallback: 'Bitte prüfe diese Zeile.',
	},
} as const;
