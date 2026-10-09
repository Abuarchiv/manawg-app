import type { AbsenceInput } from '@/features/chores/absence';

export type RecurrenceType = 'days' | 'months';

export interface Chore {
	id: string;
	title: string;
	intervalDays: number;
	recurrenceType: RecurrenceType;
	nextDueAt: string;
	assignedMemberId: string | null;
	lastCompletedAt: string | null;
	lastCompletedByName: string | null;
	openGapCountForAssignee: number;
}

/** A chore as the plan shows it: the list data plus what only the client derives. */
export interface PlanChore extends Chore {
	assigneeAbsent?: boolean;
}

export interface ChoreListResponse {
	chores: Chore[];
	/** Erledigungen pro Mitglied seit Monatsbeginn. */
	monthCompletions?: Record<string, number>;
}

export interface AbsenceListResponse {
	absences: AbsenceInput[];
}

// Minimal member shape needed by the chore/absence selects. Structurally a
// subset of the WgContext `Member`, so passing `useWg().members` in is safe.
export interface ChoreMember {
	id: string;
	name: string;
}
