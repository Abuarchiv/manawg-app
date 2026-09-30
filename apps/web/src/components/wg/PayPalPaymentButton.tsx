'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/core/infra/api-client';
import { formatEuroCents } from '@/core/utils/money';
import {
	isPayPalCapturePendingResult,
	resolvePayPalOrderLookup,
	shouldRetryPayPalCapture,
} from '@/features/expenses/paypal-settlement';
import { useEffect, useRef, useState } from 'react';

interface PayPalButtonsInstance {
	render(container: HTMLElement): Promise<void>;
	close?(): Promise<void>;
}

interface PayPalNamespace {
	Buttons(options: {
		createOrder: () => Promise<string>;
		onApprove: (data: { orderID: string }) => Promise<void>;
		onCancel?: () => void;
		onError: (error: unknown) => void;
	}): PayPalButtonsInstance;
}

declare global {
	interface Window {
		[key: string]: unknown;
	}
}

const PAYPAL_CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;
const PAYPAL_PARTNER_ATTRIBUTION_ID = process.env.NEXT_PUBLIC_PAYPAL_PARTNER_ATTRIBUTION_ID;
const PAYPAL_ERROR =
	'PayPal konnte die Zahlung nicht bestätigen. Prüfe den Zahlungsstatus bei PayPal, bevor du erneut zahlst oder die Zahlung als beglichen vermerkst.';
const payPalSdkLoads = new Map<string, Promise<void>>();

type CaptureOutcome = 'completed' | 'pending' | 'failed';

function sdkNamespace(merchantId: string): string {
	return `p${merchantId}`;
}

function paypalFor(merchantId: string): PayPalNamespace | undefined {
	// The namespace is written by PayPal's injected script — treat it as
	// untrusted input instead of casting blindly.
	const candidate: unknown = window[sdkNamespace(merchantId)];
	if (typeof candidate !== 'object' || candidate === null) return undefined;
	if (typeof (candidate as { Buttons?: unknown }).Buttons !== 'function') return undefined;
	return candidate as PayPalNamespace;
}

function loadPayPalSdk(merchantId: string): Promise<void> {
	if (paypalFor(merchantId)) return Promise.resolve();
	const pending = payPalSdkLoads.get(merchantId);
	if (pending) return pending;
	const load = new Promise<void>((resolve, reject) => {
		const script = document.createElement('script');
		const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
		if (!nonce) {
			reject(new Error('CSP nonce missing'));
			return;
		}
		script.nonce = nonce;
		script.dataset.cspNonce = nonce;
		script.src = `https://www.paypal.com/sdk/js?${new URLSearchParams({
			'client-id': PAYPAL_CLIENT_ID ?? '',
			'merchant-id': merchantId,
			currency: 'EUR',
		})}`;
		script.dataset.namespace = sdkNamespace(merchantId);
		script.dataset.partnerAttributionId = PAYPAL_PARTNER_ATTRIBUTION_ID ?? '';
		script.async = true;
		script.onload = () => resolve();
		script.onerror = () => {
			payPalSdkLoads.delete(merchantId);
			reject(new Error());
		};
		document.head.appendChild(script);
	});
	payPalSdkLoads.set(merchantId, load);
	return load;
}

interface PayPalPaymentButtonProps {
	shareCode: string;
	currentMemberId: string;
	memberToken?: string | undefined;
	fromMemberId: string;
	toMemberId: string;
	payeeMerchantId: string;
	amountCents: number;
	currency: string;
	onPaid: () => void;
}

