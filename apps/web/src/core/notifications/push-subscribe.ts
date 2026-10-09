'use client';

import { apiFetch } from '@/core/infra/api-client';
import { setPushOptOut } from '@/core/notifications/push-priming';

function isStaleMembershipError(error: string): boolean {
	return (
		error === 'not_a_member' ||
		error === 'member_id_required' ||
		error === 'member_id_invalid' ||
		error === 'member_not_found'
	);
}

function isRetryableServerError(status: number, error: string): boolean {
	return (
		status >= 500 ||
		status === 429 ||
		error === 'server_error' ||
		error === 'unexpected_error' ||
		error === 'db_error'
	);
}

/** Resolves to whether another WG of this account still uses the endpoint. */
async function saveServerPushOptOut(
	code: string,
	memberId: string,
	endpoint?: string,
): Promise<boolean> {
	const encodedCode = encodeURIComponent(code);
	const saved = await apiFetch<{ ok: true; endpointInUse?: boolean }>(
		`/api/wg/${encodedCode}/notifications`,
		{
			method: endpoint ? 'POST' : 'PATCH',
			memberId,
			body: endpoint
				? JSON.stringify({ action: 'push_unsubscribe', endpoint })
				: JSON.stringify({ pushOptIn: false }),
		},
	);
	if (!saved.ok) {
		if (isStaleMembershipError(saved.error)) {
			throw new Error('Push-Abo konnte nicht deaktiviert werden: Tritt der WG erneut bei.');
		}
		if (isRetryableServerError(saved.status, saved.error)) {
			throw new Error('Push-Abo konnte nicht deaktiviert werden: Versuche es gleich erneut.');
		}
		throw new Error('Push-Abo konnte nicht deaktiviert werden.');
	}
	return saved.data?.endpointInUse === true;
}

/** Removes this WG's use of the endpoint; resolves to whether another WG still uses it. */
export async function retireWebPushEndpoint(
	code: string,
	memberId: string,
	endpoint: string,
): Promise<boolean> {
	return saveServerPushOptOut(code, memberId, endpoint);
}

/** The browser endpoint is registered for a member of another account. */
class EndpointOwnedError extends Error {}

const ENDPOINT_OWNED_MESSAGE =
	'Push-Abo konnte nicht gespeichert werden: Dieser Browser ist mit einem anderen Konto verbunden. Versuche es erneut.';

async function saveServerPushOptIn(
	code: string,
	memberId: string,
	subscription: PushSubscription,
	createdSubscription = false,
): Promise<void> {
	// `toJSON()` already returns `PushSubscriptionJSON`, so the DOM types are
	// the contract here — no cast that could silently accept a different
	// serialization shape.
	const json = subscription.toJSON();
	if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
		if (createdSubscription) await subscription.unsubscribe().catch(() => undefined);
		throw new Error('Push-Abo konnte nicht gelesen werden.');
	}

	const encodedCode = encodeURIComponent(code);
	const saved = await apiFetch<{ ok: true }>(`/api/wg/${encodedCode}/notifications`, {
		method: 'POST',
		memberId,
		body: JSON.stringify({
			action: 'push_subscribe',
			endpoint: json.endpoint,
			p256dh: json.keys.p256dh,
			authKey: json.keys.auth,
		}),
	});
	if (!saved.ok) {
		if (createdSubscription) await subscription.unsubscribe().catch(() => undefined);
		if (saved.error === 'endpoint_owned') throw new EndpointOwnedError(ENDPOINT_OWNED_MESSAGE);
		if (saved.error === 'push_subscription_invalid') {
			throw new Error('Push-Abo konnte nicht gespeichert werden: Aktiviere Web Push neu.');
		}
		if (isStaleMembershipError(saved.error)) {
			throw new Error('Push-Abo konnte nicht gespeichert werden: Tritt der WG erneut bei.');
		}
		if (isRetryableServerError(saved.status, saved.error)) {
			throw new Error('Push-Abo konnte nicht gespeichert werden: Versuche es gleich erneut.');
		}
		throw new Error('Push-Abo konnte nicht gespeichert werden.');
	}
}

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = window.atob(base64);
	const output = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; i++) {
		output[i] = rawData.charCodeAt(i);
	}
	return output.buffer;
}

