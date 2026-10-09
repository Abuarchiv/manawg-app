import * as dbSchema from '@/core/db';
import {
	choreCompletions,
	chores,
	db,
	memberAbsences,
	pushSubscriptions,
	wgMembers,
	wgs,
} from '@/core/db';
import { requireCronSecret } from '@/core/infra/cron-auth';
import { withCronLogging } from '@/core/infra/observability';
import { dispatchNotification } from '@/core/notifications/notification-dispatch';
import { endOfBerlinDay, startOfBerlinDay } from '@/core/utils/berlin-day';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

// Minimum gap between reminder dispatches for the same chore. The cron runs
// daily at 08:00, so 18h guarantees we never re-fire within the same day even
// if the cron is re-invoked (manual replay, retry, drift). Bumped instead of
// "calendar day" to remain robust against TZ/DST/replay edge cases.
const REMINDER_THROTTLE_MS = 18 * 60 * 60 * 1000;
const REMINDER_CLAIM_SCOPE = 'chore-reminders';
// Chores overdue for longer than this are not reminded: without a lower
// bound the candidate query would scan every chore ever due across all WGs.
const REMINDER_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// Per-run cap; throttled chores are excluded in SQL, so a larger backlog is
// drained by the following runs instead of being loaded in one go.
const REMINDER_CANDIDATE_LIMIT = 500;
// Same concurrency cap as the event-reminders cron.
const DISPATCH_BATCH_SIZE = 10;
const localReminderClaims = new Map<string, number>(); // claim key -> expiry (epoch ms)

// Keys for every reminded chore would stay resident for the lifetime of the
// process. Claims are only meaningful until the throttle window passes, so
// entries carry an expiry and are pruned at the start of every run.
function pruneLocalReminderClaims(now: number): void {
	for (const [key, expiresAt] of localReminderClaims) {
		if (expiresAt <= now) localReminderClaims.delete(key);
	}
}

interface DueChore {
	id: string;
	title: string;
	nextDueAt: Date;
	assignedMemberId: string | null;
	lastReminderAt: Date | null;
	wgId: string;
	wgName: string;
	shareCode: string;
}

type PendingChore = Omit<DueChore, 'assignedMemberId'> & { assignedMemberId: string };

function getReminderClaimTable(): typeof dbSchema.idempotencyResponses | null {
	return 'idempotencyResponses' in dbSchema ? dbSchema.idempotencyResponses : null;
}

function reminderClaimKey(choreId: string, startOfDay: Date): string {
	return `${choreId}:${startOfDay.toISOString()}`;
}

async function claimReminderDispatch(
	choreId: string,
	startOfDay: Date,
	now: Date,
): Promise<string | null> {
	const key = reminderClaimKey(choreId, startOfDay);
	const idempotencyResponses = getReminderClaimTable();
	if (!idempotencyResponses || typeof (db as { insert?: unknown }).insert !== 'function') {
		const expiresAt = localReminderClaims.get(key);
		if (expiresAt !== undefined && expiresAt > now.getTime()) return null;
		localReminderClaims.set(key, now.getTime() + REMINDER_THROTTLE_MS);
		return key;
	}

	const inserted = await db
		.insert(idempotencyResponses)
		.values({
			scope: REMINDER_CLAIM_SCOPE,
			key,
			responseBody: { choreId, reminderDay: startOfDay.toISOString() },
			expiresAt: new Date(now.getTime() + REMINDER_THROTTLE_MS),
		})
		.onConflictDoNothing()
		.returning({ key: idempotencyResponses.key });

	return inserted.length > 0 ? key : null;
}

async function releaseReminderDispatchClaim(key: string): Promise<void> {
	const idempotencyResponses = getReminderClaimTable();
	if (!idempotencyResponses || typeof (db as { delete?: unknown }).delete !== 'function') {
		localReminderClaims.delete(key);
		return;
	}

	await db
		.delete(idempotencyResponses)
		.where(
			and(eq(idempotencyResponses.scope, REMINDER_CLAIM_SCOPE), eq(idempotencyResponses.key, key)),
		);
}

