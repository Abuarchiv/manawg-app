import 'server-only';
import { expenses } from '@/core/db';
import type { DbTransaction } from '@/core/db/transaction';
import { eq } from 'drizzle-orm';

export function buildDuplicateKey(
	date: string,
	description: string,
	amountCents: number,
	paidByMemberId: string,
	currency: string,
): string {
	const key = [date.slice(0, 10), description.trim().toLowerCase(), amountCents, paidByMemberId];
	// EUR import keys already persisted in this four-part format; keep them stable.
	return (currency === 'EUR' ? key : [...key, currency]).join('|');
}

// Reads inside the same transaction as the writes: the duplicate keys are the
// yardstick for every row of this import, so they must not be a snapshot taken
// before a concurrent import added rows.
// Counts per key: a file may hold the same purchase twice, so a row is only a duplicate while
// the WG holds at least as many copies as the file has shown so far.
export async function loadDuplicateKeys(
	tx: DbTransaction,
	wgId: string,
): Promise<Map<string, number>> {
	const rows = await tx
		.select({
			occurredAt: expenses.occurredAt,
			description: expenses.description,
			amountCents: expenses.amountCents,
			currency: expenses.currency,
			paidByMemberId: expenses.paidByMemberId,
		})
		.from(expenses)
		.where(eq(expenses.wgId, wgId));
	const counts = new Map<string, number>();
	for (const r of rows) {
		const iso =
			r.occurredAt instanceof Date
				? r.occurredAt.toISOString()
				: new Date(r.occurredAt).toISOString();
		const key = buildDuplicateKey(iso, r.description, r.amountCents, r.paidByMemberId, r.currency);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}
