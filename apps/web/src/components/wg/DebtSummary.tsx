'use client';

import { useToast } from '@/components/ui/Toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemFooter,
	ItemGroup,
	ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { PayPalPaymentButton } from '@/components/wg/PayPalPaymentButton';
import { RemindButton } from '@/components/wg/RemindButton';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { formatEuroCents } from '@/core/utils/money';
import { formatShortDate } from '@/core/utils/time';
import type { Expense } from '@/features/expenses/components/ausgaben/expense-types';
import { getDebtOverview } from '@/features/expenses/debt-overview';
import type { SettlementSummary, SimplifiedDebt } from '@/features/expenses/debt-reduction';
import { cn } from '@/shared/lib/cn';
import { isPayPalSdkEnabled } from '@/shared/lib/security-headers';
import { ChevronDown, History } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';

// Ohne PayPal-Zugangsdaten gibt es weder Verbinden noch Zahlen; dann keine PayPal-Hinweise.
const PAYPAL_ENABLED = isPayPalSdkEnabled(
	process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID,
	process.env.NEXT_PUBLIC_PAYPAL_PARTNER_ATTRIBUTION_ID,
);

function settlementErrorMessage(error: string): string {
	if (error === 'settlement_changed')
		return 'Die offenen Beträge haben sich geändert. Prüfe die Zahlung erneut, bevor du sie einträgst.';
	if (error === 'settlement_review_required')
		return 'Prüfe zuerst die betroffenen Ausgaben und den Betrag.';
	if (error === 'unexpected_error' || error === 'server_error' || error === 'db_error') {
		return 'Ausgleich konnte nicht gespeichert werden: Versuche es gleich erneut.';
	}
	if (error === 'Netzwerkfehler' || error === 'Failed to fetch') {
		return 'Ausgleich konnte nicht gespeichert werden: Prüfe deine Verbindung und versuche es erneut.';
	}
	if (error === 'wg_not_found') {
		return 'Ausgleich konnte nicht gespeichert werden: Öffne die WG über den aktuellen Link erneut.';
	}
	if (error === 'invalid_share_code') {
		return 'Ausgleich konnte nicht gespeichert werden: Der WG-Code ist ungültig.';
	}
	if (error === 'not_a_member' || error === 'member_id_required' || error === 'member_id_invalid') {
		return 'Ausgleich konnte nicht gespeichert werden: Tritt der WG erneut bei.';
	}
	if (error === 'member_not_in_wg') {
		return 'Ausgleich konnte nicht gespeichert werden: Mindestens ein Mitglied ist nicht mehr in dieser WG.';
	}
	if (error === 'not_party_to_debt') {
		return 'Ausgleich konnte nicht gespeichert werden: Du bist an dieser Schuld nicht beteiligt.';
	}
	if (error === 'same_member' || error === 'member_ids_invalid' || error === 'invalid_json') {
		return 'Ausgleich konnte nicht gespeichert werden: Die Anfrage war ungültig.';
	}
	if (error === 'paypal_payment_pending')
		return 'Eine PayPal-Zahlung läuft noch. Warte auf deren Abschluss.';
	return 'Ausgleich konnte nicht gespeichert werden.';
}

interface SettlementPreview {
	currency: string;
	netCents: number;
	settleableCents: number;
	remainingCents: number;
	splits: Array<{ id: string; expenseId: string; amountCents: number }>;
	reason?: string;
}

interface DebtRowProps {
	debt: SimplifiedDebt;
	expenses: readonly Expense[];
	shareCode: string;
	currentMemberId: string;
	memberToken?: string | undefined;
	memberPayPalMerchantId: (id: string) => string | null;
	payPalEligible: boolean;
	onSettled: (message?: string) => void;
}

export interface MemberBalance {
	memberId: string;
	memberName: string;
	currency: string;
	balanceCents: number;
}

interface SettleBatchResponse {
	settled: number;
	settledCents?: number;
	remainingCents?: number;
	reason?: string;
}