export const GET = withCronLogging(
	'chore-reminders',
	async (req: NextRequest): Promise<NextResponse> => {
		const denied = requireCronSecret(req);
		if (denied) return denied;

		const now = new Date();
		pruneLocalReminderClaims(now.getTime());
		// "Today" by the Berlin wall clock, not the UTC day the server runs in —
		// otherwise chores due "today" and completions since midnight are judged
		// against a day that starts 1-2 hours late for every member.
		const startOfDay = startOfBerlinDay(now);
		const endOfDay = endOfBerlinDay(now);
		const throttleCutoff = new Date(now.getTime() - REMINDER_THROTTLE_MS);
		const lookbackStart = new Date(now.getTime() - REMINDER_LOOKBACK_MS);

		const due = (await db
			.select({
				id: chores.id,
				title: chores.title,
				nextDueAt: chores.nextDueAt,
				assignedMemberId: chores.assignedMemberId,
				lastReminderAt: chores.lastReminderAt,
				wgId: wgs.id,
				wgName: wgs.name,
				shareCode: wgs.shareCode,
			})
			.from(chores)
			.innerJoin(wgs, eq(chores.wgId, wgs.id))
			.innerJoin(wgMembers, eq(chores.assignedMemberId, wgMembers.id))
			.where(
				and(
					lte(chores.nextDueAt, endOfDay),
					gte(chores.nextDueAt, lookbackStart),
					isNotNull(chores.assignedMemberId),
					or(isNull(chores.lastReminderAt), lte(chores.lastReminderAt, throttleCutoff)),
					// Moved-out assignees are skipped entirely — the rotation
					// handles reassignment, this only guards stale reminders.
					isNull(wgMembers.deactivatedAt),
					// Only chores that can actually be delivered are candidates: an
					// assignee without push (opt-out, chores muted, no subscription)
					// never gets lastReminderAt stamped and would otherwise occupy
					// the NULLS FIRST front of the capped window forever. Mirrors
					// the eligibility checks in dispatchNotification.
					eq(wgMembers.pushOptIn, true),
					eq(wgMembers.notifyChores, true),
					sql`exists (select 1 from ${pushSubscriptions} where ${pushSubscriptions.memberId} = ${wgMembers.id})`,
					// Absent assignees keep the chore (the rotation only moves it on
					// completion) but get no push; the plan flags it for housemates.
					sql`not exists (select 1 from ${memberAbsences} where ${memberAbsences.memberId} = ${chores.assignedMemberId} and ${memberAbsences.startDate} <= ${endOfDay} and ${memberAbsences.endDate} >= ${startOfDay})`,
				),
			)
			// Rotate the capped window across daily runs: never-reminded chores
			// first, then the ones reminded longest ago, so a backlog above the
			// cap cannot keep the same oldest rows in front forever.
			.orderBy(sql`${chores.lastReminderAt} asc nulls first`, asc(chores.nextDueAt), asc(chores.id))
			.limit(REMINDER_CANDIDATE_LIMIT)) as DueChore[];

		if (due.length === 0) return NextResponse.json({ ok: true, sent: 0 });

		const completions = await db
			.select({ choreId: choreCompletions.choreId })
			.from(choreCompletions)
			.where(
				and(
					inArray(
						choreCompletions.choreId,
						due.map((item) => item.id),
					),
					gte(choreCompletions.completedAt, startOfDay),
				),
			);
		const completedToday = new Set(completions.map((item) => item.choreId));
		const pending = due.filter((item): item is PendingChore => {
			if (!item.assignedMemberId) return false;
			if (completedToday.has(item.id)) return false;
			// Throttle: skip if we already pinged the assignee within the window.
			// `lastReminderAt` is null for chores that have never been reminded —
			// those always pass through.
			if (item.lastReminderAt && item.lastReminderAt > throttleCutoff) return false;
			return true;
		});

		// Claim and dispatch in fixed-size batches so a large backlog never
		// opens hundreds of concurrent DB claims and push requests at once.
		const sentChoreIds: string[] = [];
		const failedClaimKeys: string[] = [];
		for (let index = 0; index < pending.length; index += DISPATCH_BATCH_SIZE) {
			const batch = pending.slice(index, index + DISPATCH_BATCH_SIZE);
			const claimAttempts = await Promise.all(
				batch.map(async (item) => ({
					item,
					claimKey: await claimReminderDispatch(item.id, startOfDay, now),
				})),
			);
			const claimed: Array<PendingChore & { reminderClaimKey: string }> = [];
			for (const { item, claimKey } of claimAttempts) {
				if (claimKey) claimed.push({ ...item, reminderClaimKey: claimKey });
			}

			const results = await Promise.allSettled(
				claimed.map(async (item) => {
					try {
						return await dispatchNotification({
							wg: { id: item.wgId, name: item.wgName, shareCode: item.shareCode },
							event: 'chore.due',
							payload: {
								title: item.title,
								choreId: item.id,
								nextDueAt: item.nextDueAt.toISOString(),
							},
							targetMemberIds: [item.assignedMemberId],
						});
					} catch (err) {
						console.warn('[chore-reminders] notification dispatch failed');
						return { sent: 0, failures: [err] };
					}
				}),
			);

			// Only stamp chores whose dispatch actually delivered at least one
			// push — a fulfilled promise with sent: 0 (e.g. no VAPID keys) would
			// otherwise silently swallow the reminder until the throttle window
			// passes. Failed pushes release their claim and retry next run.
			for (const [idx, item] of claimed.entries()) {
				const result = results[idx];
				if (result?.status === 'fulfilled' && result.value.sent > 0) {
					sentChoreIds.push(item.id);
				} else {
					failedClaimKeys.push(item.reminderClaimKey);
				}
			}
		}

		await Promise.all(failedClaimKeys.map((key) => releaseReminderDispatchClaim(key)));
		if (sentChoreIds.length > 0) {
			await db.update(chores).set({ lastReminderAt: now }).where(inArray(chores.id, sentChoreIds));
		}

		return NextResponse.json({ ok: true, sent: sentChoreIds.length });
	},
);
