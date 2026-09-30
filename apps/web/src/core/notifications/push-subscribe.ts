'use client';

import { apiFetch } from '@/core/infra/api-client';

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
		error === 'server_error' ||
		error === 'unexpected_error' ||
		error === 'db_error'
	);
}

async function saveServerPushOptOut(
	code: string,
	memberId: string,
	endpoint?: string,
	memberToken?: string,
): Promise<void> {
	const encodedCode = encodeURIComponent(code);
	const saved = await apiFetch<{ ok: true }>(`/api/wg/${encodedCode}/notifications`, {
		method: endpoint ? 'POST' : 'PATCH',
		memberId,
		memberToken,
		body: endpoint
			? JSON.stringify({ action: 'push_unsubscribe', endpoint })
			: JSON.stringify({ pushOptIn: false }),
	});
	if (!saved.ok) {
		if (isStaleMembershipError(saved.error)) {
			throw new Error('Push-Abo konnte nicht deaktiviert werden: Tritt der WG erneut bei.');
		}
		if (isRetryableServerError(saved.status, saved.error)) {
			throw new Error('Push-Abo konnte nicht deaktiviert werden: Versuche es gleich erneut.');
		}
		throw new Error('Push-Abo konnte nicht deaktiviert werden.');
	}
}

/** Remove one browser endpoint without changing the member's other devices. */
export async function retireWebPushEndpoint(
	code: string,
	memberId: string,
	endpoint: string,
	memberToken?: string,
): Promise<void> {
	await saveServerPushOptOut(code, memberId, endpoint, memberToken);
}

async function saveServerPushOptIn(
	code: string,
	memberId: string,
	subscription: PushSubscription,
	createdSubscription = false,
	memberToken?: string,
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
		memberToken,
		body: JSON.stringify({
			action: 'push_subscribe',
			endpoint: json.endpoint,
			p256dh: json.keys.p256dh,
			authKey: json.keys.auth,
		}),
	});
	if (!saved.ok) {
		if (createdSubscription) await subscription.unsubscribe().catch(() => undefined);
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

function isPushSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		'Notification' in window &&
		'serviceWorker' in navigator &&
		'PushManager' in window
	);
}

export async function persistExistingWebPushSubscription(
	code: string,
	memberId: string,
	subscription: PushSubscription,
	memberToken?: string,
): Promise<void> {
	await saveServerPushOptIn(code, memberId, subscription, false, memberToken);
}

export async function subscribeWebPush(
	code: string,
	memberId: string,
	memberToken?: string,
): Promise<void> {
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
	await saveServerPushOptIn(code, memberId, subscription, createdSubscription, memberToken);
}

export async function unsubscribeWebPush(
	code: string,
	memberId: string,
	memberToken?: string,
): Promise<void> {
	if (!('serviceWorker' in navigator) || !navigator.serviceWorker) {
		await saveServerPushOptOut(code, memberId, undefined, memberToken);
		return;
	}
	const registration = await navigator.serviceWorker.ready;
	const subscription = await registration.pushManager.getSubscription();
	const endpoint = subscription?.endpoint;
	if (!endpoint) {
		await saveServerPushOptOut(code, memberId, undefined, memberToken);
		return;
	}

	try {
		await retireWebPushEndpoint(code, memberId, endpoint, memberToken);
	} finally {
		await subscription.unsubscribe().catch(() => undefined);
	}
}