function DebtRow({
	debt,
	expenses,
	shareCode,
	currentMemberId,
	memberToken,
	memberPayPalMerchantId,
	payPalEligible,
	onSettled,
}: DebtRowProps) {
	const toast = useToast();
	const [reviewOpen, setReviewOpen] = useState(false);
	const [settling, setSettling] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const [preview, setPreview] = useState<SettlementPreview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const settlingRef = useRef(false);
	const settlementRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const canSettle = debt.fromId === currentMemberId || debt.toId === currentMemberId;
	const payeeMerchantId = memberPayPalMerchantId(debt.toId);
	const canPayWithPayPal =
		(debt.currency ?? 'EUR') === 'EUR' &&
		debt.fromId === currentMemberId &&
		payeeMerchantId !== null &&
		payPalEligible &&
		PAYPAL_ENABLED;
	const endpoint = `/api/wg/${encodeURIComponent(shareCode)}/expenses/settle-batch`;

	async function review(): Promise<void> {
		if (settlingRef.current) return;
		settlingRef.current = true;
		setReviewing(true);
		setError(null);
		try {
			const res = await apiFetch<SettlementPreview>(
				`${endpoint}?${new URLSearchParams({ fromMemberId: debt.fromId, toMemberId: debt.toId, currency: debt.currency ?? 'EUR' })}`,
				{ memberId: currentMemberId, memberToken },
			);
			if (res.ok) {
				setPreview(res.data);
				setReviewOpen(true);
			} else {
				const message = settlementErrorMessage(res.error);
				setError(message);
				toast.error(message);
			}
		} catch {
			const message = settlementErrorMessage('Netzwerkfehler');
			setError(message);
			toast.error(message);
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
				splits: preview.splits.map(({ id, amountCents }) => ({ id, amountCents })),
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
				memberToken,
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
					? 'Diese Verrechnung hat keine direkt zuordenbaren Anteile. Prüft die ursprünglichen Ausgaben einzeln.'
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

	const iOwe = debt.fromId === currentMemberId;
	const owedToMe = debt.toId === currentMemberId;

	return (
		<Item size="sm" className="items-center gap-x-2.5 px-0 py-1.5">
			<div aria-hidden className="flex shrink-0 items-center -space-x-1.5">
				<MemberAvatar name={debt.fromName} size={24} className="ring-2 ring-card" />
				<MemberAvatar name={debt.toName} size={24} className="ring-2 ring-card" />
			</div>
			<ItemContent className="min-w-0">
				<ItemTitle className="line-clamp-none text-sm font-normal break-words">
					{iOwe ? 'Du' : debt.fromName} {iOwe ? 'schuldest' : 'schuldet'}{' '}
					{owedToMe ? 'dir' : debt.toName}
				</ItemTitle>
			</ItemContent>
			<span
				className={cn(
					'shrink-0 font-mono text-sm whitespace-nowrap tabular-nums',
					iOwe ? 'text-destructive' : owedToMe ? 'text-settled' : 'text-foreground',
				)}
			>
				{formatEuroCents(debt.cents, debt.currency)}
			</span>

			{canSettle && (
				<ItemFooter className="justify-start gap-2 [&>*]:min-w-0">
					<Button
						variant={iOwe ? 'default' : 'outline'}
						size="sm"
						className="h-auto whitespace-normal"
						disabled={reviewing || settling}
						onClick={() => void review()}
					>
						{reviewing && <Spinner data-icon="inline-start" />}
						{reviewing ? 'Wird geprüft…' : 'Ausgleichen'}
					</Button>
					{owedToMe && (
						<RemindButton
							shareCode={shareCode}
							debtorMemberId={debt.fromId}
							creditorMemberId={debt.toId}
							currency={debt.currency ?? 'EUR'}
							currentMemberId={currentMemberId}
							memberToken={memberToken}
							size="sm"
						/>
					)}
					{PAYPAL_ENABLED && !payeeMerchantId && owedToMe && (
						<div className="col-span-full min-w-0">
							<p className="text-sm text-muted-foreground">
								Verbinde PayPal, damit andere Mitglieder dir Geld senden können.
							</p>
							<Link
								href={`/wg/${encodeURIComponent(shareCode)}/einstellungen`}
								className={cn(buttonVariants({ variant: 'link' }), 'min-h-11 justify-start px-0')}
							>
								PayPal verbinden
							</Link>
						</div>
					)}
					{PAYPAL_ENABLED && !payeeMerchantId && iOwe && (
						<p className="col-span-full text-sm text-muted-foreground">
							PayPal-Zahlungen sind erst möglich, wenn {debt.toName} PayPal verbunden hat.
						</p>
					)}
					{canPayWithPayPal && (
						<Collapsible className="basis-full">
							<CollapsibleTrigger
								render={<Button variant="outline" className="w-full justify-between" />}
							>
								Mit PayPal zahlen
								<ChevronDown data-icon="inline-end" />
							</CollapsibleTrigger>
							<CollapsibleContent>
								<PayPalPaymentButton
									shareCode={shareCode}
									currentMemberId={currentMemberId}
									memberToken={memberToken}
									fromMemberId={debt.fromId}
									toMemberId={debt.toId}
									payeeMerchantId={payeeMerchantId}
									amountCents={debt.cents}
									currency={debt.currency ?? 'EUR'}
									onPaid={onSettled}
								/>
							</CollapsibleContent>
						</Collapsible>
					)}
				</ItemFooter>
			)}
			{error && !reviewOpen && (
				<ItemFooter>
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				</ItemFooter>
			)}
			<AlertDialog
				open={reviewOpen}
				onOpenChange={(open) => {
					if (settling) return;
					setReviewOpen(open);
					// A failed settle attempt's error banner lives inside this dialog;
					// closing it (Cancel/Escape) must not leave it stuck on the row below.
					if (!open) setError(null);
				}}
			>
				<AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
					<AlertDialogHeader>
						<AlertDialogTitle>Bereits erfolgte Zahlung bestätigen</AlertDialogTitle>
						<AlertDialogDescription>
							Bestätige nur, wenn {debt.fromName} den Betrag von{' '}
							{formatEuroCents(preview?.settleableCents ?? 0, debt.currency)} bereits an{' '}
							{debt.toName} gezahlt hat. Nur die unten aufgeführten Anteile werden als beglichen
							vermerkt. Es wird kein Geld überwiesen.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<ItemGroup aria-label="Unterstützte Ausgabenanteile">
						{(preview?.splits ?? []).map((split) => {
							const expense = expenses.find((item) => item.id === split.expenseId);
							return (
								<Item key={split.id} variant="muted" size="xs">
									<ItemContent className="min-w-0">
										<ItemTitle className="line-clamp-none break-words">
											<Link
												href={`/wg/${encodeURIComponent(shareCode)}/ausgaben?highlight=${encodeURIComponent(split.expenseId)}`}
												onClick={() => setReviewOpen(false)}
												className="underline underline-offset-4"
											>
												{expense?.description ?? 'Ausgabe'}
											</Link>
										</ItemTitle>
										<ItemDescription>
											{expense ? formatShortDate(expense.occurredAt) : 'Aktueller offener Anteil'}
										</ItemDescription>
									</ItemContent>
									<Badge variant="outline" className="font-mono tabular-nums">
										{formatEuroCents(split.amountCents, debt.currency)}
									</Badge>
								</Item>
							);
						})}
					</ItemGroup>
					{preview && preview.remainingCents > 0 && (
						<Alert>
							<AlertDescription>
								{formatEuroCents(preview.remainingCents, debt.currency)} des verrechneten Saldos
								sind mit diesen Anteilen nicht verbuchbar und bleiben offen.
							</AlertDescription>
						</Alert>
					)}
					<p className="text-xs text-muted-foreground">
						Diese Anteile wurden aktuell geprüft. Ändern sie sich zwischenzeitlich, musst du die
						Zahlung erneut prüfen.
					</p>

					{preview?.splits.length === 0 && (
						<Alert>
							<AlertDescription>
								Keine direkt zuordenbaren Anteile. Es wird keine Zahlung eingetragen. Prüft die
								ursprünglichen Ausgaben einzeln.
							</AlertDescription>
						</Alert>
					)}
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter className="flex-col">
						<AlertDialogCancel className="min-h-11" disabled={settling}>
							Abbrechen
						</AlertDialogCancel>
						{preview && preview.settleableCents > 0 && (
							<Button
								className="h-auto whitespace-normal"
								disabled={settling || !preview || preview.settleableCents <= 0}
								onClick={() => void settle()}
							>
								{settling && <Spinner data-icon="inline-start" />}
								{settling
									? 'Speichert…'
									: `${formatEuroCents(preview?.settleableCents ?? 0, debt.currency)} als bezahlt eintragen`}
							</Button>
						)}
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Item>
	);
}

// Der eigene Saldo ist die wichtigste Zahl der Seite: groß und in eigener Zeile.
const HERO_AMOUNT = 'block font-mono text-[26px] leading-8 font-semibold tabular-nums';

interface DebtSummaryProps {
	debts: SimplifiedDebt[];
	summary?: SettlementSummary;
	/** Netto-Saldo pro Mitglied für „Details“. */
	balances?: readonly MemberBalance[];
	expenses: readonly Expense[];
	shareCode: string;
	currentMemberId: string;
	memberToken?: string | undefined;
	memberPayPalMerchantId?: (id: string) => string | null;
	onSettled: (message?: string) => void;
}

/**
 * Saldo zuerst (wie Splitwise-Kritik empfiehlt): Wer wem wie viel schuldet, mit
 * Ausgleichen/Erinnern direkt an der Zahl. Paare und Salden liegen unter „Details“.
 */
export function DebtSummary({
	debts,
	summary,
	balances = [],
	expenses,
	shareCode,
	currentMemberId,
	memberToken,
	memberPayPalMerchantId = () => null,
	onSettled,
}: DebtSummaryProps) {
	const { personal, others } = getDebtOverview(debts, currentMemberId, summary);
	if (debts.length === 0 && personal.length === 0 && others.length === 0 && balances.length === 0)
		return null;

	function renderDebt(debt: SimplifiedDebt) {
		return (
			<DebtRow
				key={`${debt.currency ?? 'EUR'}-${debt.fromId}-${debt.toId}`}
				debt={debt}
				expenses={expenses}
				shareCode={shareCode}
				currentMemberId={currentMemberId}
				memberToken={memberToken}
				memberPayPalMerchantId={memberPayPalMerchantId}
				payPalEligible={
					summary === undefined ||
					debts.some(
						(direct) =>
							direct.fromId === debt.fromId &&
							direct.toId === debt.toId &&
							direct.cents >= debt.cents,
					)
				}
				onSettled={onSettled}
			/>
		);
	}

	const ownBalances = balances.filter(
		(member) => member.memberId === currentMemberId && member.balanceCents !== 0,
	);
	const ownBalance = ownBalances.length === 1 ? ownBalances[0] : null;
	// Balken je Währung auf den größten Betrag skaliert, wie bei Tricount.
	const maxByCurrency = new Map<string, number>();
	for (const member of balances) {
		const abs = Math.abs(member.balanceCents);
		if (abs > (maxByCurrency.get(member.currency) ?? 0)) maxByCurrency.set(member.currency, abs);
	}
	const showBalances = balances.length > 1 && maxByCurrency.size > 0;

	return (
		<Card size="sm">
			<CardHeader>
				<CardDescription>Dein Saldo</CardDescription>
				<CardTitle>
					<h2>
						{ownBalances.length > 1 ? (
							<>
								Offene Salden{' '}
								<span className={HERO_AMOUNT}>
									{ownBalances
										.map((balance) =>
											formatEuroCents(balance.balanceCents, balance.currency, { signed: true }),
										)
										.join(' · ')}
								</span>
							</>
						) : ownBalance && ownBalance.balanceCents > 0 ? (
							<>
								Du bekommst{' '}
								<span className={cn(HERO_AMOUNT, 'text-settled')}>
									{formatEuroCents(ownBalance.balanceCents, ownBalance.currency)}
								</span>
							</>
						) : ownBalance ? (
							<>
								Du schuldest{' '}
								<span className={cn(HERO_AMOUNT, 'text-destructive')}>
									{formatEuroCents(Math.abs(ownBalance.balanceCents), ownBalance.currency)}
								</span>
							</>
						) : (
							'Du bist ausgeglichen'
						)}
					</h2>
				</CardTitle>
				<CardAction>
					<Link
						href={`/wg/${encodeURIComponent(shareCode)}/mahnungen`}
						aria-label="Alle Erinnerungen"
						title="Alle Erinnerungen"
						className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }))}
					>
						<History aria-hidden />
					</Link>
				</CardAction>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{/* Salden immer offen: wer vorne und wer hinten liegt, ist der Kern dieser Seite. */}
				{showBalances && (
					<section aria-labelledby="balances-heading" className="flex flex-col gap-2">
						<h3 id="balances-heading" className="text-[12px] font-medium text-muted-foreground">
							Salden
						</h3>
						<ul aria-label="Saldo pro Mitglied" className="flex flex-col gap-2">
							{balances.map((member) => {
								const max = maxByCurrency.get(member.currency) ?? 0;
								const width = max > 0 ? `${(Math.abs(member.balanceCents) / max) * 100}%` : '0%';
								const isMe = member.memberId === currentMemberId;
								return (
									<li
										key={`${member.currency}-${member.memberId}`}
										className="grid grid-cols-[minmax(0,1fr)_minmax(3rem,5rem)_auto] items-center gap-2 text-sm"
									>
										<span className="flex min-w-0 items-center gap-2">
											<MemberAvatar name={member.memberName} size={24} />
											<span className="truncate">{isMe ? 'Du' : member.memberName}</span>
										</span>
										<span aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-muted">
											<span className="flex flex-1 justify-end">
												{member.balanceCents < 0 && (
													<span
														className="h-full rounded-l-full bg-destructive"
														style={{ width }}
													/>
												)}
											</span>
											<span className="flex flex-1">
												{member.balanceCents > 0 && (
													<span className="h-full rounded-r-full bg-settled" style={{ width }} />
												)}
											</span>
										</span>
										<span
											className={cn(
												'text-right font-mono whitespace-nowrap tabular-nums',
												member.balanceCents > 0
													? 'text-settled'
													: member.balanceCents < 0
														? 'text-destructive'
														: 'text-muted-foreground',
											)}
										>
											{member.balanceCents === 0
												? 'ausgeglichen'
												: formatEuroCents(member.balanceCents, member.currency, { signed: true })}
										</span>
									</li>
								);
							})}
						</ul>
					</section>
				)}
				{(personal.length > 0 || others.length > 0) && (
					<section aria-labelledby="settle-heading" className="flex flex-col gap-1">
						<h3 id="settle-heading" className="text-[12px] font-medium text-muted-foreground">
							So wird ausgeglichen
						</h3>
						{personal.length > 0 && (
							<ItemGroup aria-label="Deine offenen Zahlungen" className="gap-0 divide-y">
								{personal.map((debt) => renderDebt(debt))}
							</ItemGroup>
						)}
						{others.length > 0 && (
							<ItemGroup aria-label="Weitere Zahlungen in der WG" className="gap-0 divide-y">
								{others.map((debt) => renderDebt(debt))}
							</ItemGroup>
						)}
					</section>
				)}
			</CardContent>
		</Card>
	);
}
