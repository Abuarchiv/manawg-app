'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useWg } from '@/components/wg/WgContextProvider';
import { apiFetch } from '@/core/infra/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

interface PayPalConnectionStatus {
	available: boolean;
	connected: boolean;
}

const PAYPAL_HINTS = [
	'paypal',
	'merchantIdInPayPal',
	'merchantId',
	'trackingId',
	'tracking_id',
	'consentStatus',
	'consent_status',
	'riskStatus',
	'risk_status',
	'authCode',
	'auth_code',
	'sharedId',
	'shared_id',
	'permissionsGranted',
	'permissions_granted',
];

const PAYPAL_ACTION_HOSTS = new Set(['paypal.com', 'www.paypal.com', 'www.sandbox.paypal.com']);

const PAYPAL_CONSENT =
	'Mit „PayPal verbinden“ stimmst du zu, dass die für die Verknüpfung nötigen Kontodaten zwischen ManaWG und PayPal ausgetauscht werden.';
const PAYPAL_PENDING = 'PayPal-Verbindung wartet noch auf Bestätigung.';

interface PendingReturn {
	scope: string;
	merchantId: string;
}

interface PayPalCallback {
	scope: string;
	action: 'cancel' | 'return';
	merchantId: string | null;
}

function isConnectionStatus(value: unknown): value is PayPalConnectionStatus {
	if (typeof value !== 'object' || value === null) return false;
	const status = value as Record<string, unknown>;
	return typeof status.available === 'boolean' && typeof status.connected === 'boolean';
}

function isPayPalActionUrl(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === 'https:' &&
			(url.port === '' || url.port === '443') &&
			!url.username &&
			!url.password &&
			PAYPAL_ACTION_HOSTS.has(url.hostname.toLowerCase())
		);
	} catch {
		return false;
	}
}

function connectionError(error: string): string {
	if (error === 'paypal_onboarding_pending') return PAYPAL_PENDING;
	if (error === 'paypal_payment_pending')
		return 'Eine Zahlung läuft noch. Versuche es danach erneut.';
	if (error === 'paypal_connection_expired')
		return 'Die PayPal-Verbindung ist abgelaufen. Bitte starte sie erneut.';
	if (error === 'paypal_account_already_connected')
		return 'Mit dieser WG ist bereits ein anderes PayPal-Konto verbunden.';
	if (error === 'member_not_verified')
		return 'Dieses Gerät ist noch nicht bestätigt. Lade die App neu und versuche es erneut.';
	return 'PayPal-Verbindung konnte nicht geprüft werden. Bitte versuche es erneut.';
}

function clearPayPalHints(url: URL): void {
	let changed = false;
	for (const key of PAYPAL_HINTS) {
		if (url.searchParams.has(key)) {
			url.searchParams.delete(key);
			changed = true;
		}
	}
	if (changed) {
		window.history.replaceState(
			window.history.state,
			'',
			`${url.pathname}${url.search}${url.hash}`,
		);
	}
}

