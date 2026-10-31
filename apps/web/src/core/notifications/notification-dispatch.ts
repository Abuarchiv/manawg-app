import { Agent } from 'node:https';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, pushSubscriptions, wgMembers } from '@/core/db';
import { captureException, logApiError } from '@/core/infra/observability';
import { isQuietHoursActive } from '@/core/notifications/notification-preferences';
import {
	formatNotificationMessage,
	type NotificationEvent,
	type NotificationMessage,
	notificationCategoryForEvent,
	notificationPriorityForEvent,
} from '@/core/notifications/notifications';
import {
	isInvalidSubscriptionKeyError,
	isTransientWebPushError,
	parseWebPushStatusCode,
} from '@/core/notifications/web-push-errors';
import type { Locale } from '@/shared/i18n/locale';

export interface DispatchInput {
	wg: { id: string; name: string; shareCode: string };
	event: NotificationEvent;
	payload: Record<string, unknown>;
	targetMemberIds?: string[];
	excludeMemberId?: string;
	/** More members to skip, e.g. those already notified directly about the same event. */
	excludeMemberIds?: readonly string[];
	bypassPreferences?: boolean;
	/** Delivers through quiet hours, e.g. a change to an event that starts within a day. */
	urgent?: boolean;
}

export type NotificationDispatchWarning =
	| null
	| 'notification_delivery_failed'
	| 'notification_delivery_unknown';

export interface DispatchNotificationSafelyOptions {
	timeoutMs?: number;
	dispatch?: typeof dispatchNotification;
}

interface WebPushResult {
	sent: number;
	failures: unknown[];
}

const PUSH_RETRY_DELAYS_MS = [100, 300] as const;
/**
 * Pauses before a 404/410 ("subscription gone") is believed. FCM answers 410 for a subscription it
 * issued only seconds ago until it has propagated (measured up to about 6 s), and now and then once
 * for an older one; removing the subscription then would silently end push for that device.
 */
const PUSH_GONE_CONFIRM_DELAYS_MS = [1_500] as const;
const NEW_SUBSCRIPTION_GONE_DELAYS_MS = [1_000, 2_000, 4_000] as const;
/** A subscription this young is never removed for 404/410, only reported as a failed delivery. */
const NEW_SUBSCRIPTION_GRACE_MS = 2 * 60_000;
// Fan-out is chunked instead of firing every member's push at once: large
// WGs would otherwise open one burst of connections and risk provider rate
// limits. WG membership is capped, so batches stay small either way.
const PUSH_BATCH_SIZE = 10;
const PUSH_BATCH_DELAY_MS = 250;

async function mapInBatches<T, R>(
	items: readonly T[],
	batchSize: number,
	fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = [];
	for (let start = 0; start < items.length; start += batchSize) {
		const batch = items.slice(start, start + batchSize);
		results.push(...(await Promise.allSettled(batch.map(fn))));
		if (start + batchSize < items.length) {
			await new Promise((resolve) => setTimeout(resolve, PUSH_BATCH_DELAY_MS));
		}
	}
	return results;
}

/**
 * Same-origin path for the notification click. The service worker resolves it
 * against its own origin; an absolute URL built from the configured app URL
 * opened only `/` whenever that URL differed from the origin the app runs on.
 */
function buildNotificationUrl(shareCode: string, urlPath: string): string {
	const normalizedPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
	return `/wg/${encodeURIComponent(shareCode)}${normalizedPath}`;
}

const SECONDS_PER_HOUR = 60 * 60;
/**
 * How long the push service keeps an undelivered message. web-push defaults to
 * four weeks, so a phone back online after days got "Termin heute" for a past
 * day. Due-today reminders expire sooner than ordinary activity.
 */
const PUSH_TTL_SECONDS: Record<'urgent' | 'normal', number> = {
	urgent: 12 * SECONDS_PER_HOUR,
	normal: 24 * SECONDS_PER_HOUR,
};
/** A push service that does not answer by then is treated as a failed delivery. */
const PUSH_REQUEST_TIMEOUT_MS = 10_000;
/**
 * Node gives each address of the push service 250 ms to connect before trying the next one; on a
 * host without IPv6 and a slow first packet (Docker Desktop, home servers) every attempt can expire
 * and the push fails with ETIMEDOUT although the service is reachable.
 */
const pushAgent = new Agent({ autoSelectFamilyAttemptTimeout: 2_000 });

/** Quiet-hour settings are WG-local and use the same Berlin calendar zone as
 * recurrence and reminders. Never depend on the host process timezone. */
