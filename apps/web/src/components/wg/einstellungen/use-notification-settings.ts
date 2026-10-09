'use client';

import {
	notificationSaveErrorMessage,
	notificationTestErrorMessage,
} from '@/components/wg/einstellungen/settings-errors';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { apiFetch } from '@/core/infra/api-client';
import { isPushOptedOut } from '@/core/notifications/push-priming';
import {
	type PushDeviceState,
	persistExistingWebPushSubscription,
	readPushDeviceState,
	subscribeWebPush,
	unsubscribeWebPush,
} from '@/core/notifications/push-subscribe';
import {
	formatPushActivationError,
	formatPushDeactivationError,
} from '@/core/notifications/web-push-errors';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { haptic } from '@/shared/lib/haptics';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface NotificationStatus {
	pushOptIn: boolean;
	notifyAnnouncements: boolean;
	notifyChores: boolean;
	notifyExpenses: boolean;
	notifyReminders: boolean;
	notifyShopping: boolean;
	notifyInventory: boolean;
	notifyChat: boolean;
	notifyEvents: boolean;
	quietStartHour: number | null;
	quietEndHour: number | null;
	pushConfigured: boolean;
}

export type NotificationPreferenceKey =
	| 'notifyAnnouncements'
	| 'notifyChores'
	| 'notifyExpenses'
	| 'notifyReminders'
	| 'notifyShopping'
	| 'notifyInventory'
	| 'notifyChat'
	| 'notifyEvents';

export const NOTIFICATION_PREFERENCES: ReadonlyArray<{
	key: NotificationPreferenceKey;
	label: string;
	description?: string;
}> = [
	{ key: 'notifyAnnouncements', label: 'Pinnwand' },
	{ key: 'notifyChores', label: 'Putzplan' },
	{ key: 'notifyExpenses', label: 'Ausgaben' },
	{ key: 'notifyReminders', label: 'Erinnerungen', description: 'Erinnerung an offene Beträge' },
	{ key: 'notifyShopping', label: 'Einkäufe' },
	{ key: 'notifyInventory', label: 'Vorräte', description: 'Wenn etwas bald leer ist' },
	{ key: 'notifyChat', label: 'Chat' },
	{ key: 'notifyEvents', label: 'Kalender' },
];

interface NotificationSettingsInput {
	code: string;
	memberId: string;
}

/**
 * Notification settings of the member: push subscription, per-area switches and quiet hours.
 * One request at a time; each change carries an idempotency key that survives a retry.
 */
