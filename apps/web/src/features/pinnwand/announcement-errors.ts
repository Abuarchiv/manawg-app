import { mutationErrorMessage } from '@/core/http/error-codes';

const CREATE_SUBJECT = 'Beitrag konnte nicht gespeichert werden';
const CREATE_ERRORS: Record<string, string> = {
	content_invalid: `${CREATE_SUBJECT}: Der Text muss 1 bis 2000 Zeichen haben.`,
	kind_invalid: `${CREATE_SUBJECT}: Die Beitragsart ist ungültig.`,
	image_invalid: `${CREATE_SUBJECT}: Der Anhang ist ungültig.`,
	image_removed: `${CREATE_SUBJECT}: Der Anhang wurde entfernt. Lade das Bild erneut hoch.`,
	source_path_invalid: `${CREATE_SUBJECT}: Der Quelllink ist ungültig.`,
	insert_failed: `${CREATE_SUBJECT}: Prüfe die Pinnwand und versuche es erneut.`,
	invalid_json: `${CREATE_SUBJECT}: Die Anfrage war ungültig.`,
};

export function announcementCreateErrorMessage(error: string): string {
	return mutationErrorMessage(CREATE_SUBJECT, error, CREATE_ERRORS, `${CREATE_SUBJECT}.`);
}

const ACTION_SUBJECT = 'Aktion konnte nicht gespeichert werden';
const ACTION_ERRORS: Record<string, string> = {
	reaction_invalid: 'Reaktion konnte nicht gespeichert werden: Die Reaktion ist ungültig.',
	insert_failed:
		'Reaktion konnte nicht gespeichert werden: Lade den Beitrag neu und versuche es erneut.',
	delete_failed:
		'Reaktion konnte nicht entfernt werden: Lade den Beitrag neu und prüfe den aktuellen Stand.',
	reaction_not_found:
		'Reaktion existiert nicht mehr. Lade den Beitrag neu, um den aktuellen Stand zu sehen.',
	status_invalid: 'Pinnwand-Status konnte nicht gespeichert werden: Der Status ist ungültig.',
	pinned_invalid: 'Fixierung konnte nicht gespeichert werden: Der Wert ist ungültig.',
	kind_invalid: `${ACTION_SUBJECT}: Die Beitragsart ist ungültig.`,
	content_invalid: `${ACTION_SUBJECT}: Der Text muss 1 bis 2000 Zeichen haben.`,
	not_owner: `${ACTION_SUBJECT}: Nur wer den Beitrag geschrieben hat, kann ihn bearbeiten.`,
	announcement_resolved: 'Dieser Beitrag wurde inzwischen geklärt.',
	status_change_not_allowed:
		'Nur wer den Beitrag geschrieben oder übernommen hat und WG-Admins können diesen Beitrag als geklärt markieren.',
	invalid_body: `${ACTION_SUBJECT}: Die Anfrage war ungültig.`,
	invalid_json: `${ACTION_SUBJECT}: Die Anfrage war ungültig.`,
};

export function announcementActionErrorMessage(error: string): string {
	return mutationErrorMessage(
		ACTION_SUBJECT,
		error,
		ACTION_ERRORS,
		`${ACTION_SUBJECT}. Versuche es erneut.`,
	);
}
