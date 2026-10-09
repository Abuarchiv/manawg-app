import { isRateLimited } from '@/core/http/error-codes';

/**
 * German copy and the next step to offer for each error the import routes
 * (`imports/preview`, `imports/commit`) can return. Kept apart from the wizard
 * so the mapping stays reviewable and testable without rendering it.
 */

export type ImportOperation = 'preview' | 'commit';
export type RecoveryAction =
	| { kind: 'retry_preview'; label: string }
	| { kind: 'retry_commit'; label: string }
	| { kind: 'input'; label: string }
	| { kind: 'mapping'; label: string }
	| { kind: 'preview'; label: string };

const IMPORT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
	Netzwerkfehler: 'Prüfe deine Verbindung und versuche es erneut.',
	'Failed to fetch': 'Prüfe deine Verbindung und versuche es erneut.',
	too_many_requests: 'Zu viele Importversuche. Warte kurz und versuche es erneut.',
	unexpected_error: 'Der Import konnte gerade nicht verarbeitet werden. Versuche es gleich erneut.',
	server_error: 'Der Import konnte gerade nicht verarbeitet werden. Versuche es gleich erneut.',
	db_error: 'Der Import konnte gerade nicht verarbeitet werden. Versuche es gleich erneut.',
	wg_not_found: 'Die WG wurde nicht gefunden. Öffne den aktuellen WG-Link erneut.',
	invalid_share_code: 'Der WG-Link ist ungültig. Öffne die WG erneut.',
	auth_required: 'Öffne die WG erneut, damit deine Mitgliedschaft geladen wird.',
	not_a_member: 'Deine WG-Zuordnung fehlt. Tritt der WG erneut bei.',
	member_id_required: 'Deine WG-Zuordnung fehlt. Tritt der WG erneut bei.',
	member_id_invalid: 'Deine WG-Zuordnung ist ungültig. Tritt der WG erneut bei.',
	member_deactivated: 'Deine Mitgliedschaft ist nicht mehr aktiv. Tritt der WG erneut bei.',
	member_not_in_wg:
		'Mindestens eine Zuordnung gehört nicht mehr zu dieser WG. Prüfe die Zuordnung.',
	mapping_incomplete: 'Bitte ordne alle Namen einem WG-Mitglied zu.',
	payload_changed: 'Die Eingabe wurde nach der Vorschau geändert. Erstelle die Vorschau neu.',
	payload_too_large:
		'Die Datei ist zu groß. Wähle eine kleinere Datei (CSV bis 5 MB, Bild bis 10 MB).',
	too_many_rows:
		'Die Datei hat zu viele Zeilen (max. 2.000). Teile den Export in mehrere Dateien auf.',
	unsupported_currency:
		'Diese Datei enthält keine unterstützte Währung. Verwende einen Export in Euro (EUR).',
	empty_payload: 'Keine Ausgaben gefunden. Prüfe die Datei und versuche es erneut.',
	rows_unreadable:
		'Keine Zeile der Datei konnte gelesen werden. Prüfe Datum, Betrag und zahlende Person in der Datei.',
	invalid_skip_indexes: 'Die Auswahl ist veraltet. Öffne die Vorschau erneut.',
	preview_hash_required: 'Die Vorschau fehlt. Erstelle sie erneut.',
	invalid_body:
		'Die Importdaten konnten nicht gelesen werden. Prüfe den Export und versuche es erneut.',
	invalid_json:
		'Die Importdaten konnten nicht gelesen werden. Prüfe den Export und versuche es erneut.',
	payer_unmapped: 'Die zahlende Person konnte nicht zugeordnet werden. Prüfe die Zuordnung.',
	no_valid_splits: 'Keine gültige Aufteilung gefunden. Prüfe die Anteile.',
	split_sum_mismatch: 'Die Anteile ergeben nicht den Gesamtbetrag. Prüfe die Datei.',
	paid_by_must_include_caller:
		'Du kannst nur Ausgaben importieren, die du bezahlt hast oder an denen du beteiligt bist. Komplette WG-Historien importiert der Admin.',
	insert_failed: 'Dieser Eintrag konnte nicht gespeichert werden. Versuche es erneut.',
	import_insert_failed:
		'Der Import konnte gerade nicht gespeichert werden. Versuche es gleich erneut.',
};

export function importActionErrorMessage(error: string): string {
	return (
		// The middleware answers 429 with `rate_limited`, the routes with `too_many_requests`.
		IMPORT_ERROR_MESSAGES[isRateLimited(error) ? 'too_many_requests' : error] ??
		'Der Import konnte nicht abgeschlossen werden. Versuche es erneut.'
	);
}

export function recoveryActionFor(
	error: string,
	operation: ImportOperation,
): RecoveryAction | null {
	if (
		error === 'mapping_incomplete' ||
		error === 'member_not_in_wg' ||
		error === 'payer_unmapped'
	) {
		return { kind: 'mapping', label: 'Zuordnung prüfen' };
	}
	if (error === 'invalid_skip_indexes' || error === 'preview_hash_required') {
		return { kind: 'preview', label: 'Vorschau öffnen' };
	}
	if (
		error === 'payload_changed' ||
		error === 'payload_too_large' ||
		error === 'too_many_rows' ||
		error === 'unsupported_currency' ||
		error === 'empty_payload' ||
		error === 'rows_unreadable' ||
		error === 'invalid_body' ||
		error === 'invalid_json' ||
		error === 'no_valid_splits' ||
		error === 'split_sum_mismatch' ||
		error === 'paid_by_must_include_caller'
	) {
		return { kind: 'input', label: 'Eingabe korrigieren' };
	}
	if (
		error === 'Netzwerkfehler' ||
		error === 'Failed to fetch' ||
		isRateLimited(error) ||
		error === 'unexpected_error' ||
		error === 'server_error' ||
		error === 'db_error'
	) {
		return {
			kind: operation === 'preview' ? 'retry_preview' : 'retry_commit',
			label: 'Erneut versuchen',
		};
	}
	return null;
}
