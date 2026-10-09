export interface ExpenseSplit {
	id: string;
	debtorMemberId: string;
	amountCents: number;
	settledAt: string | null;
}

export interface Expense {
	id: string;
	paidByMemberId: string;
	amountCents: number;
	currency: string;
	description: string;
	imageUrl: string | null;
	occurredAt: string;
	createdAt: string;
	updatedAt: string;
	splits: ExpenseSplit[];
}

export interface RecurringExpense {
	id: string;
	description: string;
	amountCents: number;
	currency: string;
	paidByMemberId: string;
	intervalMonths: number;
	nextDueAt: string;
	createdByMemberId?: string;
	lastCreatedAt: string | null;
	/** Paused templates are neither booked by the cron nor captured manually (API: abo_paused). */
	pausedAt?: string | null;
	splits: Array<{ debtorMemberId: string; amountCents: number }>;
}
