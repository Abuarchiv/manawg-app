import {
	isAuthInvalidated,
	isInvalidShareCode,
	isNetworkError,
	isRetryableServerError,
} from '@/core/errors/generic-error-codes';

export function expenseSaveErrorMessage(error: string): string {
	if (isNetworkError(error)) {
		return 'Ausgabe konnte nicht gespeichert werden: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (isRetryableServerError(error)) {
		return 'Ausgabe konnte nicht gespeichert werden: Versuche es gleich erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Ausgabe konnte nicht gespeichert werden: Öffne die WG über den aktuellen Link erneut.';
	}
	if (isInvalidShareCode(error)) {
		return 'Ausgabe konnte nicht gespeichert werden: Der WG-Code ist ungültig.';
	}
	if (isAuthInvalidated(error)) {
		return 'Ausgabe konnte nicht gespeichert werden: Tritt der WG erneut bei.';
	}
	if (error === 'amount_invalid') {
		return 'Ausgabe konnte nicht gespeichert werden: Der Betrag ist ungültig.';
	}
	if (error === 'description_invalid') {
		return 'Ausgabe konnte nicht gespeichert werden: Die Beschreibung muss 1 bis 160 Zeichen haben.';
	}
	if (error === 'currency_invalid') {
		return 'Ausgabe konnte nicht gespeichert werden: Die Währung ist ungültig.';
	}
	if (error === 'image_invalid') {
		return 'Ausgabe konnte nicht gespeichert werden: Der Anhang ist ungültig.';
	}
	if (error === 'image_removed') {
		return 'Ausgabe konnte nicht gespeichert werden: Der Anhang wurde entfernt. Lade ihn erneut hoch.';
	}
	if (error === 'expected_updated_at_invalid') {
		return 'Ausgabe konnte nicht gespeichert werden: Lade die Liste neu und versuche es erneut.';
	}
	if (error === 'occurred_at_invalid') {
		return 'Ausgabe konnte nicht gespeichert werden: Prüfe das Ausgabedatum.';
	}
	if (error === 'splits_invalid') {
		return 'Beträge stimmen nicht überein — Summe muss exakt dem Gesamtbetrag entsprechen.';
	}
	if (error === 'splits_sum_mismatch') {
		return 'Beträge stimmen nicht überein — Summe muss exakt dem Gesamtbetrag entsprechen.';
	}
	if (error === 'splits_duplicate_debtor') {
		return 'Aufteilung enthält eine Person doppelt — jede Mitbewohner:in darf nur einmal vorkommen.';
	}
	if (error === 'paid_by_must_include_caller') {
		return 'Wenn du für jemand anderen buchst, muss dein eigener Anteil größer als 0 sein.';
	}
	if (error === 'member_not_in_wg') {
		return 'Ausgabe konnte nicht gespeichert werden: Mindestens ein Mitglied ist nicht mehr in dieser WG.';
	}
	if (error === 'insert_failed') {
		return 'Ausgabe konnte nicht gespeichert werden: Prüfe die Ausgabenliste und versuche es erneut.';
	}
	if (error === 'split_insert_failed') {
		return 'Ausgabe konnte nicht vollständig gespeichert werden: Lade die Ausgaben neu und prüfe die Aufteilung.';
	}
	if (error === 'fetch_failed') {
		return 'Ausgabe wurde möglicherweise gespeichert: Lade die Ausgaben neu und prüfe den Eintrag.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return 'Ausgabe konnte nicht gespeichert werden: Die Anfrage war ungültig.';
	}
	return 'Ausgabe konnte nicht gespeichert werden.';
}

export function expenseActionErrorMessage(error: string): string {
	if (isNetworkError(error)) {
		return 'Ausgabenaktion fehlgeschlagen: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (isRetryableServerError(error)) {
		return 'Ausgabenaktion fehlgeschlagen: Versuche es gleich erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Ausgabenaktion fehlgeschlagen: Öffne die WG über den aktuellen Link erneut.';
	}
	if (isInvalidShareCode(error)) {
		return 'Ausgabenaktion fehlgeschlagen: Der WG-Code ist ungültig.';
	}
	if (isAuthInvalidated(error)) {
		return 'Ausgabenaktion fehlgeschlagen: Tritt der WG erneut bei.';
	}
	if (error === 'not_split_party') {
		return 'Nur Zahler:in oder beteiligte Person kann diese Zahlung als beglichen markieren.';
	}
	if (error === 'member_ids_invalid') {
		return 'Ausgleich konnte nicht gespeichert werden: Wähle zwei gültige Mitglieder.';
	}
	if (error === 'same_member') {
		return 'Ausgleich konnte nicht gespeichert werden: Zahler:in und Empfänger:in müssen verschieden sein.';
	}
	if (error === 'member_not_in_wg') {
		return 'Ausgleich konnte nicht gespeichert werden: Mindestens ein Mitglied ist nicht mehr in dieser WG.';
	}
	if (error === 'not_party_to_debt') {
		return 'Nur beteiligte Mitglieder können diesen Ausgleich markieren.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return 'Ausgabenaktion konnte nicht gespeichert werden: Die Anfrage war ungültig.';
	}
	if (error === 'id_invalid') {
		return 'Diese Ausgabenaktion konnte nicht eindeutig zugeordnet werden.';
	}
	if (error === 'image_removed') {
		return 'Der Anhang wurde entfernt. Lade ihn erneut hoch, bevor du die Ausgabe speicherst.';
	}
	if (error === 'settled_invalid') {
		return 'Diese Zahlung konnte nicht markiert werden: Lade die Ausgaben neu und versuche es erneut.';
	}
	if (error === 'split_already_offset') {
		return 'Dieser Anteil ist durch andere Ausgleiche ganz oder teilweise verrechnet. Den vollen Betrag als beglichen zu markieren würde den Saldo überschreiten; die Ausgabenliste wird aktualisiert.';
	}
	return 'Ausgabenaktion fehlgeschlagen.';
}

