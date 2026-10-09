import { mutationErrorMessage } from '@/core/http/error-codes';

/** Shared with abo-errors.ts so both forms say the same thing. */
const SPLIT_SUM_MISMATCH =
	'Beträge stimmen nicht überein — Summe muss exakt dem Gesamtbetrag entsprechen.';
const PAID_BY_MUST_INCLUDE_CALLER =
	'Wenn du für jemand anderen buchst, muss dein eigener Anteil größer als 0 sein.';

const NOT_TEMPLATE_OWNER =
	'Nur wer die Fixkosten angelegt hat oder Admin der WG ist, kann sie ändern oder löschen.';

const SAVE_SUBJECT = 'Ausgabe konnte nicht gespeichert werden';
const SAVE_ERRORS: Record<string, string> = {
	amount_invalid: `${SAVE_SUBJECT}: Der Betrag ist ungültig.`,
	// 200 = DESCRIPTION_MAX in the expense schema; deliberately not imported so the unit-test loader can load this file alone.
	description_invalid: `${SAVE_SUBJECT}: Die Beschreibung muss 1 bis 200 Zeichen haben.`,
	currency_invalid: `${SAVE_SUBJECT}: Die Währung ist ungültig.`,
	image_invalid: `${SAVE_SUBJECT}: Der Anhang ist ungültig.`,
	image_removed: `${SAVE_SUBJECT}: Der Anhang wurde entfernt. Lade ihn erneut hoch.`,
	expected_updated_at_invalid: `${SAVE_SUBJECT}: Lade die Liste neu und versuche es erneut.`,
	occurred_at_invalid: `${SAVE_SUBJECT}: Prüfe das Ausgabedatum.`,
	splits_invalid: SPLIT_SUM_MISMATCH,
	splits_sum_mismatch: SPLIT_SUM_MISMATCH,
	splits_duplicate_debtor:
		'Aufteilung enthält eine Person doppelt — jede Person darf nur einmal vorkommen.',
	paid_by_must_include_caller: PAID_BY_MUST_INCLUDE_CALLER,
	not_payer: 'Nur wer bezahlt hat, kann diese Ausgabe bearbeiten.',
	abo_paused: `${SAVE_SUBJECT}: Diese Fixkosten sind pausiert. Setze sie in den Fixkosten fort.`,
	recurring_expense_already_advanced:
		'Diese Fixkosten wurden für diese Fälligkeit schon übernommen. Lade die Ausgaben neu und prüfe die Liste.',
	recurring_expense_not_found:
		'Diese Fixkosten-Vorlage existiert nicht mehr. Lade die Ausgaben neu.',
	member_not_in_wg: `${SAVE_SUBJECT}: Mindestens ein Mitglied ist nicht mehr in dieser WG.`,
	insert_failed: `${SAVE_SUBJECT}: Prüfe die Ausgabenliste und versuche es erneut.`,
	split_insert_failed:
		'Ausgabe konnte nicht vollständig gespeichert werden: Lade die Ausgaben neu und prüfe die Aufteilung.',
	fetch_failed:
		'Ausgabe wurde möglicherweise gespeichert: Lade die Ausgaben neu und prüfe den Eintrag.',
	invalid_body: `${SAVE_SUBJECT}: Die Anfrage war ungültig.`,
	invalid_json: `${SAVE_SUBJECT}: Die Anfrage war ungültig.`,
};

export function expenseSaveErrorMessage(error: string): string {
	return mutationErrorMessage(SAVE_SUBJECT, error, SAVE_ERRORS, `${SAVE_SUBJECT}.`);
}

const ACTION_SUBJECT = 'Aktion fehlgeschlagen';
const ACTION_ERRORS: Record<string, string> = {
	not_split_party:
		'Nur wer bezahlt hat oder beteiligt ist, kann diese Zahlung als beglichen markieren.',
	member_ids_invalid: 'Ausgleich konnte nicht gespeichert werden: Wähle zwei gültige Mitglieder.',
	same_member:
		'Ausgleich konnte nicht gespeichert werden: Zahlende und empfangende Person müssen verschieden sein.',
	member_not_in_wg:
		'Ausgleich konnte nicht gespeichert werden: Mindestens ein Mitglied ist nicht mehr in dieser WG.',
	not_party_to_debt: 'Nur beteiligte Mitglieder können diesen Ausgleich markieren.',
	invalid_body: 'Die Änderung konnte nicht gespeichert werden: Die Anfrage war ungültig.',
	invalid_json: 'Die Änderung konnte nicht gespeichert werden: Die Anfrage war ungültig.',
	id_invalid: 'Diese Aktion konnte nicht eindeutig zugeordnet werden.',
	image_removed:
		'Der Anhang wurde entfernt. Lade ihn erneut hoch, bevor du die Ausgabe speicherst.',
	settled_invalid:
		'Diese Zahlung konnte nicht markiert werden: Lade die Ausgaben neu und versuche es erneut.',
	split_already_offset:
		'Dieser Anteil ist durch andere Ausgleiche ganz oder teilweise verrechnet. Den vollen Betrag als beglichen zu markieren würde den Saldo überschreiten; die Ausgabenliste wird aktualisiert.',
};

