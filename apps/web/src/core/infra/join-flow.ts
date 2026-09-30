import { isValidShareCode, normalizeShareCode } from '@/shared/lib/share-code';

export function getInitialJoinCode(search: string): string {
	const params = new URLSearchParams(search);
	const raw = params.get('code') ?? '';
	const code = normalizeShareCode(raw);
	return isValidShareCode(code) ? code : '';
}

export function joinErrorMessage(status: number, error: string): string {
	if (status === 404 || error === 'wg_not_found') return 'Diesen WG-Code gibt es nicht.';
	if (status === 409 && error === 'name_taken') return 'Der Name ist in dieser WG schon vergeben.';
	if (status === 409 && error === 'member_limit_reached') return 'Diese WG ist schon voll.';
	if (status === 403 && error === 'joining_disabled') {
		return 'Diese WG nimmt gerade keine neuen Beitritte an.';
	}
	if (error === 'insert_failed') {
		return 'Beitritt konnte nicht gespeichert werden: Prüfe die WG und versuche es erneut.';
	}
	if (
		status >= 500 ||
		error === 'server_error' ||
		error === 'unexpected_error' ||
		error === 'db_error'
	) {
		return 'Beitritt konnte nicht abgeschlossen werden: Versuche es gleich erneut.';
	}
	if (error === 'name_invalid') {
		return 'Dein Name muss 1 bis 80 Zeichen haben.';
	}
	if (status === 400) return 'Bitte prüfe deine Eingabe.';
	if (status === 0) {
		return 'Beitritt konnte nicht abgeschlossen werden: Prüfe deine Verbindung und versuche es erneut.';
	}
	return 'Hat nicht geklappt. Bitte nochmal versuchen.';
}
