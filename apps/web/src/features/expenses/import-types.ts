export interface ParsedSplit {
	memberName: string;
	amountCents: number;
}

export interface ParsedExpense {
	date: string;
	description: string;
	amountCents: number;
	currency: 'EUR';
	paidByName: string;
	splits: ParsedSplit[];
	warnings: string[];
}

/** A CSV data row the parser could not turn into an expense; `line` is the 1-based file line. */
export interface RejectedRow {
	line: number;
	reason: 'date_invalid' | 'amount_invalid' | 'no_participants' | 'payer_missing';
	description: string;
}

export type ImportSource = 'splitwise_csv' | 'splid_csv' | 'ocr_screenshot' | 'manual';

export class UnsupportedCurrencyError extends Error {
	readonly currency: string;
	constructor(currency: string) {
		super('Nur EUR-Importe unterstützt');
		this.name = 'UnsupportedCurrencyError';
		this.currency = currency;
	}
}
