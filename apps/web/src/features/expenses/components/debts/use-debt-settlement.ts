'use client';

import { useToast } from '@/components/ui/Toast';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { formatEuroCents } from '@/core/utils/money';
import type { SimplifiedDebt } from '@/features/expenses/debt-reduction';
import { useRef, useState } from 'react';
import { settlementErrorMessage } from './settlement-errors';

/** What the server can settle for a debt right now; the confirmation must match it. */
export interface SettlementPreview {
	currency: string;
	netCents: number;
	settleableCents: number;
	remainingCents: number;
	splits: Array<{ id: string; expenseId: string; amountCents: number; offset?: boolean }>;
	reason?: string;
}

interface SettleBatchResponse {
	settled: number;
	settledCents?: number;
	remainingCents?: number;
	reason?: string;
}

interface DebtSettlementInput {
	debt: SimplifiedDebt;
	shareCode: string;
	currentMemberId: string;
	onSettled: (message?: string) => void;
}

/**
 * Manual settlement of one debt: review what can be settled, then confirm a payment that
 * already happened. A retry of the same confirmation reuses its idempotency key.
 */
export function useDebtSettlement({
	debt,
	shareCode,
	currentMemberId,
	onSettled,
}: DebtSettlementInput) {
	const toast = useToast();
	const [reviewOpen, setReviewOpen] = useState(false);
	const [settling, setSettling] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const [preview, setPreview] = useState<SettlementPreview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const settlingRef = useRef(false);
	const settlementRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const endpoint = `/api/wg/${encodeURIComponent(shareCode)}/expenses/settle-batch`;

	async function review(): Promise<void> {
		if (settlingRef.current) return;
		settlingRef.current = true;
		setReviewing(true);
		setError(null);
		try {
			const res = await apiFetch<SettlementPreview>(
				`${endpoint}?${new URLSearchParams({ fromMemberId: debt.fromId, toMemberId: debt.toId, currency: debt.currency ?? 'EUR' })}`,
				{ memberId: currentMemberId },
			);
			if (res.ok) {
				setPreview(res.data);
				setReviewOpen(true);
			} else {
				toast.error('Prüfung fehlgeschlagen. Versuche es gleich erneut.');
			}
		} catch {
			toast.error('Prüfung fehlgeschlagen. Prüfe deine Verbindung.');
		} finally {
			settlingRef.current = false;
			setReviewing(false);
		}
	}

	async function settle(): Promise<void> {
		if (settlingRef.current || !preview || preview.settleableCents <= 0) return;
		settlingRef.current = true;
		setSettling(true);
		setError(null);
		const body = {
			fromMemberId: debt.fromId,
			toMemberId: debt.toId,
			currency: debt.currency ?? 'EUR',
			expected: {
				currency: preview.currency,
				netCents: preview.netCents,
				settleableCents: preview.settleableCents,
				splits: preview.splits.map(({ id, amountCents, offset }) => ({
					id,
					amountCents,
					offset: offset === true,
				})),
			},
		};
		const fingerprint = JSON.stringify(body);
		const pendingRequest = settlementRequestRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			const message = 'Ausgleich konnte nicht sicher gespeichert werden. Versuche es erneut.';
			setError(message);
			toast.error(message);
			settlingRef.current = false;
			setSettling(false);
			return;
		}
		settlementRequestRef.current = { fingerprint, key: idempotencyKey };
		try {
			const res = await apiFetch<SettleBatchResponse>(endpoint, {
				method: 'POST',
				memberId: currentMemberId,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				if (res.status > 0 && res.status < 500) settlementRequestRef.current = null;
				const message = settlementErrorMessage(res.error);
				setError(message);
				toast.error(message);
				if (res.error === 'settlement_changed') {
					setPreview(null);
					setReviewOpen(false);
				}
				return;
			}
			settlementRequestRef.current = null;
			const { settled, settledCents, remainingCents, reason } = res.data;
			setPreview(null);
			setReviewOpen(false);
			const message =
				reason === 'no_direct_splits'
					? 'Diese Verrechnung hat keine direkt zuordenbaren Anteile. Prüfe die ursprünglichen Ausgaben einzeln.'
					: settled > 0
						? `Zahlung eingetragen: ${formatEuroCents(settledCents ?? 0, debt.currency)} von ${debt.fromName} an ${debt.toName}.${remainingCents ? ` ${formatEuroCents(remainingCents, debt.currency)} bleiben in der Verrechnung offen.` : ''}`
						: 'Keine Zahlung eingetragen. Die offenen Ausgaben werden neu geladen.';
			onSettled(message);
		} catch {
			const message = settlementErrorMessage('Netzwerkfehler');
			setError(message);
			toast.error(message);
		} finally {
			settlingRef.current = false;
			setSettling(false);
		}
	}

	/** Closing the dialog also clears a failed attempt's error so it does not stick to the row. */
	function setReviewDialogOpen(open: boolean): void {
		if (settling) return;
		setReviewOpen(open);
		if (!open) setError(null);
	}

	return {
		reviewOpen,
		setReviewOpen,
		setReviewDialogOpen,
		settling,
		reviewing,
		preview,
		error,
		review,
		settle,
	};
}

export type DebtSettlement = ReturnType<typeof useDebtSettlement>;
