import { formatEuroInput } from '@/core/utils/amount';
import { safeLocalStorage } from '@/core/utils/browser';
import { todayInputValue } from '@/core/utils/local-date';
import type { OfflineAction, OfflineActionType } from './offline-queue';

export type DraftModule = 'announcement' | 'expense' | 'shopping' | 'chore' | 'absence';

export interface QueueEditDraft {
	module: DraftModule;
	draft: Record<string, unknown> & { queueEditId: string; queueEditType: OfflineActionType };
}

export function buildDraftKey(shareCode: string, memberId: string, module: DraftModule): string {
	return `manawg:draft:${shareCode}:${memberId}:${module}`;
}

export function buildQueueEditHref(
	shareCode: string,
	module: DraftModule,
	options?: { openAbsencesPanel?: boolean },
): string {
	const encodedShareCode = encodeURIComponent(shareCode);
	if (module === 'shopping') return `/wg/${encodedShareCode}/einkauf`;
	if (module === 'announcement') return `/wg/${encodedShareCode}/pinnwand`;
	if (module === 'expense') return `/wg/${encodedShareCode}/ausgaben`;
	if (module === 'absence' || (module === 'chore' && options?.openAbsencesPanel)) {
		return `/wg/${encodedShareCode}/putzen?panel=absences`;
	}
	return `/wg/${encodedShareCode}/putzen`;
}

function parseDraft<T extends Record<string, unknown>>(raw: string | null): T | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as T;
	} catch {
		return null;
	}
}

export function readDraft<T extends Record<string, unknown>>(key: string): T | null {
	const storage = safeLocalStorage();
	if (!storage) return null;
	try {
		return parseDraft<T>(storage.getItem(key));
	} catch {
		return null;
	}
}

export function writeDraft(key: string, draft: Record<string, unknown>): boolean {
	const storage = safeLocalStorage();
	if (!storage) return false;
	try {
		storage.setItem(key, JSON.stringify(draft));
		return true;
	} catch {
		// Draft persistence is best-effort; blocked storage must not break form input.
		return false;
	}
}

export function removeDraft(key: string): void {
	const storage = safeLocalStorage();
	if (!storage) return;
	try {
		storage.removeItem(key);
	} catch {
		// Best-effort cleanup only.
	}
}

/** Only exact, known initial values are empty; unknown fields stay protected. */
export function isEmptyModuleDraft(
	module: DraftModule,
	draft: Record<string, unknown>,
	memberId: string,
): boolean {
	const defaults: Record<DraftModule, Record<string, unknown>> = {
		expense: {
			description: '',
			amountStr: '',
			imageUrl: null,
			paidByMemberId: memberId,
			splitMode: 'equal',
			manualSplits: {},
			queueEditId: null,
			queueEditType: null,
			recurringIntervalMonths: 1,
			recurringNextDueAt: null,
			recurringSourceId: null,
			editingExpense: null,
		},
		shopping: { name: '', quantity: '', queueEditId: null },
		announcement: { content: '', kind: 'info', imageUrl: null, queueEditId: null },
		chore: {
			title: '',
			intervalDays: 7,
			recurrenceType: 'days',
			assignedMemberId: '',
			queueEditId: null,
		},
		absence: {
			absenceMemberId: memberId,
			absenceStartDate: '',
			absenceEndDate: '',
			absenceReason: '',
			queueEditId: null,
		},
	};
	// The Putzplan page keeps its absence form in the same draft as the chore form.
	const known = module === 'chore' ? { ...defaults.chore, ...defaults.absence } : defaults[module];
	return Object.entries(draft).every(
		([key, value]) =>
			Object.hasOwn(known, key) && JSON.stringify(value) === JSON.stringify(known[key]),
	);
}

