/**
 * Pure helpers for recurring-chore due-date math.
 *
 * Bug history #1: an earlier implementation computed `nextDueAt` from
 * `Date.now()` only. For a monthly chore completed 5 days early, the next due
 * also slid 5 days earlier — across a year this drifts ~60 days off-cadence.
 *
 * Fix #1: anchor the next due on the previous due so the cadence stays stable,
 * but re-anchor on `completedAt` once the due day has passed so a
 * massively-overdue chore is not scheduled in the past.
 *
 *   nextDueAt = (late ? completedAt : prevDueAt) + interval
 *
 * Bug history #2: "monatlich" was encoded as `intervalDays = 30`, but 12×30
 * = 360 days, so a chore created Jan 1 fires Dec 27 by year end. Real users
 * notice this.
 *
 * Fix #2: introduce `recurrenceType: 'days' | 'months'`. The 'months' branch
 * adds calendar months so 12 monthly cycles land on the exact same calendar
 * day each year. Month-end is clamped (Jan 31 + 1 month → Feb 28/29, NOT
 * March 3).
 *
 * Bug history #3: 'days' added raw 24h blocks, shifting the wall-clock time
 * (and near midnight the weekday) across DST. Both branches now step on the
 * Europe/Berlin calendar.
 */

import type { ChoreRecurrenceType } from '@/core/db/schema';
import { berlinDayKey, berlinWallMinutes, instantAtBerlinWallTime } from '@/core/utils/berlin-day';

const MS_PER_MINUTE = 60 * 1000;

interface BerlinWallTime {
	year: number;
	/** 0-based month, like `Date.getUTCMonth()`. */
	month: number;
	day: number;
	minutes: number;
	subMinuteMs: number;
}

function toBerlinWallTime(date: Date): BerlinWallTime {
	const [year, month, day] = berlinDayKey(date).split('-').map(Number) as [number, number, number];
	return {
		year,
		month: month - 1,
		day,
		minutes: berlinWallMinutes(date),
		subMinuteMs: ((date.getTime() % MS_PER_MINUTE) + MS_PER_MINUTE) % MS_PER_MINUTE,
	};
}

function fromBerlinWallTime(wall: BerlinWallTime): Date {
	// Normalize overflowing day/month values (e.g. day 35) via UTC calendar math.
	const normalized = new Date(Date.UTC(wall.year, wall.month, wall.day));
	const dayKey = normalized.toISOString().slice(0, 10);
	// A wall time inside the spring-forward gap does not exist; use the hour after.
	const instant =
		instantAtBerlinWallTime(dayKey, wall.minutes) ??
		instantAtBerlinWallTime(dayKey, wall.minutes + 60);
	if (!instant) throw new Error(`Cannot resolve Berlin wall time on ${dayKey}`);
	return new Date(instant.getTime() + wall.subMinuteMs);
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * A completion is late only once the Berlin due *day* has passed. Finishing a
 * chore on its due day after the due time is the normal case and must not
 * re-anchor the cadence.
 */
export function isLateCompletion(prevDueAt: Date, completedAt: Date): boolean {
	return berlinDayKey(completedAt) > berlinDayKey(prevDueAt);
}

/**
 * Keep the requested creation date as the recurrence anchor even when the
 * first monthly due date must be clamped to the end of a shorter month.
 */
export function computeInitialDue(
	createdAt: Date,
	interval: number,
	recurrenceType: ChoreRecurrenceType,
	requestedDueAt: Date | null,
): { nextDueAt: Date; anchorAt: Date } {
	if (requestedDueAt) {
		return { nextDueAt: new Date(requestedDueAt), anchorAt: new Date(requestedDueAt) };
	}
	return {
		nextDueAt: computeNextDueAt(createdAt, interval, createdAt, recurrenceType),
		anchorAt: new Date(createdAt),
	};
}

/**
 * Compute the next due date for a recurring chore after completion.
 *
 * All calendar math runs on the Europe/Berlin wall clock, so a daily cadence
 * keeps its local time across DST switches and month-end clamping follows the
 * Berlin calendar day members see.
 *
 * @param prevDueAt      the chore's current `nextDueAt` before completion
 * @param interval       cadence in days OR months (see `recurrenceType`);
 *                       `0` keeps the previous due (one-shot)
 * @param completedAt    timestamp at which the chore was completed
 * @param recurrenceType `'days'` (Berlin calendar days, legacy default) or
 *                       `'months'` (Berlin calendar months)
 * @param anchorAt       original cadence anchor; keeps the month-end
 *                       day-of-month stable across clamps (31.01 → 28.02 →
 *                       31.03). Null on legacy rows — adopted from prevDueAt.
 */

export function computeNextDueAt(
	prevDueAt: Date,
	interval: number,
	completedAt: Date,
	recurrenceType: ChoreRecurrenceType = 'days',
	anchorAt?: Date | null,
): Date {
	if (!Number.isFinite(interval) || interval <= 0) {
		// One-shot / non-recurring chore: do not advance the cadence. The
		// route still rotates the assignee, so we return the existing due
		// date unchanged (acts as a no-op for the cadence stamp).
		return new Date(prevDueAt.getTime());
	}
	// A LATE completion (a later Berlin day) re-anchors the cycle on
	// completedAt (documented behavior). Early and same-day completions keep
	// the previous due so the cadence does not slide.
	const late = isLateCompletion(prevDueAt, completedAt);
	const base = toBerlinWallTime(late ? completedAt : prevDueAt);
	if (recurrenceType === 'months') {
		// Keep the stored anchor so a month-end clamp (31.01 → 28.02) does not
		// chain into a permanent day-of-month drift.
		const anchorDay = toBerlinWallTime(late ? completedAt : (anchorAt ?? prevDueAt)).day;
		const target = new Date(Date.UTC(base.year, base.month + interval, 1));
		const year = target.getUTCFullYear();
		const month = target.getUTCMonth();
		return fromBerlinWallTime({
			...base,
			year,
			month,
			day: Math.min(anchorDay, daysInMonth(year, month)),
		});
	}
	return fromBerlinWallTime({ ...base, day: base.day + interval });
}