export function useNotificationSettings({ code, memberId }: NotificationSettingsInput) {
	const [status, setStatus] = useState<NotificationStatus | null>(null);
	const [pending, setPending] = useState<'push' | 'save' | 'test' | null>(null);
	const [pushTarget, setPushTarget] = useState<boolean | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadingStatus, setLoadingStatus] = useState(true);
	const [device, setDevice] = useState<PushDeviceState | null>(null);
	const pendingRef = useRef(false);
	const notificationRequestKeysRef = useRef(new Map<string, string>());
	const loadStatusRequestIdRef = useRef(0);
	const pushResyncAttemptedKeyRef = useRef<string | null>(null);
	const encodedCode = encodeURIComponent(code);

	const loadStatus = useCallback(async (): Promise<void> => {
		const requestId = loadStatusRequestIdRef.current + 1;
		loadStatusRequestIdRef.current = requestId;
		setLoadingStatus(true);
		const res = await apiFetch<NotificationStatus>(`/api/wg/${encodedCode}/notifications`, {
			memberId,
		});
		if (requestId !== loadStatusRequestIdRef.current) return;

		if (res.ok) {
			setStatus(res.data);
			setError(null);
		} else {
			setStatus(null);
			setError(
				getWgLoadErrorMessage('Benachrichtigungen', res.status, res.error, {
					verb: 'konnten',
				}),
			);
		}
		setLoadingStatus(false);
	}, [encodedCode, memberId]);

	useEffect(() => {
		void loadStatus();
	}, [loadStatus]);

	const refreshDevice = useCallback(async (): Promise<void> => {
		setDevice(await readPushDeviceState());
	}, []);

	useEffect(() => {
		void refreshDevice();
	}, [refreshDevice]);

	// Reconcile server opt-in when the browser still has a live push subscription.
	useEffect(() => {
		let cancelled = false;
		async function syncPushSubscriptionState(): Promise<void> {
			if (status?.pushOptIn !== false) return;
			// An explicit "off" on this device must not be undone by a subscription another WG keeps.
			if (isPushOptedOut(memberId)) return;
			const resyncKey = `${code}:${memberId}`;
			if (pushResyncAttemptedKeyRef.current === resyncKey) return;
			pushResyncAttemptedKeyRef.current = resyncKey;
			if (typeof window === 'undefined') return;
			if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
			let subscription: PushSubscription | null = null;
			try {
				const registration = await navigator.serviceWorker.getRegistration();
				if (!registration) return;
				const sub = await registration.pushManager.getSubscription();
				if (cancelled) return;
				if (!sub) return;
				subscription = sub;
			} catch {
				return;
			}
			if (!subscription) return;
			try {
				await persistExistingWebPushSubscription(code, memberId, subscription);
				if (cancelled) return;
				setStatus((prev) =>
					prev && prev.pushOptIn === false ? { ...prev, pushOptIn: true } : prev,
				);
			} catch (err) {
				if (!cancelled) setError(formatPushActivationError(err));
			}
		}
		void syncPushSubscriptionState();
		return () => {
			cancelled = true;
		};
	}, [code, memberId, status?.pushOptIn]);

	async function activatePush() {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending('push');
		setError(null);
		setMessage(null);
		try {
			await subscribeWebPush(code, memberId);
			setStatus((prev) => (prev ? { ...prev, pushOptIn: true } : prev));
			setMessage('Web Push ist aktiv.');
		} catch (err) {
			setError(formatPushActivationError(err));
		} finally {
			pendingRef.current = false;
			setPending(null);
			void refreshDevice();
		}
	}

	async function deactivatePush() {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending('push');
		setError(null);
		setMessage(null);
		try {
			await unsubscribeWebPush(code, memberId);
			pushResyncAttemptedKeyRef.current = `${code}:${memberId}`;
			setStatus((prev) => (prev ? { ...prev, pushOptIn: false } : prev));
			setMessage('Web Push ist deaktiviert.');
		} catch (err) {
			setError(formatPushDeactivationError(err));
		} finally {
			pendingRef.current = false;
			setPending(null);
			void refreshDevice();
		}
	}

	/** Optimistic PATCH of some preferences; rolls back to `previous` when the server refuses. */
	async function patchPreferences(
		body: Partial<NotificationStatus>,
		previous: NotificationStatus,
		keyUnavailableMessage: string,
	): Promise<void> {
		pendingRef.current = true;
		setPending('save');
		setError(null);
		setMessage(null);
		const requestKeyId = `patch:${JSON.stringify(body)}`;
		const idempotencyKey =
			notificationRequestKeysRef.current.get(requestKeyId) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			pendingRef.current = false;
			setPending(null);
			setError(keyUnavailableMessage);
			return;
		}
		notificationRequestKeysRef.current.set(requestKeyId, idempotencyKey);
		try {
			setStatus({ ...previous, ...body });
			const res = await apiFetch<{ ok: true }>(`/api/wg/${encodedCode}/notifications`, {
				method: 'PATCH',
				memberId,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				if (res.status > 0 && res.status < 500) {
					notificationRequestKeysRef.current.delete(requestKeyId);
				}
				setStatus(previous);
				setError(notificationSaveErrorMessage(res.status, res.error));
			} else {
				notificationRequestKeysRef.current.delete(requestKeyId);
			}
		} finally {
			pendingRef.current = false;
			setPending(null);
		}
	}

	async function togglePreference(key: NotificationPreferenceKey): Promise<void> {
		if (!status || pendingRef.current) return;
		haptic('selection');
		await patchPreferences(
			{ [key]: !status[key] },
			status,
			'Einstellung konnte nicht sicher gespeichert werden. Versuche es erneut.',
		);
	}

	async function saveQuietHours(startHour: number | null, endHour: number | null): Promise<void> {
		if (!status || pendingRef.current) return;
		if (startHour !== null && startHour === endHour) {
			setError('Start und Ende der Ruhezeit dürfen nicht gleich sein.');
			return;
		}
		await patchPreferences(
			{ quietStartHour: startHour, quietEndHour: endHour },
			status,
			'Ruhezeit konnte nicht sicher gespeichert werden. Versuche es erneut.',
		);
	}

	async function sendTestNotification(): Promise<void> {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending('test');
		setError(null);
		setMessage(null);
		const requestKeyId = 'test_notification';
		const idempotencyKey =
			notificationRequestKeysRef.current.get(requestKeyId) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			pendingRef.current = false;
			setPending(null);
			setError('Test konnte nicht sicher gesendet werden. Versuche es erneut.');
			return;
		}
		notificationRequestKeysRef.current.set(requestKeyId, idempotencyKey);
		try {
			const res = await apiFetch<{ ok: true }>(`/api/wg/${encodedCode}/notifications`, {
				method: 'POST',
				memberId,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ action: 'test_notification' }),
			});
			if (res.ok) {
				notificationRequestKeysRef.current.delete(requestKeyId);
				setMessage('Test wurde ausgelöst. Prüfe, ob die Push-Nachricht ankommt.');
			} else {
				if (res.status > 0 && res.status < 500) {
					notificationRequestKeysRef.current.delete(requestKeyId);
				}
				setError(notificationTestErrorMessage(res.status, res.error));
			}
		} catch {
			setError(notificationTestErrorMessage(0, 'Netzwerkfehler'));
		} finally {
			pendingRef.current = false;
			setPending(null);
		}
	}

	/** The switch thumb moves at once; after the browser prompt the real state counts. */
	function setPushEnabled(checked: boolean): void {
		if (pendingRef.current) return;
		setPushTarget(checked);
		void (checked ? activatePush() : deactivatePush()).finally(() => setPushTarget(null));
	}

	// The server flag belongs to the member; only a live subscription means this device gets pushes.
	const pushActive = !!status?.pushOptIn && (device === null || device.hasSubscription);
	const pushBlocked = device?.permission === 'denied';

	return {
		status,
		pushActive,
		pushBlocked,
		pending,
		pushTarget,
		message,
		error,
		loadingStatus,
		loadStatus,
		setPushEnabled,
		togglePreference,
		saveQuietHours,
		sendTestNotification,
	};
}