function berlinCurrentHour(now = new Date()): number {
	const hour = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Berlin',
		hour: '2-digit',
		hourCycle: 'h23',
	})
		.formatToParts(now)
		.find((part) => part.type === 'hour')?.value;
	return hour ? Number(hour) : 0;
}

/** The contact the push services reach for abuse; null in development and tests, where push is skipped. */
function resolveVapidSubject(): string | null {
	const subject = process.env.VAPID_SUBJECT?.trim();
	if (subject) return subject;
	if (process.env.NODE_ENV === 'production') {
		throw new Error('VAPID_SUBJECT must be configured in production');
	}
	return null;
}

async function configureWebPush(): Promise<typeof import('web-push') | null> {
	const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
	const privateKey = process.env.VAPID_PRIVATE_KEY;
	if (!publicKey || !privateKey) return null;
	const subject = resolveVapidSubject();
	if (!subject) return null;
	const webPush = await import('web-push');
	webPush.setVapidDetails(subject, publicKey, privateKey);
	return webPush;
}

async function sendWebPush(
	memberId: string,
	payload: { title: string; body: string; url: string },
	priority: 'urgent' | 'normal',
): Promise<WebPushResult> {
	const webPush = await configureWebPush();
	if (!webPush) return { sent: 0, failures: [] };
	const subs = await db
		.select()
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.memberId, memberId));
	let sent = 0;
	// Stale subscriptions are collected first and deleted in ONE statement
	// after the fan-out below. Deleting inside the concurrent callbacks made
	// the follow-up pushOptIn check race against deletions that had not
	// committed yet.
	const staleSubscriptionIds: string[] = [];
	const failures: unknown[] = [];

	await Promise.allSettled(
		subs.map(async (sub) => {
			const isNew = Date.now() - sub.createdAt.getTime() < NEW_SUBSCRIPTION_GRACE_MS;
			try {
				for (let attempt = 0; ; attempt += 1) {
					try {
						await webPush.sendNotification(
							{
								endpoint: sub.endpoint,
								keys: { p256dh: sub.p256dh, auth: sub.authKey },
							},
							JSON.stringify({
								title: payload.title,
								body: payload.body,
								url: payload.url,
								icon: '/icon-192.png',
							}),
							{
								TTL: PUSH_TTL_SECONDS[priority],
								urgency: priority === 'urgent' ? 'high' : 'normal',
								timeout: PUSH_REQUEST_TIMEOUT_MS,
								agent: pushAgent,
							},
						);
						sent += 1;
						break;
					} catch (err) {
						const statusCode = parseWebPushStatusCode(err);
						const delays: readonly number[] =
							statusCode === 404 || statusCode === 410
								? isNew
									? NEW_SUBSCRIPTION_GONE_DELAYS_MS
									: PUSH_GONE_CONFIRM_DELAYS_MS
								: isTransientWebPushError(err)
									? PUSH_RETRY_DELAYS_MS
									: [];
						if (attempt >= delays.length) throw err;
						await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
					}
				}
			} catch (err) {
				const statusCode = parseWebPushStatusCode(err);
				const gone = (statusCode === 404 || statusCode === 410) && !isNew;
				if (gone || isInvalidSubscriptionKeyError(err)) {
					staleSubscriptionIds.push(sub.id);
				} else {
					failures.push(err);
					logApiError('[notifications] web push failed', err);
				}
			}
		}),
	);

	const deletedStaleSubscription = staleSubscriptionIds.length > 0;
	if (deletedStaleSubscription) {
		// Single batched delete, strictly after every push attempt settled.
		await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, staleSubscriptionIds));
		const remainingSubscriptions = await db
			.select({ id: pushSubscriptions.id })
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.memberId, memberId));
		if (remainingSubscriptions.length === 0) {
			await db
				.update(wgMembers)
				.set({
					pushOptIn: sql<boolean>`exists (
						select 1
						from ${pushSubscriptions}
						where ${pushSubscriptions.memberId} = ${memberId}
					)`,
				})
				.where(eq(wgMembers.id, memberId));
		}
	}

	return { sent, failures };
}

export class NoPushSubscriptionError extends Error {
	constructor() {
		super('no_push_subscription');
		this.name = 'NoPushSubscriptionError';
	}
}

