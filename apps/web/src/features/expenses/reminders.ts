import { formatEuroCents, normalizeCurrency } from '@/core/utils/money';

export const REMINDER_COOLDOWN_HOURS = 48;
const HOURS_TO_MS = 3_600_000;
const REMINDER_COOLDOWN_MS = REMINDER_COOLDOWN_HOURS * HOURS_TO_MS;

interface ReminderHistoryEntry {
	debtorMemberId: string;
	creditorMemberId: string;
	currency?: string;
	sentAt: string | Date;
}

interface ReminderCooldownResult {
	allowed: boolean;
	cooldownMs: number;
	nextAllowedAt: Date | null;
	lastSentAt: Date | null;
}

function toMs(value: string | Date): number {
	if (value instanceof Date) return value.getTime();
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Returns whether a new reminder may be sent from `creditor` to `debtor`.
 *
 * Cooldown is 48 h per (currency, debtor, creditor) ordered pair — reversing the
 * roles or changing currency is a different reminder. The most recent matching
 * entry in `history` wins; entries for other pairs are ignored.
 */
export function canSendReminder(
	debtorMemberId: string,
	creditorMemberId: string,
	history: ReadonlyArray<ReminderHistoryEntry>,
	now: Date = new Date(),
	currency?: string,
): ReminderCooldownResult {
	const normalizedCurrency = currency === undefined ? undefined : normalizeCurrency(currency);
	let lastMs = 0;
	for (const entry of history) {
		if (entry.debtorMemberId !== debtorMemberId) continue;
		if (entry.creditorMemberId !== creditorMemberId) continue;
		if (
			normalizedCurrency !== undefined &&
			normalizeCurrency(entry.currency) !== normalizedCurrency
		) {
			continue;
		}
		const sentMs = toMs(entry.sentAt);
		if (sentMs > lastMs) lastMs = sentMs;
	}

	if (lastMs === 0) {
		return { allowed: true, cooldownMs: 0, nextAllowedAt: null, lastSentAt: null };
	}

	const nowMs = now.getTime();
	const elapsed = nowMs - lastMs;
	if (elapsed >= REMINDER_COOLDOWN_MS) {
		return {
			allowed: true,
			cooldownMs: 0,
			nextAllowedAt: null,
			lastSentAt: new Date(lastMs),
		};
	}

	return {
		allowed: false,
		cooldownMs: REMINDER_COOLDOWN_MS - elapsed,
		nextAllowedAt: new Date(lastMs + REMINDER_COOLDOWN_MS),
		lastSentAt: new Date(lastMs),
	};
}

interface ReminderMessageInput {
	debtorName: string;
	creditorName: string;
	amountCents: number;
	currency: string;
	oldestDebtAgeDays: number;
}

export function formatReminderMessage(input: ReminderMessageInput): string {
	const amount = formatEuroCents(input.amountCents, input.currency).replace(/ /g, ' ');
	const ageSuffix =
		input.oldestDebtAgeDays >= 1
			? ` seit ${input.oldestDebtAgeDays} ${input.oldestDebtAgeDays === 1 ? 'Tag' : 'Tagen'}`
			: '';
	return `Du schuldest ${input.creditorName} noch ${amount}${ageSuffix} — bitte zeitnah ausgleichen.`;
}