export function expenseActionErrorMessage(error: string): string {
	return mutationErrorMessage(
		ACTION_SUBJECT,
		error,
		ACTION_ERRORS,
		'Die Aktion ist fehlgeschlagen. Versuche es gleich erneut.',
	);
}

const TEMPLATE_SAVE_SUBJECT = 'Vorlage konnte nicht gespeichert werden';
const TEMPLATE_SAVE_ERRORS: Record<string, string> = {
	paid_by_must_include_caller: PAID_BY_MUST_INCLUDE_CALLER,
	not_owner: NOT_TEMPLATE_OWNER,
	member_not_in_wg: 'Mindestens ein Mitglied der Fixkosten-Vorlage ist nicht mehr in dieser WG.',
	recurring_expense_not_found:
		'Diese Fixkosten-Vorlage existiert nicht mehr. Lade die Ausgaben neu.',
	insert_failed: `${TEMPLATE_SAVE_SUBJECT}: Prüfe die Liste und versuche es erneut.`,
	update_failed:
		'Vorlage konnte nicht aktualisiert werden: Lade die Ausgaben neu und prüfe die Vorlage.',
	amount_invalid: `${TEMPLATE_SAVE_SUBJECT}: Prüfe den Betrag.`,
	description_invalid: `${TEMPLATE_SAVE_SUBJECT}: Gib eine Beschreibung ein.`,
	interval_invalid: `${TEMPLATE_SAVE_SUBJECT}: Wähle ein gültiges Intervall.`,
	due_date_invalid: `${TEMPLATE_SAVE_SUBJECT}: Prüfe das nächste Fälligkeitsdatum.`,
	recurring_expense_changed: `${TEMPLATE_SAVE_SUBJECT}: Die Vorlage wurde gerade gebucht oder geändert. Lade die Ausgaben neu und bearbeite sie erneut.`,
	splits_invalid: SPLIT_SUM_MISMATCH,
	splits_sum_mismatch: SPLIT_SUM_MISMATCH,
	invalid_body: `${TEMPLATE_SAVE_SUBJECT}: Die Anfrage war ungültig.`,
	invalid_json: `${TEMPLATE_SAVE_SUBJECT}: Die Anfrage war ungültig.`,
};

export function recurringTemplateSaveErrorMessage(error: string): string {
	return mutationErrorMessage(
		TEMPLATE_SAVE_SUBJECT,
		error,
		TEMPLATE_SAVE_ERRORS,
		`${TEMPLATE_SAVE_SUBJECT}.`,
	);
}

const TEMPLATE_DELETE_SUBJECT = 'Vorlage konnte nicht gelöscht werden';
const TEMPLATE_DELETE_ERRORS: Record<string, string> = {
	not_owner: NOT_TEMPLATE_OWNER,
	id_invalid: `${TEMPLATE_DELETE_SUBJECT}: Diese Vorlage konnte nicht eindeutig zugeordnet werden.`,
	recurring_expense_not_found:
		'Diese Fixkosten-Vorlage existiert nicht mehr. Lade die Ausgaben neu.',
	delete_failed: `${TEMPLATE_DELETE_SUBJECT}: Lade die Ausgaben neu und prüfe, ob sie noch existiert.`,
	invalid_body: `${TEMPLATE_DELETE_SUBJECT}: Die Anfrage war ungültig.`,
	invalid_json: `${TEMPLATE_DELETE_SUBJECT}: Die Anfrage war ungültig.`,
};

export function recurringTemplateDeleteErrorMessage(error: string): string {
	return mutationErrorMessage(
		TEMPLATE_DELETE_SUBJECT,
		error,
		TEMPLATE_DELETE_ERRORS,
		`${TEMPLATE_DELETE_SUBJECT}.`,
	);
}

/**
 * Why a form's split rows cannot be submitted, in the wording the expense form
 * shows. Keyed by the reasons `buildSplitsFromForm` reports.
 */
export function splitInputErrorMessage(
	reason: 'invalid_share' | 'splits_empty' | 'splits_mismatch' | 'no_members',
): string {
	switch (reason) {
		case 'invalid_share':
			return 'Mindestens ein Anteil ist ungültig. Gib einen gültigen Betrag ein oder lasse das Feld leer.';
		case 'splits_empty':
			return 'Aufteilung leer — gib mindestens einen Betrag ein.';
		case 'splits_mismatch':
			return SPLIT_SUM_MISMATCH;
		case 'no_members':
			return 'Wähle mindestens eine beteiligte Person aus.';
	}
}

/** A 4xx other than 429 will not succeed on retry, so its idempotency key is dropped. */
export function isPermanentClientError(status: number): boolean {
	return status >= 400 && status < 500 && status !== 429;
}
