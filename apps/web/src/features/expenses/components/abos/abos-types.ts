export interface AboSplit {
	debtorMemberId: string;
	amountCents: number;
}

export interface Abo {
	id: string;
	description: string;
	amountCents: number;
	currency: string;
	paidByMemberId: string;
	intervalMonths: number;
	nextDueAt: string;
	/** Original cadence anchor; absent on legacy rows. */
	anchorAt?: string | null;
	createdByMemberId?: string;
	lastCreatedAt: string | null;
	pausedAt: string | null;
	splits: AboSplit[];
}

export type AboFilter = 'active' | 'paused' | 'all';

export interface MemberOption {
	id: string;
	name: string;
	color: string | null;
	active: boolean;
}
