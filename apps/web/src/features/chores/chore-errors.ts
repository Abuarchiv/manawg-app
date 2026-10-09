import {
	READ_ONLY_MESSAGE,
	SESSION_EXPIRED_MESSAGE,
	isNetworkError,
	isReadOnlyMode,
	isSessionExpired,
	mutationErrorMessage,
} from '@/core/http/error-codes';

const ABSENCE_SUBJECT = 'Abwesenheit konnte nicht gespeichert werden';
const ABSENCE_ERRORS: Record<string, string> = {
	date_range_invalid: `${ABSENCE_SUBJECT}: Das Enddatum liegt vor dem Startdatum.`,
	absence_overlaps_existing: `${ABSENCE_SUBJECT}: Für diese Person gibt es im Zeitraum schon eine Abwesenheit.`,
	not_owner: `${ABSENCE_SUBJECT}: Nur die Person selbst oder ein WG-Admin darf das eintragen.`,
	reason_invalid: `${ABSENCE_SUBJECT}: Der Grund darf höchstens 120 Zeichen haben.`,
	member_not_in_wg: `${ABSENCE_SUBJECT}: Dieses Mitglied ist nicht mehr in dieser WG.`,
	insert_failed: `${ABSENCE_SUBJECT}: Prüfe den Putzplan und versuche es erneut.`,
	invalid_json: `${ABSENCE_SUBJECT}: Die Anfrage war ungültig.`,
	invalid_body: `${ABSENCE_SUBJECT}: Die Anfrage war ungültig.`,
};

export function absenceSaveErrorMessage(error: string): string {
	return mutationErrorMessage(ABSENCE_SUBJECT, error, ABSENCE_ERRORS, `${ABSENCE_SUBJECT}.`);
}

const CHORE_SUBJECT = 'Putzaufgabe konnte nicht gespeichert werden';
const CHORE_CREATE_ERRORS: Record<string, string> = {
	member_not_in_wg: `${CHORE_SUBJECT}: Dieses Mitglied ist nicht mehr in dieser WG.`,
	interval_invalid: `${CHORE_SUBJECT}: Das Intervall muss zwischen 1 und 365 Tagen oder 1 und 60 Monaten liegen.`,
	title_invalid: `${CHORE_SUBJECT}: Der Titel muss 1 bis 120 Zeichen haben.`,
	due_date_invalid: `${CHORE_SUBJECT}: Das Fälligkeitsdatum ist ungültig.`,
	insert_failed: `${CHORE_SUBJECT}: Prüfe den Putzplan und versuche es erneut.`,
	invalid_body: `${CHORE_SUBJECT}: Die Anfrage war ungültig.`,
	invalid_json: `${CHORE_SUBJECT}: Die Anfrage war ungültig.`,
};

export function choreCreateErrorMessage(error: string): string {
	return mutationErrorMessage(
		CHORE_SUBJECT,
		error,
		CHORE_CREATE_ERRORS,
		'Hinzufügen fehlgeschlagen. Versuche es gleich erneut.',
	);
}

/** Shared error texts for the swap and take-over actions: `prefix` is the sentence without a period. */
export function choreActionErrorMessage(
	prefix: string,
	result: { error: string; status: number },
): string {
	if (isReadOnlyMode(result.error)) return `${prefix}: ${READ_ONLY_MESSAGE}`;
	if (isSessionExpired(result.error)) return `${prefix}: ${SESSION_EXPIRED_MESSAGE}`;
	if (result.error === 'unexpected_error' || result.error === 'server_error') {
		return `${prefix}: Versuche es gleich erneut.`;
	}
	if (isNetworkError(result.error, result.status)) {
		return `${prefix}: Prüfe deine Verbindung und versuche es erneut.`;
	}
	return `${prefix}.`;
}

const EDIT_SUBJECT = 'Aufgabe konnte nicht bearbeitet werden';
const CHORE_EDIT_ERRORS: Record<string, string> = {
	title_invalid: `${EDIT_SUBJECT}: Der Titel muss 1 bis 120 Zeichen haben.`,
	interval_invalid: `${EDIT_SUBJECT}: Das Intervall muss zwischen 1 und 365 Tagen oder 1 und 60 Monaten liegen.`,
	due_date_invalid: `${EDIT_SUBJECT}: Das Fälligkeitsdatum ist ungültig.`,
	member_not_in_wg: `${EDIT_SUBJECT}: Dieses Mitglied ist nicht mehr in dieser WG.`,
	chore_changed:
		'Die Aufgabe wurde inzwischen geändert. Der Plan wird neu geladen, bitte versuche es erneut.',
	invalid_body: `${EDIT_SUBJECT}: Die Anfrage war ungültig.`,
	invalid_json: `${EDIT_SUBJECT}: Die Anfrage war ungültig.`,
};

export function choreEditErrorMessage(error: string): string {
	return mutationErrorMessage(EDIT_SUBJECT, error, CHORE_EDIT_ERRORS, `${EDIT_SUBJECT}.`);
}