export function recurringTemplateSaveErrorMessage(error: string): string {
	if (isNetworkError(error)) {
		return 'Vorlage konnte nicht gespeichert werden: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (isRetryableServerError(error)) {
		return 'Vorlage konnte nicht gespeichert werden: Versuche es gleich erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Vorlage konnte nicht gespeichert werden: Öffne die WG über den aktuellen Link erneut.';
	}
	if (isInvalidShareCode(error)) {
		return 'Vorlage konnte nicht gespeichert werden: Der WG-Code ist ungültig.';
	}
	if (isAuthInvalidated(error)) {
		return 'Vorlage konnte nicht gespeichert werden: Tritt der WG erneut bei.';
	}
	if (error === 'paid_by_must_include_caller') {
		return 'Wenn du für jemand anderen buchst, muss dein eigener Anteil größer als 0 sein.';
	}
	if (error === 'member_not_in_wg') {
		return 'Mindestens ein Mitglied der Fixkosten-Vorlage ist nicht mehr in dieser WG.';
	}
	if (error === 'recurring_expense_not_found') {
		return 'Diese Fixkosten-Vorlage existiert nicht mehr. Lade die Ausgaben neu.';
	}
	if (error === 'insert_failed') {
		return 'Vorlage konnte nicht gespeichert werden: Prüfe die Liste und versuche es erneut.';
	}
	if (error === 'update_failed') {
		return 'Vorlage konnte nicht aktualisiert werden: Lade die Ausgaben neu und prüfe die Vorlage.';
	}
	if (error === 'amount_invalid') {
		return 'Vorlage konnte nicht gespeichert werden: Prüfe den Betrag.';
	}
	if (error === 'description_invalid') {
		return 'Vorlage konnte nicht gespeichert werden: Gib eine Beschreibung ein.';
	}
	if (error === 'interval_invalid') {
		return 'Vorlage konnte nicht gespeichert werden: Wähle ein gültiges Intervall.';
	}
	if (error === 'due_date_invalid') {
		return 'Vorlage konnte nicht gespeichert werden: Prüfe das nächste Fälligkeitsdatum.';
	}
	if (error === 'splits_invalid') {
		return 'Beträge stimmen nicht überein — Summe muss exakt dem Gesamtbetrag entsprechen.';
	}
	if (error === 'splits_sum_mismatch') {
		return 'Beträge stimmen nicht überein — Summe muss exakt dem Gesamtbetrag entsprechen.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return 'Vorlage konnte nicht gespeichert werden: Die Anfrage war ungültig.';
	}
	return 'Vorlage konnte nicht gespeichert werden.';
}

export function recurringTemplateDeleteErrorMessage(error: string): string {
	if (isNetworkError(error)) {
		return 'Vorlage konnte nicht gelöscht werden: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (isRetryableServerError(error)) {
		return 'Vorlage konnte nicht gelöscht werden: Versuche es gleich erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Vorlage konnte nicht gelöscht werden: Öffne die WG über den aktuellen Link erneut.';
	}
	if (isInvalidShareCode(error)) {
		return 'Vorlage konnte nicht gelöscht werden: Der WG-Code ist ungültig.';
	}
	if (isAuthInvalidated(error)) {
		return 'Vorlage konnte nicht gelöscht werden: Tritt der WG erneut bei.';
	}
	if (error === 'id_invalid') {
		return 'Vorlage konnte nicht gelöscht werden: Diese Vorlage konnte nicht eindeutig zugeordnet werden.';
	}
	if (error === 'recurring_expense_not_found') {
		return 'Diese Fixkosten-Vorlage existiert nicht mehr. Lade die Ausgaben neu.';
	}
	if (error === 'delete_failed') {
		return 'Vorlage konnte nicht gelöscht werden: Lade die Ausgaben neu und prüfe, ob sie noch existiert.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return 'Vorlage konnte nicht gelöscht werden: Die Anfrage war ungültig.';
	}
	return 'Vorlage konnte nicht gelöscht werden.';
}

export function recurringAdvanceWarningMessage(status: number, error: string): string {
	if (status === 409 && error === 'recurring_expense_already_advanced') {
		return 'Ausgabe wurde erstellt, aber die Vorlage war schon weitergeschoben. Prüfe kurz, ob diese Fixkosten doppelt übernommen wurden.';
	}
	if (error === 'update_failed') {
		return 'Ausgabe wurde erstellt, aber die Fixkosten-Vorlage konnte nicht weitergeschoben werden. Lade die Ausgaben neu und prüfe die nächste Fälligkeit.';
	}
	return 'Ausgabe wurde erstellt, aber die Fixkosten-Vorlage konnte nicht weitergeschoben werden. Prüfe sie später noch einmal.';
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
			return 'Beträge stimmen nicht überein — Summe muss exakt dem Gesamtbetrag entsprechen.';
		case 'no_members':
			return 'Keine Mitglieder vorhanden.';
	}
}