export function isPushSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		'Notification' in window &&
		'serviceWorker' in navigator &&
		'PushManager' in window
	);
}

export interface PushDeviceState {
	supported: boolean;
	permission: NotificationPermission | null;
	/** This browser holds a live PushSubscription (the server flag is per member, not per device). */
	hasSubscription: boolean;
}

export async function readPushDeviceState(): Promise<PushDeviceState> {
	if (!isPushSupported()) return { supported: false, permission: null, hasSubscription: false };
	const permission = Notification.permission;
	try {
		const registration = await navigator.serviceWorker.getRegistration();
		const subscription = await registration?.pushManager.getSubscription();
		return { supported: true, permission, hasSubscription: !!subscription };
	} catch {
		return { supported: true, permission, hasSubscription: false };
	}
}

export async function persistExistingWebPushSubscription(
	code: string,
	memberId: string,
	subscription: PushSubscription,
): Promise<void> {
	await saveServerPushOptIn(code, memberId, subscription, false);
}

export async function subscribeWebPush(code: string, memberId: string): Promise<void> {
	if (!isPushSupported()) {
		throw new Error('Push wird von diesem Browser nicht unterstützt.');
	}
	const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
	if (!vapidKey) {
		throw new Error('Push ist noch nicht konfiguriert.');
	}
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') {
		throw new Error('Benachrichtigungen wurden nicht erlaubt.');
	}

	const registration = await navigator.serviceWorker.ready;
	const existing = await registration.pushManager.getSubscription();
	let createdSubscription = false;
	let subscription = existing;
	if (!subscription) {
		subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToArrayBuffer(vapidKey),
		});
		createdSubscription = true;
	}
	try {
		await saveServerPushOptIn(code, memberId, subscription, createdSubscription);
	} catch (err) {
		// A reused subscription may belong to another account on this browser;
		// a fresh endpoint proves ownership, so retry once with a new one.
		if (!(err instanceof EndpointOwnedError) || createdSubscription) throw err;
		await subscription.unsubscribe().catch(() => undefined);
		const fresh = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToArrayBuffer(vapidKey),
		});
		await saveServerPushOptIn(code, memberId, fresh, true);
	}
	setPushOptOut(memberId, false);
}

export async function unsubscribeWebPush(code: string, memberId: string): Promise<void> {
	await removeWebPush(code, memberId);
	// Remember the choice so neither the silent resubscribe nor the settings
	// reconcile turns Web Push back on (the browser permission stays granted).
	setPushOptOut(memberId, true);
}

async function removeWebPush(code: string, memberId: string): Promise<void> {
	if (!('serviceWorker' in navigator) || !navigator.serviceWorker) {
		await saveServerPushOptOut(code, memberId, undefined);
		return;
	}
	const registration = await navigator.serviceWorker.ready;
	const subscription = await registration.pushManager.getSubscription();
	const endpoint = subscription?.endpoint;
	if (!endpoint) {
		// Without a PATCH: it wipes the subscriptions of this member's other devices.
		// Only browsers that cannot subscribe at all have nothing else to clean up.
		if (!isPushSupported()) await saveServerPushOptOut(code, memberId, undefined);
		return;
	}

	// The browser subscription is shared by every WG of this account on this
	// device: drop it only after the server confirmed no other WG still uses it.
	// A failed server call keeps it, so other WGs keep receiving pushes.
	const endpointInUse = await retireWebPushEndpoint(code, memberId, endpoint);
	if (!endpointInUse) await subscription.unsubscribe().catch(() => undefined);
}
