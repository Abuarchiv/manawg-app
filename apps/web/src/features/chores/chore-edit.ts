import { dueAtForDay, dueDayKey } from '@/features/chores/chore-due-date';
import type { Chore } from '@/features/chores/components/chore-types';

/** The fields `PATCH /chores/<id>` accepts from the edit form; only changed ones are set. */
export interface ChoreEditChanges {
	title?: string;
	assignedMemberId?: string | null;
	nextDueAt?: string;
	intervalDays?: number;
	recurrenceType?: Chore['recurrenceType'];
}

/** Compares the form with the stored chore; an empty result means nothing to save. */
export function diffChoreEdit(
	chore: Chore,
	form: {
		title: string;
		assigned: string;
		dueDay: string;
		interval: number;
		recurrenceType: Chore['recurrenceType'];
	},
): ChoreEditChanges {
	const changes: ChoreEditChanges = {};
	const title = form.title.trim();
	if (title && title !== chore.title) changes.title = title;
	if (form.assigned !== (chore.assignedMemberId ?? '')) {
		changes.assignedMemberId = form.assigned || null;
	}
	if (form.dueDay && form.dueDay !== dueDayKey(chore.nextDueAt)) {
		const dueAt = dueAtForDay(form.dueDay, chore.nextDueAt);
		if (dueAt) changes.nextDueAt = dueAt;
	}
	if (form.interval !== chore.intervalDays || form.recurrenceType !== chore.recurrenceType) {
		changes.intervalDays = form.interval;
		changes.recurrenceType = form.recurrenceType;
	}
	return changes;
}
