'use client';

import { buttonVariants } from '@/components/ui/button';
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card';
import { ItemGroup } from '@/components/ui/item';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { formatEuroCents } from '@/core/utils/money';
import type { Expense } from '@/features/expenses/components/ausgaben/expense-types';
import { getDebtOverview, listedMemberBalances } from '@/features/expenses/debt-overview';
import type { SettlementSummary, SimplifiedDebt } from '@/features/expenses/debt-reduction';
import { cn } from '@/shared/lib/cn';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { SALDO_HEADING_ID, SettlementDebtRow } from './SettlementDebtRow';

interface MemberBalance {
	memberId: string;
	memberName: string;
	currency: string;
	balanceCents: number;
	/** False for members who moved out. */
	active?: boolean;
}

// The member's own balance is the page's key number: larger than body text, in the heading row.
const HERO_AMOUNT = 'font-mono text-[20px] leading-6 font-semibold tabular-nums';

interface DebtSummaryProps {
	debts: SimplifiedDebt[];
	summary?: SettlementSummary;
	/** Net balance per member for the balance list. */
	balances?: readonly MemberBalance[];
	expenses: readonly Expense[];
	shareCode: string;
	currentMemberId: string;
	memberPayPalMerchantId?: (id: string) => string | null;
	onSettled: (message?: string) => void;
}

/**
 * Balance first: who owes whom how much, with settle/remind right at the number.
 * The per-member balances follow below.
 */
export function DebtSummary({
	debts,
	summary,
	balances = [],
	expenses,
	shareCode,
	currentMemberId,
	memberPayPalMerchantId = () => null,
	onSettled,
}: DebtSummaryProps) {
	const { personal, others } = getDebtOverview(debts, currentMemberId, summary);
	if (debts.length === 0 && personal.length === 0 && others.length === 0 && balances.length === 0)
		return null;

	const hinted = new Set<string>();
	function renderDebt(debt: SimplifiedDebt) {
		const hintKey =
			debt.toId === currentMemberId
				? 'me'
				: debt.fromId === currentMemberId
					? `to:${debt.toId}`
					: null;
		const showPayPalHint = hintKey !== null && !hinted.has(hintKey);
		if (hintKey) hinted.add(hintKey);
		return (
			<SettlementDebtRow
				key={`${debt.currency ?? 'EUR'}-${debt.fromId}-${debt.toId}`}
				debt={debt}
				expenses={expenses}
				shareCode={shareCode}
				currentMemberId={currentMemberId}
				memberPayPalMerchantId={memberPayPalMerchantId}
				showPayPalHint={showPayPalHint}
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

	const shownBalances = listedMemberBalances(balances, (member) => member.active !== false);
	const ownBalances = balances.filter(
		(member) => member.memberId === currentMemberId && member.balanceCents !== 0,
	);
	const ownBalance = ownBalances.length === 1 ? ownBalances[0] : null;
	// The own row is already in the heading; only drop it while the list stays visible.
	const listedBalances =
		ownBalance && shownBalances.length > 1
			? shownBalances.filter((m) => m !== ownBalance)
			: shownBalances;
	const showBalances = shownBalances.length > 1 && listedBalances.length > 0;

	return (
		<Card size="sm">
			<CardHeader>
				<CardDescription>Dein Saldo</CardDescription>
				<CardTitle>
					<h2 id={SALDO_HEADING_ID} tabIndex={-1} className="outline-none">
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
						<Bell aria-hidden />
					</Link>
				</CardAction>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{/* Balances always open: who is ahead and who is behind is the core of this page. */}
				{showBalances && (
					<section aria-labelledby="balances-heading" className="flex flex-col gap-2">
						<h3 id="balances-heading" className="text-[12px] font-medium text-muted-foreground">
							Salden
						</h3>
						<ul aria-label="Saldo pro Mitglied" className="flex flex-col gap-1.5">
							{listedBalances.map((member) => {
								const isMe = member.memberId === currentMemberId;
								return (
									<li
										key={`${member.currency}-${member.memberId}`}
										className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-sm"
									>
										<span className="flex min-w-0 flex-1 basis-32 items-center gap-2">
											<MemberAvatar name={member.memberName} size={24} />
											<span className="min-w-0 whitespace-normal break-words">
												{isMe ? 'Du' : member.memberName}
											</span>
										</span>
										<span
											className={cn(
												'ml-auto shrink-0 text-right font-mono whitespace-nowrap tabular-nums',
												member.balanceCents === 0
													? 'text-muted-foreground'
													: !isMe
														? 'text-foreground'
														: member.balanceCents > 0
															? 'text-settled'
															: 'text-destructive',
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
							<ItemGroup
								aria-label="Deine offenen Zahlungen"
								className="gap-0 divide-y [&>[data-slot=item]:not(:last-child)]:border-b-border"
							>
								{personal.map((debt) => renderDebt(debt))}
							</ItemGroup>
						)}
						{others.length > 0 && (
							<ItemGroup
								aria-label="Weitere Zahlungen in der WG"
								className="gap-0 divide-y [&>[data-slot=item]:not(:last-child)]:border-b-border"
							>
								{others.map((debt) => renderDebt(debt))}
							</ItemGroup>
						)}
					</section>
				)}
			</CardContent>
		</Card>
	);
}
