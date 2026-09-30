'use client';

import { useToast } from '@/components/ui/Toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { Bell, Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type RemindButtonStatus = 'idle' | 'sending' | 'sent' | 'error' | 'cooldown' | 'optedOut';
type RemindResponseWarning =
	| null
	| 'notification_delivery_failed'
	| 'notification_delivery_unknown';
type RemindResponse = { reminder: { id: string }; warning: RemindResponseWarning };

interface RemindButtonProps {
	shareCode: string;
	debtorMemberId: string;
	creditorMemberId: string;
	currency: string;
	currentMemberId: string;
	memberToken?: string | undefined;
	cooldownActive?: boolean;
	cooldownLabel?: string | null;
	debtorOptedOut?: boolean;
	onSent?: (reminderId: string) => void;
	onOptimistic?: (() => (() => void) | undefined) | undefined;
	size?: 'sm' | 'md';
	primary?: boolean;
}

function errorMessage(error: string): string {
	if (error === 'reminder_cooldown') return 'Bitte etwas warten (48 h pro Person).';
	if (error === 'reminder_rate_limited') return 'Zu viele Erinnerungen — bitte später erneut.';
	if (error === 'debtor_opted_out') return 'Diese Person erhält keine Erinnerungen.';
	if (error === 'no_open_debt') return 'Keine offene Schuld zwischen euch.';
	if (error === 'not_a_member') return 'Bitte erneut der WG beitreten.';
	if (error === 'Failed to fetch' || error === 'Netzwerkfehler') {
		return 'Erinnerung konnte nicht gesendet werden — Verbindung prüfen.';
	}
	return 'Erinnerung konnte nicht gesendet werden.';
}

function successMessage(warning: RemindResponseWarning): string {
	if (warning === 'notification_delivery_failed') {
		return 'Erinnerung gespeichert. Push-Benachrichtigung konnte nicht versendet werden.';
	}
	if (warning === 'notification_delivery_unknown') {
		return 'Erinnerung gespeichert. Push-Versand konnte nicht bestätigt werden.';
	}
	return 'Erinnerung gesendet.';
}

export function RemindButton({
	shareCode,
	debtorMemberId,
	creditorMemberId,
	currency,
	currentMemberId,
	memberToken,
	cooldownActive,
	cooldownLabel,
	debtorOptedOut,
	onSent,
	onOptimistic,
	size = 'md',
	primary = false,
}: RemindButtonProps) {
	const toast = useToast();
	const [status, setStatus] = useState<RemindButtonStatus>(
		debtorOptedOut ? 'optedOut' : cooldownActive ? 'cooldown' : 'idle',
	);
	const [feedback, setFeedback] = useState<string | null>(null);
	const sendingRef = useRef(false);
	const requestKeyRef = useRef<string | null>(null);

	useEffect(() => {
		// A request is genuinely in flight — its own result sets the status.
		if (sendingRef.current) return;
		const nextStatus: RemindButtonStatus = debtorOptedOut
			? 'optedOut'
			: cooldownActive
				? 'cooldown'
				: 'idle';
		setStatus((current) => {
			// 'sent' is terminal, but a leftover 'sending' without an in-flight
			// request must not stick — otherwise the button stays on "Sende…"
			// forever with no way to retry after the conditions changed.
			if (current === 'sent') return current;
			return nextStatus;
		});
		if (nextStatus === 'idle') setFeedback(null);
	}, [cooldownActive, debtorOptedOut]);

	const disabled =
		status === 'sending' || status === 'cooldown' || status === 'optedOut' || status === 'sent';

	async function handleClick(): Promise<void> {
		if (sendingRef.current || disabled) return;
		sendingRef.current = true;
		setStatus('sending');
		setFeedback(null);
		const rollbackOptimistic = onOptimistic?.();
		const idempotencyKey = requestKeyRef.current ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			rollbackOptimistic?.();
			const message = errorMessage('Netzwerkfehler');
			setStatus('error');
			setFeedback(message);
			toast.error(message);
			sendingRef.current = false;
			return;
		}
		requestKeyRef.current = idempotencyKey;
		try {
			const res = await apiFetch<RemindResponse>(
				`/api/wg/${encodeURIComponent(shareCode)}/reminders`,
				{
					method: 'POST',
					memberId: currentMemberId,
					memberToken,
					headers: { 'Idempotency-Key': idempotencyKey },
					body: JSON.stringify({ debtorMemberId, creditorMemberId, currency }),
				},
			);
			if (res.ok) {
				requestKeyRef.current = null;
				setStatus('sent');
				setFeedback(successMessage(res.data.warning));
				onSent?.(res.data.reminder.id);
				return;
			}
			rollbackOptimistic?.();
			if (res.status > 0 && res.status < 500) requestKeyRef.current = null;
			if (res.status === 429 && res.error === 'reminder_cooldown') {
				setStatus('cooldown');
			} else if (res.status === 403 && res.error === 'debtor_opted_out') {
				setStatus('optedOut');
			} else {
				setStatus('error');
			}
			const message = errorMessage(res.error);
			setFeedback(message);
			toast.error(message);
		} catch (err) {
			rollbackOptimistic?.();
			const message = err instanceof Error ? errorMessage(err.message) : errorMessage('unknown');
			setStatus('error');
			setFeedback(message);
			toast.error(message);
		} finally {
			sendingRef.current = false;
		}
	}

	let label = 'Erinnern';
	if (status === 'sending') label = 'Sende…';
	else if (status === 'sent') label = 'Gesendet';
	else if (status === 'cooldown') label = cooldownLabel ?? 'Noch gesperrt';
	else if (status === 'optedOut') label = 'Erinnerungen deaktiviert';

	return (
		<div className="flex max-w-full flex-col gap-2">
			<Button
				type="button"
				variant={status === 'sent' ? 'secondary' : primary ? 'default' : 'outline'}
				size={size === 'sm' ? 'sm' : 'default'}
				className={
					primary
						? 'h-auto min-h-11 w-full whitespace-normal py-2'
						: 'h-auto whitespace-normal py-2'
				}
				onClick={() => void handleClick()}
				disabled={disabled}
			>
				{status === 'sending' ? (
					<Spinner data-icon="inline-start" />
				) : status === 'sent' ? (
					<Check data-icon="inline-start" />
				) : (
					<Bell data-icon="inline-start" />
				)}
				{label}
			</Button>
			{feedback && (
				<Alert
					role={status === 'error' ? 'alert' : 'status'}
					variant={status === 'error' ? 'destructive' : 'default'}
				>
					<AlertDescription>{feedback}</AlertDescription>
				</Alert>
			)}
		</div>
	);
}
