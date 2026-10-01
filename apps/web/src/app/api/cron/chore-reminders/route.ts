import * as dbSchema from '@/core/db';
import { choreCompletions, chores, db, wgMembers, wgs } from '@/core/db';
import { verifyCronSecret } from '@/core/infra/cron-auth';
import { withCronLogging } from '@/core/infra/observability';
import { dispatchNotification } from '@/core/notifications/notification-dispatch';
import { endOfBerlinDay, startOfBerlinDay } from '@/core/utils/berlin-day';
import { MS_PER_DAY } from '@/core/utils/time';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

// Minimum gap between reminder dispatches for the same chore. The cron runs
// daily at 08:00, so 18h guarantees we never re-fire within the same day even
// if the cron is re-invoked (manual replay, retry, drift). Bumped instead of
// "calendar day" to remain robust against TZ/DST/replay edge cases.
const REMINDER_THROTTLE_MS = 18 * 60 * 60 * 1000;
const REMINDER_CLAIM_SCOPE = 'chore-reminders';
// Reminders only cover chores that became due in the last few Berlin days.
// Without a lower bound every chore that ever went overdue in every WG is
// loaded on each run, and a deep backlog would starve the freshly-due chores
// behind it once the candidate cap is reached.
const REMINDER_LOOKBACK_DAYS = 7;
// Hard cap on candidates per run — bounds the claim inserts and the push
// fan-out so a large backlog cannot exhaust the serverless duration budget.
const MAX_REMINDER_CANDIDATES = 500;
// One dispatch runs its own member query plus a provider-rate-limited push
// burst, so fan-out runs in blocks of 10 like the sibling event-reminders cron.
const DISPATCH_BATCH_SIZE = 10;
const localReminderClaims = new Map<string, number>(); // claim key -> expiry (epoch ms)

// The Set used to grow forever: keys for every chore ever reminded stayed
// resident for the lifetime of the process. Claims are only meaningful until
// the throttle window passes, so entries carry an expiry and are pruned at
// the start of every run.
function pruneLocalReminderClaims(now: number): void {
	for (const [key, expiresAt] of localReminderClaims) {
		if (expiresAt <= now) localReminderClaims.delete(key);
	}
}

interface DueChore {
	id: string;
	title: string;
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

/** Run `fn` over `items` in blocks of DISPATCH_BATCH_SIZE, preserving order. */
async function dispatchInBatches<T, R>(
	items: readonly T[],
	fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = [];
	for (let start = 0; start < items.length; start += DISPATCH_BATCH_SIZE) {
		const batch = items.slice(start, start + DISPATCH_BATCH_SIZE);
		results.push(...(await Promise.allSettled(batch.map(fn))));
	}
	return results;
}

export const GET = withCronLogging(
	'chore-reminders',
	async (req: NextRequest): Promise<NextResponse> => {
		const secret = process.env.CRON_SECRET;
		// Fail CLOSED: without CRON_SECRET set, the endpoint is world-callable —
		// anyone can enumerate WGs and trigger N notifications. Previously the
		// `secret && ...` short-circuit silently skipped auth when the env var
		// was missing.
		if (!secret) {
			return new NextResponse('cron_secret_missing', { status: 503 });
		}
		if (!verifyCronSecret(req.headers.get('authorization'), secret)) {
			return new NextResponse('unauthorized', { status: 401 });
		}

		const now = new Date();
		pruneLocalReminderClaims(now.getTime());
		// "Today" by the Berlin wall clock, not the UTC day the server runs in —
		// otherwise chores due "today" and completions since midnight are judged
		// against a day that starts 1-2 hours late for every member.
		const startOfDay = startOfBerlinDay(now);
		const endOfDay = endOfBerlinDay(now);
		const throttleCutoff = new Date(now.getTime() - REMINDER_THROTTLE_MS);
		// Aligned to Berlin midnight so the window is whole calendar days.
		const lookbackFloor = new Date(
			startOfDay.getTime() - (REMINDER_LOOKBACK_DAYS - 1) * MS_PER_DAY,
		);

		const due = (await db
			.select({
				id: chores.id,
				title: chores.title,
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
					// Lower bound: an ancient backlog must not be re-loaded (and
					// re-pushed) on every run — it would crowd out the freshly-due
					// chores behind it once the candidate cap is reached.
					gte(chores.nextDueAt, lookbackFloor),
					isNotNull(chores.assignedMemberId),
					// Moved-out assignees are skipped entirely — the rotation
					// handles reassignment, this only guards stale reminders.
					isNull(wgMembers.deactivatedAt),
				),
			)
			// Oldest first, so the cap keeps the most overdue chores.
			.orderBy(asc(chores.nextDueAt))
			.limit(MAX_REMINDER_CANDIDATES)) as DueChore[];

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

		const claimAttempts = await Promise.all(
			pending.map(async (item) => ({
				item,
				claimKey: await claimReminderDispatch(item.id, startOfDay, now),
			})),
		);
		const claimed: Array<(typeof pending)[number] & { reminderClaimKey: string }> = [];
		for (const { item, claimKey } of claimAttempts) {
			if (claimKey) claimed.push({ ...item, reminderClaimKey: claimKey });
		}

		const results = await dispatchInBatches(claimed, async (item) => {
			try {
				return await dispatchNotification({
					wg: { id: item.wgId, name: item.wgName, shareCode: item.shareCode },
					event: 'chore.due',
					payload: { title: item.title, choreId: item.id },
					targetMemberIds: [item.assignedMemberId],
				});
			} catch (err) {
				console.warn('[chore-reminders] notification dispatch failed');
				return { sent: 0, failures: [err] };
			}
		});

		// Only stamp chores whose dispatch actually delivered at least one
		// push — a fulfilled promise with sent: 0 (e.g. no VAPID keys) would
		// otherwise silently swallow the reminder until the throttle window
		// passes. Failed pushes release their claim and retry next run.
		const delivered = claimed
			.map((item, idx) => {
				const result = results[idx];
				if (result?.status !== 'fulfilled') return null;
				return { item, sent: result.value.sent };
			})
			.filter((entry): entry is { item: (typeof claimed)[number]; sent: number } => entry !== null);
		const sentChoreIds = delivered.filter((entry) => entry.sent > 0).map((entry) => entry.item.id);
		const failedClaimKeys = [
			...claimed
				.filter((_, idx) => results[idx]?.status === 'rejected')
				.map((item) => item.reminderClaimKey),
			...delivered.filter((entry) => entry.sent === 0).map((entry) => entry.item.reminderClaimKey),
		];
		await Promise.all(failedClaimKeys.map((key) => releaseReminderDispatchClaim(key)));
		if (sentChoreIds.length > 0) {
			await db.update(chores).set({ lastReminderAt: now }).where(inArray(chores.id, sentChoreIds));
		}

		return NextResponse.json({ ok: true, sent: sentChoreIds.length });
	},
);
