import {
	isAuthInvalidated,
	isInvalidShareCode,
	isNetworkError,
	isRetryableServerError,
} from '@/core/errors/generic-error-codes';

export function announcementCreateErrorMessage(error: string): string {
	if (isNetworkError(error)) {
		return 'Beitrag konnte nicht gespeichert werden: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (isRetryableServerError(error)) {
		return 'Beitrag konnte nicht gespeichert werden: Versuche es gleich erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Beitrag konnte nicht gespeichert werden: Öffne die WG über den aktuellen Link erneut.';
	}
	if (isInvalidShareCode(error)) {
		return 'Beitrag konnte nicht gespeichert werden: Der WG-Code ist ungültig.';
	}
	if (isAuthInvalidated(error)) {
		return 'Beitrag konnte nicht gespeichert werden: Tritt der WG erneut bei.';
	}
	if (error === 'content_invalid') {
		return 'Beitrag konnte nicht gespeichert werden: Der Text muss 1 bis 2000 Zeichen haben.';
	}
	if (error === 'kind_invalid') {
		return 'Beitrag konnte nicht gespeichert werden: Die Beitragsart ist ungültig.';
	}
	if (error === 'image_invalid') {
		return 'Beitrag konnte nicht gespeichert werden: Der Anhang ist ungültig.';
	}
	if (error === 'image_removed') {
		return 'Beitrag konnte nicht gespeichert werden: Der Anhang wurde entfernt. Lade das Bild erneut hoch.';
	}
	if (error === 'source_path_invalid') {
		return 'Beitrag konnte nicht gespeichert werden: Der Quelllink ist ungültig.';
	}
	if (error === 'insert_failed') {
		return 'Beitrag konnte nicht gespeichert werden: Prüfe die Pinnwand und versuche es erneut.';
	}
	if (error === 'invalid_json') {
		return 'Beitrag konnte nicht gespeichert werden: Die Anfrage war ungültig.';
	}
	return 'Beitrag konnte nicht gespeichert werden.';
}

export function commentActionErrorMessage(error: string): string {
	if (isNetworkError(error)) {
		return 'Kommentar konnte nicht gespeichert werden: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Kommentar konnte nicht gespeichert werden: Öffne die WG über den aktuellen Link erneut.';
	}
	if (isInvalidShareCode(error)) {
		return 'Kommentar konnte nicht gespeichert werden: Der WG-Code ist ungültig.';
	}
	if (isAuthInvalidated(error)) {
		return 'Kommentar konnte nicht gespeichert werden: Tritt der WG erneut bei.';
	}
	if (error === 'comment_invalid') {
		return 'Kommentar konnte nicht gespeichert werden: Der Text muss 1 bis 600 Zeichen haben.';
	}
	if (error === 'not_owner') {
		return 'Nur der/die Autor:in kann diesen Kommentar ändern.';
	}
	if (isRetryableServerError(error)) {
		return 'Kommentar-Aktion fehlgeschlagen: Versuche es gleich erneut.';
	}
	if (error === 'insert_failed') {
		return 'Kommentar konnte nicht gespeichert werden: Lade den Beitrag neu und versuche es erneut.';
	}
	if (error === 'delete_failed') {
		return 'Kommentar konnte nicht gelöscht werden: Lade den Beitrag neu und prüfe, ob er noch existiert.';
	}
	if (error === 'comment_not_found') {
		return 'Kommentar existiert nicht mehr. Lade den Beitrag neu, um den aktuellen Stand zu sehen.';
	}
	if (error === 'invalid_json') {
		return 'Kommentar konnte nicht gespeichert werden: Die Anfrage war ungültig.';
	}
	return 'Kommentar-Aktion fehlgeschlagen.';
}

export function announcementActionErrorMessage(error: string): string {
	if (isNetworkError(error)) {
		return 'Pinnwand-Aktion fehlgeschlagen: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Pinnwand-Aktion fehlgeschlagen: Öffne die WG über den aktuellen Link erneut.';
	}
	if (isInvalidShareCode(error)) {
		return 'Pinnwand-Aktion fehlgeschlagen: Der WG-Code ist ungültig.';
	}
	if (isAuthInvalidated(error)) {
		return 'Pinnwand-Aktion fehlgeschlagen: Tritt der WG erneut bei.';
	}
	if (isRetryableServerError(error)) {
		return 'Pinnwand-Aktion fehlgeschlagen: Versuche es gleich erneut.';
	}
	if (error === 'reaction_invalid') {
		return 'Reaktion konnte nicht gespeichert werden: Die Reaktion ist ungültig.';
	}
	if (error === 'insert_failed') {
		return 'Reaktion konnte nicht gespeichert werden: Lade den Beitrag neu und versuche es erneut.';
	}
	if (error === 'delete_failed') {
		return 'Reaktion konnte nicht entfernt werden: Lade den Beitrag neu und prüfe den aktuellen Stand.';
	}
	if (error === 'reaction_not_found') {
		return 'Reaktion existiert nicht mehr. Lade den Beitrag neu, um den aktuellen Stand zu sehen.';
	}
	if (error === 'status_invalid') {
		return 'Pinnwand-Status konnte nicht gespeichert werden: Der Status ist ungültig.';
	}
	if (error === 'pinned_invalid') {
		return 'Fixierung konnte nicht gespeichert werden: Der Wert ist ungültig.';
	}
	if (error === 'kind_invalid') {
		return 'Pinnwand-Aktion fehlgeschlagen: Die Beitragsart ist ungültig.';
	}
	if (error === 'status_change_not_allowed') {
		return 'Nur Autor:in oder übernehmende Person kann diesen Beitrag als geklärt markieren.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return 'Pinnwand-Aktion konnte nicht gespeichert werden: Die Anfrage war ungültig.';
	}
	return 'Pinnwand-Aktion fehlgeschlagen.';
}