export function PayPalPaymentButton({
	shareCode,
	currentMemberId,
	memberToken,
	fromMemberId,
	toMemberId,
	payeeMerchantId,
	amountCents,
	currency,
	onPaid,
}: PayPalPaymentButtonProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const onPaidRef = useRef(onPaid);
	const pendingOrderIdRef = useRef<string | null>(null);
	const statusLookupFailedRef = useRef(false);
	const reconcileCaptureRef = useRef<(orderId: string) => Promise<CaptureOutcome>>(
		async () => 'failed',
	);
	const [error, setError] = useState<string | null>(null);
	const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
	const [statusLookupFailed, setStatusLookupFailed] = useState(false);
	const [statusLookupRetryCount, setStatusLookupRetryCount] = useState(0);
	const [isCheckingStatus, setIsCheckingStatus] = useState(true);
	const [isRetrying, setIsRetrying] = useState(false);
	onPaidRef.current = onPaid;

	useEffect(() => {
		if (!PAYPAL_CLIENT_ID || !PAYPAL_PARTNER_ATTRIBUTION_ID || !containerRef.current) return;
		let cancelled = false;
		let buttons: PayPalButtonsInstance | undefined;
		statusLookupFailedRef.current = true;
		if (statusLookupRetryCount > 0) setError(null);
		const updatePendingOrder = (orderId: string | null) => {
			pendingOrderIdRef.current = orderId;
			setPendingOrderId(orderId);
		};

		const reconcileCapture = async (orderId: string): Promise<CaptureOutcome> => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const result = await apiFetch<{ status: string }>(
					`/api/wg/${encodeURIComponent(shareCode)}/paypal/capture`,
					{
						method: 'POST',
						memberId: currentMemberId,
						memberToken,
						body: JSON.stringify({ orderId }),
					},
				);
				if (cancelled) return 'pending';
				if (result.ok && result.data.status === 'COMPLETED') {
					updatePendingOrder(null);
					setError(null);
					onPaidRef.current();
					return 'completed';
				}
				if (result.ok && result.data.status === 'PENDING') {
					updatePendingOrder(orderId);
					setError(null);
					return 'pending';
				}
				if (result.ok && (result.data.status === 'FAILED' || result.data.status === 'CANCELLED')) {
					updatePendingOrder(null);
					setError(PAYPAL_ERROR);
					return 'failed';
				}
				if (isPayPalCapturePendingResult(result)) {
					updatePendingOrder(orderId);
					setError(PAYPAL_ERROR);
					return 'pending';
				}
				if (!shouldRetryPayPalCapture(result)) {
					updatePendingOrder(null);
					setError(PAYPAL_ERROR);
					return 'failed';
				}
			}
			updatePendingOrder(orderId);
			setError(null);
			return 'pending';
		};
		reconcileCaptureRef.current = reconcileCapture;

		const createOrder = async (): Promise<string> => {
			if (cancelled || pendingOrderIdRef.current || statusLookupFailedRef.current) {
				throw new Error('paypal_capture_pending');
			}
			const result = await apiFetch<{ orderId: string }>(
				`/api/wg/${encodeURIComponent(shareCode)}/paypal/order`,
				{
					method: 'POST',
					memberId: currentMemberId,
					memberToken,
					body: JSON.stringify({ fromMemberId, toMemberId, currency }),
				},
			);
			if (!result.ok) throw new Error(result.error);
			return result.data.orderId;
		};

		const onApprove = async (data: { orderID: string }): Promise<void> => {
			await reconcileCapture(data.orderID);
		};

		const initialize = async () => {
			setIsCheckingStatus(true);
			setError(null);
			try {
				const lookup = await apiFetch<{ status: string; orderId?: string }>(
					`/api/wg/${encodeURIComponent(shareCode)}/paypal/order?toMemberId=${encodeURIComponent(toMemberId)}`,
					{ method: 'GET', memberId: currentMemberId, memberToken },
				);
				if (cancelled) return;
				const lookupState = resolvePayPalOrderLookup(lookup);
				if (lookupState.kind === 'retry') {
					statusLookupFailedRef.current = true;
					setStatusLookupFailed(true);
					setError(PAYPAL_ERROR);
					return;
				}
				statusLookupFailedRef.current = false;
				setStatusLookupFailed(false);
				if (lookupState.kind === 'capture') {
					updatePendingOrder(lookupState.orderId);
					if ((await reconcileCapture(lookupState.orderId)) === 'completed') return;
				}
			} finally {
				if (!cancelled) setIsCheckingStatus(false);
			}

			if (cancelled) return;
			try {
				await loadPayPalSdk(payeeMerchantId);
				const paypal = paypalFor(payeeMerchantId);
				if (cancelled || !containerRef.current || !paypal) return;
				buttons = paypal.Buttons({
					createOrder,
					onApprove,
					onError: () => setError(PAYPAL_ERROR),
				});
				await buttons.render(containerRef.current);
			} catch {
				if (!cancelled) setError(PAYPAL_ERROR);
			}
		};

		void initialize().catch(() => {
			if (!cancelled) {
				statusLookupFailedRef.current = true;
				setStatusLookupFailed(true);
				setError(PAYPAL_ERROR);
				setIsCheckingStatus(false);
			}
		});

		return () => {
			cancelled = true;
			statusLookupFailedRef.current = true;
			reconcileCaptureRef.current = async () => 'failed';
			void buttons?.close?.();
		};
	}, [
		currentMemberId,
		currency,
		fromMemberId,
		memberToken,
		payeeMerchantId,
		shareCode,
		toMemberId,
		statusLookupRetryCount,
	]);

	const retryStatusLookup = () => {
		statusLookupFailedRef.current = true;
		setIsCheckingStatus(true);
		setStatusLookupRetryCount((count) => count + 1);
	};

	const retryPendingCapture = async () => {
		const orderId = pendingOrderIdRef.current;
		if (!orderId || isRetrying) return;
		setIsRetrying(true);
		try {
			await reconcileCaptureRef.current(orderId);
		} finally {
			setIsRetrying(false);
		}
	};

	if (!PAYPAL_CLIENT_ID || !PAYPAL_PARTNER_ATTRIBUTION_ID) return null;
	return (
		<div className="flex flex-col gap-3 pt-3">
			<p className="text-sm text-muted-foreground">
				PayPal-Zahlung über{' '}
				<span className="font-mono tabular-nums">{formatEuroCents(amountCents, currency)}</span>.
				Erst bei PayPal bestätigen; ein Abbruch verbucht keinen Ausgleich.
			</p>
			{isCheckingStatus && (
				<output className="text-sm text-muted-foreground">
					PayPal-Zahlungsstatus wird geprüft…
				</output>
			)}
			<div
				ref={containerRef}
				hidden={isCheckingStatus || statusLookupFailed || Boolean(pendingOrderId)}
				aria-label={`PayPal ${formatEuroCents(amountCents, currency)} zahlen`}
				role="group"
			/>
			{pendingOrderId && (
				<div className="flex flex-col gap-2">
					<output
						className="rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground"
						aria-live="polite"
					>
						PayPal verarbeitet diese Zahlung noch. Starte keine weitere Zahlung.
					</output>
					<Button
						type="button"
						variant="outline"
						disabled={isCheckingStatus || isRetrying}
						onClick={() => void retryPendingCapture()}
					>
						{isRetrying ? 'Status wird geprüft…' : 'Zahlungsstatus prüfen'}
					</Button>
				</div>
			)}
			{statusLookupFailed && (
				<Button
					type="button"
					variant="outline"
					disabled={isCheckingStatus}
					onClick={retryStatusLookup}
				>
					{isCheckingStatus ? 'Status wird geprüft…' : 'Zahlungsstatus erneut prüfen'}
				</Button>
			)}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
		</div>
	);
}
