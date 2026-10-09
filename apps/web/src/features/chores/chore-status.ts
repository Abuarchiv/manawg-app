import { berlinCalendarDayDistance } from '@/core/utils/berlin-day';
import { parseTimestamp } from '@/core/utils/time';

type ChoreStatusState = 'planned' | 'due' | 'overdue' | 'unknown';
type ChoreStatusTone = 'ok' | 'soon' | 'overdue';

interface ChoreStatus {
	state: ChoreStatusState;
	tone: ChoreStatusTone;
	label: string;
	detail: string;
	actionLabel: 'Erledigt' | 'Nachholen';
	overdueDays: number;
	escalated: boolean;
	escalationLabel: 'Klärung offen' | null;
}

interface ChoreHealthInput {
	nextDueAt: string;
}

interface ChoreRepairInput {
	assignedMemberId: string | null;
	nextDueAt: string;
	/** The assignee is away on the due day (or today if overdue); the rotation only moves the chore on completion. */
	assigneeAbsent?: boolean;
}

interface ChoreRepairHint {
	tone: 'danger' | 'neutral';
	title: string;
	action: string;
}

interface ChorePlanHealth {
	total: number;
	gaps: number;
	dueToday: number;
	escalated: number;
	nextLabel: string;
}

function calendarDayDistance(iso: string, now: number): number | null {
	const dueAt = parseTimestamp(iso);
	return dueAt === null ? null : berlinCalendarDayDistance(new Date(now), new Date(dueAt));
}

export function getChoreStatus(iso: string, now = Date.now()): ChoreStatus {
	const diffDays = calendarDayDistance(iso, now);
	if (diffDays === null) {
		return {
			state: 'unknown',
			tone: 'soon',
			label: 'Datum prüfen',
			detail: 'Fälligkeit ist unklar',
			actionLabel: 'Erledigt',
			overdueDays: 0,
			escalated: false,
			escalationLabel: null,
		};
	}

	if (diffDays < 0) {
		const overdueDays = Math.abs(diffDays);
		const escalated = overdueDays >= 2;
		return {
			state: 'overdue',
			tone: 'overdue',
			label: `seit ${overdueDays} T. offen`,
			detail: `Seit ${overdueDays} ${overdueDays === 1 ? 'Tag' : 'Tagen'} offen`,
			actionLabel: 'Nachholen',
			overdueDays,
			escalated,
			escalationLabel: escalated ? 'Klärung offen' : null,
		};
	}

	if (diffDays === 0) {
		return {
			state: 'due',
			tone: 'soon',
			label: 'heute fällig',
			detail: 'Heute offen',
			actionLabel: 'Erledigt',
			overdueDays: 0,
			escalated: false,
			escalationLabel: null,
		};
	}

	return {
		state: 'planned',
		tone: diffDays <= 3 ? 'soon' : 'ok',
		label: diffDays === 1 ? 'morgen' : `in ${diffDays} T.`,
		detail: 'Geplant',
		actionLabel: 'Erledigt',
		overdueDays: 0,
		escalated: false,
		escalationLabel: null,
	};
}

export function getChorePlanHealth(items: ChoreHealthInput[], now = Date.now()): ChorePlanHealth {
	if (items.length === 0) {
		return {
			total: 0,
			gaps: 0,
			dueToday: 0,
			escalated: 0,
			nextLabel: 'keine',
		};
	}

	const statuses = items.map((item) => getChoreStatus(item.nextDueAt, now));
	const gaps = statuses.filter((status) => status.state === 'overdue').length;
	const dueToday = statuses.filter((status) => status.state === 'due').length;
	const escalated = statuses.filter((status) => status.escalated).length;
	const nextLabel = statuses[0]?.label ?? 'keine';

	return {
		total: items.length,
		gaps,
		dueToday,
		escalated,
		nextLabel,
	};
}

export function getChoreRepairHint(
	item: ChoreRepairInput,
	now = Date.now(),
): ChoreRepairHint | null {
	if (!item.assignedMemberId) {
		return {
			tone: 'danger',
			title: 'Niemand zuständig',
			action: 'Person zuweisen',
		};
	}

	if (item.assigneeAbsent) {
		return { tone: 'danger', title: 'Zuständig ist abwesend', action: 'Ich übernehme' };
	}

	const status = getChoreStatus(item.nextDueAt, now);
	if (!status.escalated) return null;

	return {
		tone: 'danger',
		title: `Offen seit ${status.overdueDays} Tagen`,
		action: 'Neu zuweisen oder erledigen',
	};
}

export type ChoreGroupKey = 'mine' | 'overdue' | 'week' | 'later';

const CHORE_GROUPS: { key: ChoreGroupKey; label: string }[] = [
	{ key: 'mine', label: 'Für dich' },
	{ key: 'overdue', label: 'Noch offen' },
	{ key: 'week', label: 'Diese Woche' },
	{ key: 'later', label: 'Später' },
];

/** Own chores due by tomorrow come first, others follow by urgency. */
function getChoreGroup(
	chore: ChoreRepairInput,
	currentMemberId: string,
	now = Date.now(),
): ChoreGroupKey {
	const days = calendarDayDistance(chore.nextDueAt, now);
	if (days === null) return 'later';
	if (chore.assignedMemberId === currentMemberId && days <= 1) return 'mine';
	if (days < 0) return 'overdue';
	return days <= 7 ? 'week' : 'later';
}

/** Chores in need of repair come first within each group; empty groups are dropped. */
export function groupChoresForPlan<T extends ChoreRepairInput>(
	chores: T[],
	currentMemberId: string,
): { key: ChoreGroupKey; label: string; chores: T[] }[] {
	const needsRepair = (chore: T) => (getChoreRepairHint(chore) !== null ? 0 : 1);
	const sorted = [...chores].sort((a, b) => needsRepair(a) - needsRepair(b));
	return CHORE_GROUPS.map((group) => ({
		...group,
		chores: sorted.filter((chore) => getChoreGroup(chore, currentMemberId) === group.key),
	})).filter((group) => group.chores.length > 0);
}

/** Keeps only overdue chores (for `?filter=overdue`); groups left empty are dropped. */
export function filterOverdueGroups<T extends { nextDueAt: string }>(
	groups: { key: ChoreGroupKey; label: string; chores: T[] }[],
	now = Date.now(),
): { key: ChoreGroupKey; label: string; chores: T[] }[] {
	return groups
		.map((group) => ({
			...group,
			chores: group.chores.filter(
				(chore) => getChoreStatus(chore.nextDueAt, now).state === 'overdue',
			),
		}))
		.filter((group) => group.chores.length > 0);
}
