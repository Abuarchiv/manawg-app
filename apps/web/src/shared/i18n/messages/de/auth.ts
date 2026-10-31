export default {
	tabs: { code: 'Code per E-Mail', password: 'Passwort' },
	sections: {
		signUp: 'Mit E-Mail registrieren',
		code: 'Mit E-Mail-Code anmelden',
		password: 'Mit Passwort anmelden',
	},
	fields: {
		email: 'E-Mail-Adresse',
		password: 'Passwort',
		name: 'Dein Name',
		passwordRepeat: 'Passwort wiederholen',
		code: '{length, number}-stelliger Code',
		newPassword: 'Neues Passwort',
		confirmPassword: 'Passwort bestätigen',
	},
	failure: {
		credentials:
			'E-Mail oder Passwort stimmt nicht. Prüfe deine Eingabe oder setze dein Passwort zurück.',
		unconfirmed:
			'Deine E-Mail-Adresse ist noch nicht bestätigt. Öffne den Link in der Bestätigungsmail und melde dich danach an.',
		rateLimit: 'Zu viele Versuche. Warte einige Minuten und versuche es dann erneut.',
		network: 'Keine Verbindung zum Anmeldedienst. Prüfe deine Verbindung und versuche es erneut.',
		weakPassword:
			'Wähle ein längeres oder anderes sicheres Passwort, das du nicht schon an anderer Stelle verwendest.',
		signIn: 'Die Anmeldung konnte gerade nicht abgeschlossen werden. Bitte versuche es erneut.',
		signUp: 'Die Registrierung konnte gerade nicht abgeschlossen werden. Bitte versuche es erneut.',
		mail: 'Die E-Mail konnte gerade nicht gesendet werden. Bitte versuche es erneut.',
	},
	validEmail: 'Bitte gib eine gültige E-Mail-Adresse ein.',
	mismatch: 'Die Passwörter stimmen nicht überein.',
	otherEmail: 'Andere E-Mail-Adresse verwenden',
	resendIn: 'Erneut senden in {seconds, number} s',
	signIn: {
		invalid: 'Bitte gib eine gültige E-Mail-Adresse und dein Passwort ein.',
		incomplete:
			'Die Anmeldung ist noch nicht abgeschlossen. Prüfe deine E-Mail und versuche es erneut.',
		confirmationResent:
			'Wir haben die Bestätigungs-Mail erneut gesendet, sofern diese Adresse auf eine Bestätigung wartet. Schau auch im Spam-Ordner nach.',
		resetSent:
			'Wenn zu dieser E-Mail-Adresse ein Konto gehört, erhältst du gleich einen Link zum Zurücksetzen des Passworts.',
		forgot: 'Passwort vergessen?',
		requestingLink: 'Link wird angefordert…',
		resend: 'Bestätigungs-Mail erneut senden',
		submit: 'Anmelden',
	},
	code: {
		invalid: 'Bitte gib den {length, number}-stelligen Code aus der E-Mail ein.',
		wrong: 'Code falsch oder abgelaufen. Fordere einen neuen an.',
		rateLimit: 'Zu viele Versuche. Warte kurz.',
		send: 'Code per E-Mail senden',
		sent: 'Wir haben einen Code an {email} geschickt, sofern dort ein Konto besteht. Schau auch im Spam-Ordner nach. Noch kein Konto? {create}',
		createLink: 'Jetzt erstellen.',
		hint: 'Der Code gilt nur kurz.',
		resent: 'Der Code wurde erneut gesendet.',
		resendIn: 'Code erneut senden in {seconds, number} s',
		resend: 'Code erneut senden',
		submit: 'Anmelden',
	},
	signUp: {
		name: 'Bitte gib deinen Namen ein.',
		tooShort: 'Dein Passwort braucht mindestens {min, number} Zeichen.',
		inboxTitle: 'Prüfe dein Postfach',
		inboxBody:
			'Wir haben einen Bestätigungslink an {email} geschickt, sofern für diese Adresse noch kein Konto besteht. Öffne den Link, danach geht es hier weiter. Schau auch im Spam-Ordner nach. Hast du schon ein Konto, melde dich stattdessen an.',
		resent: 'Die E-Mail wurde erneut gesendet.',
		resend: 'E-Mail erneut senden',
		hint: 'Mindestens {min, number} Zeichen.',
		submit: 'Konto erstellen',
	},
	reset: {
		tooShort: 'Das Passwort muss mindestens {min, number} Zeichen lang sein.',
		saved: 'Passwort gespeichert.',
		same: 'Das neue Passwort muss sich vom bisherigen unterscheiden.',
		failed: 'Das Passwort konnte gerade nicht geändert werden. Bitte fordere einen neuen Link an.',
		invalidLink: 'Dieser Link ist ungültig oder abgelaufen. Bitte fordere einen neuen Link an.',
		back: 'Zurück',
		hint: 'Mindestens {min, number} Zeichen.',
		saving: 'Passwort wird gespeichert…',
		save: 'Passwort speichern',
		sendLink: 'Link senden',
	},
	social: {
		signIn: 'Mit {provider} anmelden',
		signUp: 'Mit {provider} registrieren',
		link: '{provider} verknüpfen',
		pendingSignIn: 'Anmeldung bei {provider} wird gestartet…',
		pendingLink: 'Verknüpfung mit {provider} wird gestartet…',
		linkFailed: 'Das Konto konnte nicht verknüpft werden. Bitte versuche es später erneut.',
		unreachable:
			'Die Anmeldung ist gerade nicht erreichbar. Bitte prüfe deine Verbindung und versuche es erneut.',
	},
	prompt: { noAccount: 'Noch kein Konto?', create: 'Konto erstellen' },
} as const;
