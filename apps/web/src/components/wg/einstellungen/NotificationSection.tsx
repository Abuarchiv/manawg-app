'use client';

import { Switch } from '@/components/animate-ui/components/base/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Section } from '@/components/wg/einstellungen/Section';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import {
	notificationSaveErrorMessage,
	notificationTestErrorMessage,
} from '@/core/guards/settings-errors';
import { apiFetch } from '@/core/infra/api-client';
import { parseQuietHour } from '@/core/notifications/notification-preferences';
import {
	persistExistingWebPushSubscription,
	subscribeWebPush,
	unsubscribeWebPush,
} from '@/core/notifications/push-subscribe';
import {
	formatPushActivationError,
	formatPushDeactivationError,
} from '@/core/notifications/web-push-errors';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { haptic } from '@/shared/lib/haptics';
import { Bell, CheckCircle2, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
	value: hour,
	label: `${String(hour).padStart(2, '0')}:00`,
}));

interface NotificationStatus {
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

type NotificationPreferenceKey =
	| 'notifyAnnouncements'
	| 'notifyChores'
	| 'notifyExpenses'
	| 'notifyReminders'
	| 'notifyShopping'
	| 'notifyInventory'
	| 'notifyChat'
	| 'notifyEvents';

const NOTIFICATION_PREFERENCES: ReadonlyArray<{
	key: NotificationPreferenceKey;
	label: string;
	description: string;
}> = [
	{
		key: 'notifyAnnouncements',
		label: 'Pinnwand',
		description: 'Beiträge, Antworten, Reaktionen und geklärte Sachen',
	},
	{ key: 'notifyChores', label: 'Putzplan', description: 'Fällige Aufgaben und Erinnerungen' },
	{ key: 'notifyExpenses', label: 'Ausgaben', description: 'Neue gemeinsame Kosten' },
	{
		key: 'notifyReminders',
		label: 'Erinnerungen',
		description: 'Wenn dich jemand an einen offenen Betrag erinnert',
	},
	{ key: 'notifyShopping', label: 'Einkäufe', description: 'Neue Einträge auf der Einkaufsliste' },
	{ key: 'notifyInventory', label: 'Vorräte', description: 'Niedrige Vorratsbestände' },
	{ key: 'notifyChat', label: 'Chat', description: 'Neue Nachrichten und Erwähnungen' },
	{ key: 'notifyEvents', label: 'Kalender', description: 'Kalendertermine und Erinnerungen' },
];

export function NotificationSection({
	code,
	memberId,
	memberToken,
}: {
	code: string;
	memberId: string;
	memberToken?: string | undefined;
}) {
	const [status, setStatus] = useState<NotificationStatus | null>(null);
	const [pending, setPending] = useState<'push' | 'save' | 'test' | null>(null);
	const [pushTarget, setPushTarget] = useState<boolean | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadingStatus, setLoadingStatus] = useState(true);
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

