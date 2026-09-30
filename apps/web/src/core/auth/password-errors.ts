export const WEAK_PASSWORD_MESSAGE =
	'Wähle ein längeres oder anderes sicheres Passwort, das du nicht schon an anderer Stelle verwendest.';

export function isWeakPasswordError(error: unknown): boolean {
	return (
		error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'weak_password'
	);
}
