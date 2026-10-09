export const MISSING_PENDING_IMAGE_MESSAGE =
	'Bild konnte auf diesem Gerät nicht mehr gefunden werden. Entferne den Platzhalter und wähle es erneut aus.';

const GENERIC_SIGN_ERROR = 'Bild konnte nicht hochgeladen werden. Versuche es erneut.';

export function uploadSignErrorMessage(status: number, error: string): string {
	if (status === 404 || error === 'wg_not_found') {
		return 'Bild konnte nicht hochgeladen werden: Öffne die WG über den aktuellen Link erneut.';
	}
	if (error === 'invalid_share_code') {
		return 'Bild konnte nicht hochgeladen werden: Der WG-Code ist ungültig.';
	}
	if (
		status === 401 ||
		error === 'not_a_member' ||
		error === 'member_id_required' ||
		error === 'member_id_invalid'
	) {
		return 'Bild konnte nicht hochgeladen werden: Tritt der WG erneut bei.';
	}
	if (error === 'invalid_file') {
		return 'Bild konnte nicht hochgeladen werden: Datei oder Dateityp ist ungültig.';
	}
	if (error === 'invalid_mime_type') {
		return 'Bild konnte nicht hochgeladen werden: Bitte JPG, PNG oder WebP wählen.';
	}
	if (error === 'file_too_large') {
		return 'Bild konnte nicht hochgeladen werden: Das Bild ist zu groß.';
	}
	if (error === 'feature_disabled' || error === 'image_uploads_unavailable') {
		return 'Bild-Upload ist noch nicht konfiguriert.';
	}
	if (status === 429 || error === 'upload_sign_rate_limited') {
		return 'Zu viele Uploads. Versuche es gleich noch einmal.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return 'Bild konnte nicht hochgeladen werden: Die Anfrage war ungültig.';
	}
	return GENERIC_SIGN_ERROR;
}

/** Copy for a failed background upload of a pending image; null means retry silently. */
export function pendingUploadErrorMessage(error: unknown): string | null {
	if (!(error instanceof Error)) return null;
	if (isRejectedPendingUpload(error)) {
		return 'Bild konnte nicht hochgeladen werden: Die Datei wird abgelehnt. Entferne das Bild und wähle es erneut aus.';
	}
	const match = /^sign-failed:(\d+)(?::(.+))?$/.exec(error.message);
	if (!match) return null;
	const status = Number(match[1]);
	const message = uploadSignErrorMessage(status, match[2] ?? '');
	if (status >= 500 && message === GENERIC_SIGN_ERROR) return null;
	return message;
}

/** The storage answered the PUT with a 4xx that a retry cannot fix (not a timeout or rate limit). */
export function isRejectedPendingUpload(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const match = /^upload-failed:(\d+)$/.exec(error.message);
	if (!match) return false;
	const status = Number(match[1]);
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