export function PayPalConnect({
	shareCode,
	memberId,
	memberToken,
}: {
	shareCode: string;
	memberId: string;
	memberToken?: string | undefined;
}) {
	const { refreshMembers } = useWg();
	const endpoint = `/api/wg/${encodeURIComponent(shareCode)}/paypal/connect`;
	const scope = JSON.stringify([shareCode, memberId, memberToken ?? null]);
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	const pendingReturn = useRef<PendingReturn | null>(null);
	const callbackState = useRef<PayPalCallback | null>(null);
	const [status, setStatus] = useState<PayPalConnectionStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (pendingReturn.current?.scope !== scope) pendingReturn.current = null;
		if (callbackState.current?.scope !== scope) callbackState.current = null;
	}, [scope]);

	const fetchConnectionStatus = useCallback(
		async (expectedScope: string, signal?: AbortSignal): Promise<PayPalConnectionStatus | null> => {
			if (scopeRef.current !== expectedScope) return null;
			setLoading(true);
			try {
				const result = await apiFetch<unknown>(endpoint, {
					memberId,
					memberToken,
					...(signal ? { signal } : {}),
				});
				if (scopeRef.current !== expectedScope) return null;
				setLoading(false);
				if (!result.ok || !isConnectionStatus(result.data)) {
					setStatus(null);
					setError(
						result.ok
							? 'PayPal-Verbindung konnte nicht geprüft werden.'
							: connectionError(result.error),
					);
					return null;
				}
				setStatus(result.data);
				setError(null);
				return result.data;
			} catch {
				if (scopeRef.current !== expectedScope) return null;
				setLoading(false);
				setStatus(null);
				setError('PayPal-Verbindung konnte nicht geprüft werden. Bitte versuche es erneut.');
				return null;
			}
		},
		[endpoint, memberId, memberToken],
	);

	const confirmConnection = useCallback(
		async (merchantId: string, expectedScope: string): Promise<void> => {
			if (scopeRef.current !== expectedScope) return;
			setBusy(true);
			setError(null);
			try {
				const result = await apiFetch<{ connected?: boolean }>(endpoint, {
					method: 'POST',
					memberId,
					memberToken,
					body: JSON.stringify({ action: 'confirm', merchantId }),
				});
				if (scopeRef.current !== expectedScope) return;
				if (result.ok && result.data.connected === true) {
					pendingReturn.current = null;
					callbackState.current = null;
					setStatus({ available: true, connected: true });
					void refreshMembers(memberId);
					return;
				}
				if (
					!result.ok &&
					(result.error === 'paypal_onboarding_pending' ||
						result.error === 'paypal_payment_pending' ||
						result.status === 0 ||
						result.status === 429 ||
						result.status >= 500)
				) {
					pendingReturn.current = { scope: expectedScope, merchantId };
					setError(connectionError(result.error));
					return;
				}
				pendingReturn.current = null;
				callbackState.current = null;
				setError(
					result.ok
						? 'PayPal-Verbindung konnte nicht bestätigt werden.'
						: connectionError(result.error),
				);
			} catch {
				if (scopeRef.current === expectedScope) {
					pendingReturn.current = { scope: expectedScope, merchantId };
					setError('PayPal-Verbindung konnte nicht geprüft werden. Bitte versuche es erneut.');
				}
			} finally {
				if (scopeRef.current === expectedScope) setBusy(false);
			}
		},
		[endpoint, memberId, memberToken, refreshMembers],
	);

	useEffect(() => {
		let active = true;
		const currentScope = scope;
		const controller = new AbortController();
		const isCurrent = () => active && scopeRef.current === currentScope;
		setStatus(null);
		setLoading(true);
		setBusy(false);
		setError(null);

		const callbackUrl = new URL(window.location.href);
		const callback = callbackUrl.searchParams.get('paypal');
		const merchantId = callbackUrl.searchParams.get('merchantIdInPayPal')?.trim() ?? '';
		if (callback === 'return' || callback === 'cancel') {
			callbackState.current = {
				scope: currentScope,
				action: callback,
				merchantId: callback === 'return' ? merchantId || null : null,
			};
		}
		if (callback === 'return' && merchantId) {
			pendingReturn.current = { scope: currentScope, merchantId };
		} else if (callback === 'cancel') {
			pendingReturn.current = null;
		}
		clearPayPalHints(callbackUrl);

		async function loadConnection(): Promise<void> {
			const currentStatus = await fetchConnectionStatus(currentScope, controller.signal);
			if (!isCurrent() || !currentStatus) return;
			const currentCallback =
				callbackState.current?.scope === currentScope ? callbackState.current : null;
			if (currentCallback?.action === 'cancel') {
				setError('PayPal-Verbindung wurde abgebrochen.');
				return;
			}
			if (currentCallback?.action === 'return' && !currentCallback.merchantId) {
				setError('PayPal-Verbindung konnte nicht bestätigt werden. Bitte starte sie erneut.');
				return;
			}
			const pending = pendingReturn.current;
			if (pending?.scope === currentScope) {
				await confirmConnection(pending.merchantId, currentScope);
			}
		}

		void loadConnection().catch(() => {
			if (!isCurrent()) return;
			setStatus(null);
			setLoading(false);
			setError('PayPal-Verbindung konnte nicht geprüft werden. Bitte versuche es erneut.');
		});
		return () => {
			active = false;
			controller.abort();
		};
	}, [confirmConnection, fetchConnectionStatus, scope]);

	async function startConnection(): Promise<void> {
		const currentScope = scope;
		if (busy || !status?.available) return;
		pendingReturn.current = null;
		callbackState.current = null;
		setBusy(true);
		setError(null);
		try {
			const result = await apiFetch<{ url?: unknown }>(endpoint, {
				method: 'POST',
				memberId,
				memberToken,
				body: JSON.stringify({ action: 'start', consent: true }),
			});
			if (scopeRef.current !== currentScope) return;
			if (!result.ok) {
				setError(connectionError(result.error));
				return;
			}
			if (!isPayPalActionUrl(result.data.url)) {
				setError(
					'PayPal hat einen ungültigen Verbindungslink zurückgegeben. Bitte versuche es erneut.',
				);
				return;
			}
			window.location.assign(result.data.url);
		} catch {
			if (scopeRef.current === currentScope) {
				setError('PayPal-Verbindung konnte nicht gestartet werden. Bitte versuche es erneut.');
			}
		} finally {
			if (scopeRef.current === currentScope) setBusy(false);
		}
	}

	async function retryConnection(): Promise<void> {
		const currentScope = scope;
		const pending = pendingReturn.current;
		const currentStatus = await fetchConnectionStatus(currentScope);
		if (currentStatus && pending?.scope === currentScope) {
			await confirmConnection(pending.merchantId, currentScope);
		}
	}

	return (
		<div className="flex flex-col gap-3 p-3">
			{loading ? (
				<div
					className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground"
					aria-live="polite"
				>
					<Spinner aria-hidden />
					PayPal-Verbindung wird geprüft…
				</div>
			) : status?.connected ? (
				<p className="text-sm" aria-live="polite">
					PayPal verbunden
				</p>
			) : status?.available ? (
				<>
					<p className="text-sm text-muted-foreground">{PAYPAL_CONSENT}</p>
					<Button
						type="button"
						variant="outline"
						onClick={() => void startConnection()}
						disabled={busy}
					>
						{busy && <Spinner data-icon="inline-start" />}
						{busy ? 'Weiterleitung zu PayPal…' : 'PayPal verbinden'}
					</Button>
				</>
			) : status ? (
				<p className="text-sm text-muted-foreground" aria-live="polite">
					PayPal ist derzeit nicht verfügbar.
				</p>
			) : null}

			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			{error && !status?.connected && !loading && (
				<Button type="button" variant="ghost" onClick={retryConnection} disabled={busy}>
					Verbindung prüfen
				</Button>
			)}
		</div>
	);
}