	// Reconcile server opt-in when the browser still has a live push subscription.
	useEffect(() => {
		let cancelled = false;
		async function syncPushSubscriptionState(): Promise<void> {
			if (status?.pushOptIn !== false) return;
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
				await persistExistingWebPushSubscription(code, memberId, subscription, memberToken);
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
	}, [code, memberId, memberToken, status?.pushOptIn]);

	async function activatePush() {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending('push');
		setError(null);
		setMessage(null);
		try {
			await subscribeWebPush(code, memberId, memberToken);
			setStatus((prev) => (prev ? { ...prev, pushOptIn: true } : prev));
			setMessage('Web Push ist aktiv.');
		} catch (err) {
			setError(formatPushActivationError(err));
		} finally {
			pendingRef.current = false;
			setPending(null);
		}
	}

	async function deactivatePush() {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending('push');
		setError(null);
		try {
			await unsubscribeWebPush(code, memberId, memberToken);
			setStatus((prev) => (prev ? { ...prev, pushOptIn: false } : prev));
			setMessage('Web Push ist deaktiviert.');
		} catch (err) {
			setError(formatPushDeactivationError(err));
		} finally {
			pendingRef.current = false;
			setPending(null);
		}
	}

	async function togglePreference(key: NotificationPreferenceKey): Promise<void> {
		if (!status || pendingRef.current) return;
		haptic('selection');
		pendingRef.current = true;
		setPending('save');
		setError(null);
		const body = { [key]: !status[key] };
		const requestKeyId = `patch:${JSON.stringify(body)}`;
		const idempotencyKey =
			notificationRequestKeysRef.current.get(requestKeyId) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			pendingRef.current = false;
			setPending(null);
			setError('Einstellung konnte nicht sicher gespeichert werden. Versuche es erneut.');
			return;
		}
		notificationRequestKeysRef.current.set(requestKeyId, idempotencyKey);
		try {
			const next = !status[key];
			setStatus({ ...status, [key]: next });
			const res = await apiFetch<{ ok: true }>(`/api/wg/${encodedCode}/notifications`, {
				method: 'PATCH',
				memberId,
				memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				if (res.status > 0 && res.status < 500) {
					notificationRequestKeysRef.current.delete(requestKeyId);
				}
				setStatus(status);
				setError(notificationSaveErrorMessage(res.status, res.error));
			} else {
				notificationRequestKeysRef.current.delete(requestKeyId);
			}
		} finally {
			pendingRef.current = false;
			setPending(null);
		}
	}

	async function saveQuietHours(startHour: number | null, endHour: number | null): Promise<void> {
		if (!status || pendingRef.current) return;
		pendingRef.current = true;
		setPending('save');
		setError(null);
		const body = { quietStartHour: startHour, quietEndHour: endHour };
		const requestKeyId = `patch:${JSON.stringify(body)}`;
		const idempotencyKey =
			notificationRequestKeysRef.current.get(requestKeyId) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			pendingRef.current = false;
			setPending(null);
			setError('Ruhezeit konnte nicht sicher gespeichert werden. Versuche es erneut.');
			return;
		}
		notificationRequestKeysRef.current.set(requestKeyId, idempotencyKey);
		try {
			const previous = status;
			setStatus({ ...status, quietStartHour: startHour, quietEndHour: endHour });
			const res = await apiFetch<{ ok: true }>(`/api/wg/${encodedCode}/notifications`, {
				method: 'PATCH',
				memberId,
				memberToken,
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
				memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ action: 'test_notification' }),
			});
			if (res.ok) {
				notificationRequestKeysRef.current.delete(requestKeyId);
				setMessage('Test wurde ausgelöst. Prüfe Push und WG-Chat.');
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

	const pushActive = !!status?.pushOptIn;
	const notificationBusy = pending !== null || loadingStatus;
	const notificationControlsDisabled = !status || notificationBusy;
	const pushConfigured = status?.pushConfigured !== false;

	return (
		<Section
			id="benachrichtigungen"
			title="Benachrichtigungen"
			hint="Wähle, worüber du informiert wirst."
		>
			<div className="grid min-w-0 gap-3 p-3">
				{loadingStatus && (
					<div className="grid gap-2" aria-live="polite">
						<Skeleton className="h-11 w-full" />
						<p className="text-muted-foreground text-[12px]">Benachrichtigungen werden geladen…</p>
					</div>
				)}
				{!status && error && (
					<Alert variant="destructive">
						<AlertTitle>Laden fehlgeschlagen</AlertTitle>
						<AlertDescription>{error}</AlertDescription>
						<Button
							type="button"
							variant="outline"
							onClick={() => void loadStatus()}
							disabled={loadingStatus}
							className="mt-2"
						>
							{loadingStatus ? (
								<>
									<Spinner aria-hidden /> Lädt…
								</>
							) : (
								'Erneut laden'
							)}
						</Button>
					</Alert>
				)}
				<Field orientation="horizontal">
					<span className="border-border inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border">
						{pending === 'push' ? (
							<Spinner aria-hidden />
						) : (
							<Smartphone className="h-4 w-4" aria-hidden />
						)}
					</span>
					<FieldContent>
						<FieldTitle>
							Web Push
							{pushActive && <Bell className="text-muted-foreground h-3.5 w-3.5" aria-hidden />}
						</FieldTitle>
						<FieldDescription>
							{!pushConfigured ? 'Nicht konfiguriert' : pushActive ? 'Aktiv' : 'Aktivieren'}
						</FieldDescription>
					</FieldContent>
					<Switch
						checked={pushTarget ?? pushActive}
						disabled={notificationControlsDisabled || !pushConfigured}
						aria-busy={pending === 'push'}
						aria-label={pushActive ? 'Web Push deaktivieren' : 'Web Push aktivieren'}
						onCheckedChange={(checked) => {
							if (pendingRef.current) return;
							// Thumb gleitet sofort; nach der Browser-Abfrage zählt der echte Zustand.
							setPushTarget(checked);
							void (checked ? activatePush() : deactivatePush()).finally(() => setPushTarget(null));
						}}
					/>
				</Field>
				<Button
					type="button"
					variant="outline"
					onClick={() => void sendTestNotification()}
					disabled={notificationControlsDisabled || !pushActive}
					aria-label={
						pending === 'test'
							? 'Testbenachrichtigung wird gesendet'
							: 'Testbenachrichtigung senden'
					}
					className="justify-self-start"
				>
					{pending === 'test' && <Spinner aria-hidden />}
					Test senden
				</Button>

				<div className="min-w-0 max-w-full">
					{NOTIFICATION_PREFERENCES.map((pref, index) => (
						<div key={pref.key}>
							{index > 0 && <Separator />}
							<Field orientation="horizontal" className="min-h-[44px] py-2">
								<FieldContent>
									<FieldTitle>{pref.label}</FieldTitle>
									<FieldDescription>{pref.description}</FieldDescription>
								</FieldContent>
								<Switch
									checked={status?.[pref.key] ?? true}
									disabled={notificationControlsDisabled}
									aria-label={pref.label}
									onCheckedChange={() => void togglePreference(pref.key)}
								/>
							</Field>
						</div>
					))}
				</div>

				<div className="border-border grid min-w-0 max-w-full grid-cols-1 gap-2 border-t pt-3">
					<div className="flex min-h-[44px] items-center justify-between gap-2">
						<div className="min-w-0">
							<div className="text-foreground text-sm font-medium">Ruhezeit</div>
							<div className="text-muted-foreground text-xs">
								In dieser Zeit werden Push-Benachrichtigungen pausiert.
							</div>
						</div>
						<Button
							type="button"
							variant="ghost"
							onClick={() => void saveQuietHours(null, null)}
							disabled={notificationControlsDisabled}
						>
							Aus
						</Button>
					</div>
					<div className="grid min-w-0 grid-cols-1 gap-2">
						<Field className="min-w-0">
							<FieldTitle>Von</FieldTitle>
							<NativeSelect
								value={status?.quietStartHour ?? ''}
								disabled={notificationControlsDisabled}
								onChange={(e) => {
									const value = parseQuietHour(e.target.value);
									void (value === null
										? saveQuietHours(null, null)
										: saveQuietHours(value, status?.quietEndHour ?? 7));
								}}
								aria-label="Ruhezeit von"
								className="w-full min-w-0 text-base"
							>
								<NativeSelectOption value="">Aus</NativeSelectOption>
								{HOUR_OPTIONS.map((option) => (
									<NativeSelectOption key={option.label} value={option.value}>
										{option.label}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
						<Field className="min-w-0">
							<FieldTitle>Bis</FieldTitle>
							<NativeSelect
								value={status?.quietEndHour ?? ''}
								disabled={notificationControlsDisabled}
								onChange={(e) => {
									const value = parseQuietHour(e.target.value);
									void (value === null
										? saveQuietHours(null, null)
										: saveQuietHours(status?.quietStartHour ?? 22, value));
								}}
								aria-label="Ruhezeit bis"
								className="w-full min-w-0 text-base"
							>
								<NativeSelectOption value="">Aus</NativeSelectOption>
								{HOUR_OPTIONS.map((option) => (
									<NativeSelectOption key={option.label} value={option.value}>
										{option.label}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
					</div>
				</div>

				{message && (
					<Alert>
						<CheckCircle2 aria-hidden />
						<AlertDescription>{message}</AlertDescription>
					</Alert>
				)}
				{status && error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
			</div>
		</Section>
	);
}
