const AMOUNT_NUMBER = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,5}(?:[,.]\d{1,2})?`;
// Currency either before ("€ 35,50") or after ("35 Euro", "12,5 EUR", "35€") the number.
const AMOUNT_PATTERN = new RegExp(
	String.raw`(?:^|\s)(?:€\s*(${AMOUNT_NUMBER})|(${AMOUNT_NUMBER})\s*(?:€|eur(?:o)?))(?=[\s.,;:!?)]|$)`,
	'i',
);

function normalizeAmountStr(raw: string): string {
	if (raw.includes(',')) return raw.replace(/\./g, '');
	if (/^\d{1,3}(?:\.\d{3})+$/.test(raw)) return raw.replace(/\./g, '');
	return raw;
}

interface PinnwandPrefill {
	title: string;
	amountStr: string | null;
}

export function buildPinnwandPrefill(content: string): PinnwandPrefill {
	const compact = content
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.join(' ')
		.slice(0, 120);
	const match = compact.match(AMOUNT_PATTERN);
	const amount = match?.[1] ?? match?.[2];
	const amountStr = amount ? normalizeAmountStr(amount) : null;
	const title = compact
		.replace(AMOUNT_PATTERN, ' ')
		.replace(/\s+[.,;:!?)](?=\s|$)/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
	return {
		title: title || compact.slice(0, 80),
		amountStr,
	};
}

export function getPinnwandPrefillHref(
	shareCode: string,
	target: 'shopping' | 'chore' | 'expense',
	prefill: PinnwandPrefill,
): string {
	const params = new URLSearchParams();
	const encodedShareCode = encodeURIComponent(shareCode);
	if (target === 'shopping') {
		params.set('name', prefill.title);
		return `/wg/${encodedShareCode}/einkauf?${params.toString()}`;
	}
	if (target === 'chore') {
		params.set('title', prefill.title);
		return `/wg/${encodedShareCode}/putzen?${params.toString()}`;
	}
	params.set('desc', prefill.title);
	if (prefill.amountStr) params.set('amount', prefill.amountStr);
	return `/wg/${encodedShareCode}/ausgaben?${params.toString()}`;
}
