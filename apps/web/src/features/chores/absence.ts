import { berlinDayKey } from '@/core/utils/berlin-day';
import { parseTimestamp } from '@/core/utils/time';

export interface AbsenceInput {
	id: string;
	memberId: string;
	memberName: string;
	startDate: string;
	endDate: string;
	reason: string | null;
}

export function getAbsentMemberIds(
	absences: Array<Pick<AbsenceInput, 'memberId' | 'startDate' | 'endDate'>>,
	at = Date.now(),
): string[] {
	return Array.from(
		new Set(
			absences
				.filter((absence) => isAbsenceActive(absence.startDate, absence.endDate, at))
				.map((absence) => absence.memberId),
		),
	);
}

/**
 * Ids of chores whose assignee is away when it matters: on the due day for upcoming
 * chores (as the rotation judges it), today for overdue ones.
 */
export function getAbsentAssigneeChoreIds(
	chores: Array<{ id: string; assignedMemberId: string | null; nextDueAt: string }>,
	absences: Array<Pick<AbsenceInput, 'memberId' | 'startDate' | 'endDate'>>,
	now = Date.now(),
): Set<string> {
	const ids = new Set<string>();
	if (absences.length === 0) return ids;
	for (const chore of chores) {
		if (!chore.assignedMemberId) continue;
		const dueAt = parseTimestamp(chore.nextDueAt);
		const at = dueAt === null ? now : Math.max(dueAt, now);
		if (getAbsentMemberIds(absences, at).includes(chore.assignedMemberId)) ids.add(chore.id);
	}
	return ids;
}

function isAbsenceActive(startDate: string, endDate: string, at: number): boolean {
	const start = parseTimestamp(startDate);
	const end = parseTimestamp(endDate);
	if (start === null || end === null) return false;
	const day = berlinDayKey(new Date(at));
	return berlinDayKey(new Date(start)) <= day && day <= berlinDayKey(new Date(end));
}

/** Without an open panel only the first four; an absence chosen via link stays visible. */
export function pickVisibleAbsences(
	absences: AbsenceInput[],
	showAll: boolean,
	selectedId: string | null,
): AbsenceInput[] {
	if (showAll) return absences;
	const firstItems = absences.slice(0, 4);
	const selected = absences.find((absence) => absence.id === selectedId);
	if (!selected || firstItems.some((absence) => absence.id === selected.id)) return firstItems;
	return [selected, ...firstItems].slice(0, 4);
}
