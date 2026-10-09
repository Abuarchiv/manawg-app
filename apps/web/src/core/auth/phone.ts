/**
 * Normalises typed phone input toward E.164: drops separators and a "(0)" trunk
 * prefix, and turns a leading "00" into "+". A bare leading "0" is left alone
 * because the country cannot be guessed.
 */
export function normalizePhoneInput(raw: string): string {
	const compact = raw
		.trim()
		.replace(/\(0\)/g, '')
		.replace(/[\s().\-/]/g, '');
	return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
}