export async function dispatchNotification(
	input: DispatchInput,
): Promise<{ sent: number; failures: unknown[] }> {
	if (input.targetMemberIds?.length === 0) return { sent: 0, failures: [] };

	const rows = await db
		.select({
			id: wgMembers.id,
			deactivatedAt: wgMembers.deactivatedAt,
			pushOptIn: wgMembers.pushOptIn,
			notifyAnnouncements: wgMembers.notifyAnnouncements,
			notifyChores: wgMembers.notifyChores,
			notifyExpenses: wgMembers.notifyExpenses,
			notifyShopping: wgMembers.notifyShopping,
			notifyInventory: wgMembers.notifyInventory,
			notifyReminders: wgMembers.notifyReminders,
			notifyChat: wgMembers.notifyChat,
			notifyEvents: wgMembers.notifyEvents,
			quietStartHour: wgMembers.quietStartHour,
			quietEndHour: wgMembers.quietEndHour,
			locale: wgMembers.locale,
		})
		.from(wgMembers)
		.where(
			input.targetMemberIds?.length
				? and(
						eq(wgMembers.wgId, input.wg.id),
						inArray(wgMembers.id, input.targetMemberIds),
						isNull(wgMembers.deactivatedAt),
					)
				: and(eq(wgMembers.wgId, input.wg.id), isNull(wgMembers.deactivatedAt)),
		);

	// One message per distinct recipient locale (at most two), formatted on first use.
	const messages = new Map<Locale, NotificationMessage>();
	const messageFor = (locale: Locale): NotificationMessage => {
		let message = messages.get(locale);
		if (!message) {
			message = formatNotificationMessage(
				input.event,
				{ ...input.payload, wgName: input.wg.name },
				locale,
			);
			messages.set(locale, message);
		}
		return message;
	};
	const category = notificationCategoryForEvent(input.event);
	const priority = input.urgent ? 'urgent' : notificationPriorityForEvent(input.event);
	const currentHour = berlinCurrentHour();

	const targetMembers = rows
		.filter((member) => member.id !== input.excludeMemberId)
		.filter((member) => !input.excludeMemberIds?.includes(member.id))
		// Moved-out members never receive push, even when explicitly targeted.
		.filter((member) => member.deactivatedAt === null)
		.filter(
			(member) =>
				input.bypassPreferences ||
				priority === 'urgent' ||
				!isQuietHoursActive(currentHour, member.quietStartHour, member.quietEndHour),
		)
		.filter((member) => {
			if (input.bypassPreferences) return true;
			if (category === 'announcements') return member.notifyAnnouncements;
			if (category === 'chores') return member.notifyChores;
			if (category === 'expenses') return member.notifyExpenses;
			if (category === 'inventory') return member.notifyInventory;
			if (category === 'events') return member.notifyEvents;
			if (category === 'reminders') return member.notifyReminders;
			if (category === 'chat') return member.notifyChat;
			return member.notifyShopping;
		});

	const pushResults = await mapInBatches(targetMembers, PUSH_BATCH_SIZE, async (member) => {
		if (!member.pushOptIn) return { sent: 0, failures: [] };
		const message = messageFor(member.locale === 'en' ? 'en' : 'de');
		const url = buildNotificationUrl(input.wg.shareCode, message.urlPath);
		return sendWebPush(member.id, { title: message.title, body: message.body, url }, priority);
	});

	const sentTotal = pushResults
		.filter(
			(result): result is PromiseFulfilledResult<{ sent: number; failures: unknown[] }> =>
				result.status === 'fulfilled',
		)
		.reduce((total, result) => total + result.value.sent, 0);
	const failures = pushResults.flatMap((result) =>
		result.status === 'fulfilled' ? result.value.failures : [result.reason],
	);
	if (input.event === 'notification.test' && sentTotal === 0) {
		if (failures[0]) throw failures[0];
		// Push is configured, but the member has no live subscription left
		// (opted out, or the push service answered 404/410 and it was removed).
		if (
			process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
			process.env.VAPID_PRIVATE_KEY &&
			process.env.VAPID_SUBJECT?.trim()
		) {
			throw new NoPushSubscriptionError();
		}
		throw new Error('notification_delivery_failed');
	}
	return { sent: sentTotal, failures };
}

const DEFAULT_NOTIFICATION_DISPATCH_TIMEOUT_MS = 5_000;

export async function dispatchNotificationSafely(
	input: DispatchInput,
	options: DispatchNotificationSafelyOptions = {},
): Promise<{ sent: number; warning: NotificationDispatchWarning }> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(
				() => reject(new Error('notification delivery timed out')),
				options.timeoutMs ?? DEFAULT_NOTIFICATION_DISPATCH_TIMEOUT_MS,
			);
		});
		const result = await Promise.race([(options.dispatch ?? dispatchNotification)(input), timeout]);
		return {
			sent: result.sent,
			warning: result.failures.length > 0 ? 'notification_delivery_failed' : null,
		};
	} catch (err) {
		captureException(err, { action: 'dispatchNotificationSafely', event: input.event });
		return { sent: 0, warning: 'notification_delivery_unknown' };
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}
