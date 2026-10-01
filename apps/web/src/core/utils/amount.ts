export function parseEuroAmount(value: string): number | null {
	const trimmed = value.trim();
	// German thousands dots ("1.234,56", "1.200") — only in the strict 3-digit-group form.
	const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{0,2})?$/.test(trimmed)
		? trimmed.replace(/\./g, '').replace(',', '.')
		: trimmed.replace(',', '.');
	if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
	const amount = Number(normalized);
	return Number.isFinite(amount) ? amount : null;
}

export function formatEuroInput(value: number): string {
	return value.toFixed(2).replace('.', ',');
}