export function buildQueueEditDraft(action: OfflineAction): QueueEditDraft | null {
	const rawSplits = action.payload.splits;
	const manualSplits = Array.isArray(rawSplits)
		? Object.fromEntries(
				rawSplits
					.map((split) => {
						if (!split || typeof split !== 'object') return null;
						const debtorMemberId = Reflect.get(split, 'debtorMemberId');
						const amountCents = Reflect.get(split, 'amountCents');
						if (typeof debtorMemberId !== 'string' || typeof amountCents !== 'number') return null;
						return [debtorMemberId, formatEuroInput(amountCents / 100)];
					})
					.filter((split): split is [string, string] => Boolean(split)),
			)
		: null;

	switch (action.type) {
		case 'shopping.create':
			return {
				module: 'shopping',
				draft: {
					queueEditId: action.id,
					queueEditType: action.type,
					name: String(action.payload.name ?? ''),
					quantity: typeof action.payload.quantity === 'string' ? action.payload.quantity : '',
				},
			};
		// Queued updates have no owning edit form: the Einkaufs-/Ausgaben-forms
		// only create, so editing one there would turn the update into a new
		// item and drop the original. They can only be synced or discarded.
		case 'shopping.update':
		case 'expense.update':
			return null;
		case 'recurring.advance':
			return null;
		case 'announcement.create':
			return {
				module: 'announcement',
				draft: {
					queueEditId: action.id,
					queueEditType: action.type,
					content: String(action.payload.content ?? ''),
					kind: String(action.payload.kind ?? 'info'),
					imageUrl: typeof action.payload.imageUrl === 'string' ? action.payload.imageUrl : null,
				},
			};
		case 'absence.create':
			// The Putzplan owns both forms and reads only the chore draft key.
			return {
				module: 'chore',
				draft: {
					queueEditId: action.id,
					queueEditType: action.type,
					absenceMemberId:
						typeof action.payload.memberId === 'string' ? action.payload.memberId : '',
					absenceStartDate:
						typeof action.payload.startDate === 'string' ? action.payload.startDate : '',
					absenceEndDate: typeof action.payload.endDate === 'string' ? action.payload.endDate : '',
					absenceReason: typeof action.payload.reason === 'string' ? action.payload.reason : '',
					openAbsencesPanel: true,
				},
			};
		case 'chore.create':
			return {
				module: 'chore',
				draft: {
					queueEditId: action.id,
					queueEditType: action.type,
					title: String(action.payload.title ?? ''),
					recurrenceType: action.payload.recurrenceType === 'months' ? 'months' : 'days',
					intervalDays:
						typeof action.payload.intervalDays === 'number' ? action.payload.intervalDays : 7,
					assignedMemberId:
						typeof action.payload.assignedMemberId === 'string'
							? action.payload.assignedMemberId
							: '',
				},
			};
		case 'expense.create':
		case 'recurring.create':
			return {
				module: 'expense',
				draft: {
					queueEditId: action.id,
					queueEditType: action.type,
					description: String(action.payload.description ?? ''),
					amountStr:
						typeof action.payload.amountCents === 'number'
							? formatEuroInput(action.payload.amountCents / 100)
							: '',
					imageUrl: typeof action.payload.imageUrl === 'string' ? action.payload.imageUrl : null,
					paidByMemberId:
						typeof action.payload.paidByMemberId === 'string' ? action.payload.paidByMemberId : '',
					// Re-queuing must keep the day the expense happened, not the day of the edit.
					...(action.type === 'expense.create' && typeof action.payload.occurredAt === 'string'
						? { occurredOn: todayInputValue(new Date(action.payload.occurredAt)) }
						: {}),
					splitMode: manualSplits && Object.keys(manualSplits).length > 0 ? 'manual' : 'equal',
					recurringIntervalMonths:
						typeof action.payload.intervalMonths === 'number'
							? action.payload.intervalMonths
							: undefined,
					recurringNextDueAt:
						typeof action.payload.nextDueAt === 'string' ? action.payload.nextDueAt : undefined,
					// A queued "Fixkosten nachholen" booking must keep its template link,
					// otherwise the edited booking never advances the template. Its
					// recurringNextDueAt is the template due date the booking expects.
					...(action.type === 'expense.create' &&
					typeof action.payload.recurringExpenseId === 'string'
						? {
								recurringSourceId: action.payload.recurringExpenseId,
								recurringNextDueAt:
									typeof action.payload.expectedRecurringNextDueAt === 'string'
										? action.payload.expectedRecurringNextDueAt
										: undefined,
							}
						: {}),
					...(manualSplits && Object.keys(manualSplits).length > 0 ? { manualSplits } : {}),
				},
			};
		case 'chore.complete':
			return null;
	}
}
