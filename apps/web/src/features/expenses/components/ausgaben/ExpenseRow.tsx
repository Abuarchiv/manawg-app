'use client';

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { formatEuroCents } from '@/core/utils/money';
import { formatTimeFull } from '@/core/utils/time';
import { type ExpenseImpact, getExpenseImpact } from '@/features/expenses/expense-impact';
import { cn } from '@/shared/lib/cn';
import { Check, MoreHorizontal, Pencil, Receipt, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';
import type { Expense, ExpenseSplit } from './expense-types';

const IMPACT_LABEL: Record<ExpenseImpact['kind'], string> = {
	lent: 'bekommst du',
	owe: 'schuldest du',
	settled: 'beglichen',
	own: 'nur für dich',
	none: 'nicht beteiligt',
};

interface ExpenseRowProps {
	expense: Expense;
	expanded: boolean;
	onToggleExpand: (id: string) => void;
	onDelete: (id: string) => void;
	onEdit: (expense: Expense) => void;
	onToggleSettle: (expenseId: string, split: ExpenseSplit) => void;
	pendingIds: ReadonlySet<string>;
	memberName: (id: string) => string;
	currentMemberId: string;
	highlighted: boolean;
}

export const ExpenseRow = memo(function ExpenseRow({
	expense,
	expanded,
	onToggleExpand,
	onDelete,
	onEdit,
	onToggleSettle,
	pendingIds,
	memberName,
	currentMemberId,
	highlighted,
}: ExpenseRowProps) {
	const isPayer = expense.paidByMemberId === currentMemberId;
	// The server lets only the payer or a debtor remove an expense.
	const canRemove =
		isPayer || expense.splits.some((split) => split.debtorMemberId === currentMemberId);
	const impact = getExpenseImpact(expense, currentMemberId);
	const who = (id: string) => (id === currentMemberId ? 'Du' : memberName(id));
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [settleCandidate, setSettleCandidate] = useState<ExpenseSplit | null>(null);
	return (
		<li
			id={`expense-${expense.id}`}
			className={cn(
				'scroll-mt-24 [contain-intrinsic-size:auto_4.5rem] [content-visibility:auto]',
				highlighted && 'ring-2 ring-inset ring-ring',
			)}
		>
			<Collapsible open={expanded} onOpenChange={() => onToggleExpand(expense.id)}>
				<Item className="gap-0.5 rounded-none py-1 pr-1.5 pl-3">
					<ItemContent className="min-w-0">
						<CollapsibleTrigger
							render={
								<Button
									variant="ghost"
									className="h-auto w-full items-start justify-start gap-2.5 whitespace-normal px-0 py-1 text-left hover:bg-transparent aria-expanded:bg-transparent"
								/>
							}
						>
							<MemberAvatar name={memberName(expense.paidByMemberId)} size={28} />
							{/* Amount to the right of the text; only when the row gets too narrow (large text) it goes below. */}
							<span className="@container flex min-w-0 flex-1">
								<span className="flex min-w-0 flex-1 flex-col gap-1 @[15rem]:flex-row @[15rem]:gap-3">
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="sr-only">Details öffnen:</span>
										<span className="line-clamp-2 min-w-0 hyphens-auto text-[14px] font-medium leading-snug [overflow-wrap:break-word]">
											{expense.description}
										</span>
										<span className="text-[12px] leading-normal font-normal text-muted-foreground">
											{/* The same amount already appears on the right; on the left only when the share differs. */}
											<span className="whitespace-nowrap">
												{isPayer ? 'Du zahltest' : `${memberName(expense.paidByMemberId)} zahlte`}
												{Math.abs(impact.cents) !== expense.amountCents && (
													<span className="tabular-nums">
														{' '}
														{formatEuroCents(expense.amountCents, expense.currency)}
													</span>
												)}
											</span>
											{expense.imageUrl && (
												<>
													{' · '}
													<Receipt aria-hidden className="inline size-3.5 align-[-2px]" />
													<span className="sr-only">Beleg</span>
												</>
											)}
										</span>
									</span>
									{/* As in Splitwise: the right side shows what the expense means for you. */}
									<span className="flex shrink-0 flex-row flex-wrap items-baseline gap-x-1.5 @[15rem]:flex-col @[15rem]:items-end @[15rem]:gap-0.5 @[15rem]:text-right">
										<span
											className={cn(
												'whitespace-nowrap font-mono text-[14px] leading-snug tabular-nums',
												impact.kind === 'lent'
													? 'text-settled'
													: impact.kind === 'owe'
														? 'text-destructive'
														: 'text-muted-foreground',
											)}
										>
											{formatEuroCents(impact.cents, expense.currency)}
										</span>
										<span className="whitespace-nowrap text-[12px] font-normal text-muted-foreground">
											{IMPACT_LABEL[impact.kind]}
										</span>
									</span>
								</span>
							</span>
						</CollapsibleTrigger>
					</ItemContent>
					<ItemActions className="shrink-0">
						{canRemove && (
							<DropdownMenu>
								<DropdownMenuTrigger
									render={<Button variant="ghost" size="icon" />}
									aria-label={`Aktionen für ${expense.description}`}
								>
									<MoreHorizontal />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuGroup>
										{isPayer && (
											<DropdownMenuItem
												onClick={() => onEdit(expense)}
												disabled={pendingIds.has(expense.id)}
											>
												<Pencil />
												Bearbeiten
											</DropdownMenuItem>
										)}
										<DropdownMenuItem
											variant="destructive"
											onClick={() => setDeleteOpen(true)}
											disabled={pendingIds.has(expense.id)}
										>
											<Trash2 />
											Entfernen
										</DropdownMenuItem>
									</DropdownMenuGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</ItemActions>
					<CollapsibleContent className="w-full pr-1.5 pb-2">
						{/* The week is already a heading; the exact time only appears in the details. */}
						<p className="mb-2 text-xs text-muted-foreground">
							<time dateTime={expense.occurredAt}>{formatTimeFull(expense.occurredAt)}</time>
						</p>
						{expense.imageUrl && (
							<Button
								variant="outline"
								render={
									<a
										href={expense.imageUrl}
										target="_blank"
										rel="noopener noreferrer"
										aria-label="Beleg öffnen"
									>
										<Receipt data-icon="inline-start" />
										Beleg öffnen
									</a>
								}
								nativeButton={false}
								className="mb-3"
							/>
						)}
						<ItemGroup aria-label="Ausgabenanteile" className="gap-1">
							{expense.splits.map((split) => {
								const settled = split.settledAt !== null;
								const ownShare = split.debtorMemberId === expense.paidByMemberId;
								return (
									<Item key={split.id} variant="muted" size="xs" className="flex-wrap">
										<ItemContent className="min-w-0 flex-[1_1_8rem]">
											<ItemTitle className="line-clamp-none break-words">
												{who(split.debtorMemberId)} ·{' '}
												<span className="font-mono tabular-nums">
													{formatEuroCents(split.amountCents, expense.currency)}
												</span>
											</ItemTitle>
											<ItemDescription>
												{ownShare
													? 'Eigener Anteil der zahlenden Person'
													: split.amountCents === 0
														? 'Kein Anteil'
														: settled
															? 'Als beglichen vermerkt'
															: expense.paidByMemberId === currentMemberId
																? 'Offen an dich'
																: `Offen an ${memberName(expense.paidByMemberId)}`}
											</ItemDescription>
										</ItemContent>
										{!ownShare && split.amountCents > 0 && (
											<Button
												variant={settled ? 'secondary' : 'outline'}
												size="sm"
												className="ml-auto"
												onClick={() => setSettleCandidate(split)}
												disabled={pendingIds.has(split.id) || pendingIds.has(expense.id)}
												aria-label={`${settled ? 'Wieder öffnen' : 'Als bezahlt eintragen'}: ${who(split.debtorMemberId)}`}
											>
												{pendingIds.has(split.id) ? (
													<Spinner data-icon="inline-start" />
												) : (
													<Check data-icon="inline-start" />
												)}
												{settled ? 'Wieder öffnen' : 'Bezahlt'}
											</Button>
										)}
									</Item>
								);
							})}
						</ItemGroup>
						{expense.splits.length === 0 && (
							<p className="text-sm text-muted-foreground">Keine Anteile eingetragen.</p>
						)}
					</CollapsibleContent>
				</Item>
			</Collapsible>
			<AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Ausgabe entfernen?</AlertDialogTitle>
						<AlertDialogDescription>
							„{expense.description}“ mit{' '}
							<span className="font-mono tabular-nums">
								{formatEuroCents(expense.amountCents, expense.currency)}
							</span>{' '}
							und den zugehörigen Anteilen wird entfernt.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel className="min-h-11">Abbrechen</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							className="min-h-11"
							disabled={pendingIds.has(expense.id)}
							onClick={() => {
								setDeleteOpen(false);
								onDelete(expense.id);
							}}
						>
							Entfernen
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog
				open={settleCandidate !== null}
				onOpenChange={(open) => {
					if (!open) setSettleCandidate(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{settleCandidate?.settledAt ? 'Zahlung wieder öffnen?' : 'Bereits bezahlt?'}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{settleCandidate && (
								<>
									{who(settleCandidate.debtorMemberId)} ·{' '}
									<span className="font-mono tabular-nums">
										{formatEuroCents(settleCandidate.amountCents, expense.currency)}
									</span>{' '}
									für „{expense.description}“, bezahlt von{' '}
									{isPayer ? 'dir' : memberName(expense.paidByMemberId)}.{' '}
									{settleCandidate.settledAt
										? 'Dieser Anteil wird wieder als offen vermerkt.'
										: 'Dieser Anteil wird als beglichen vermerkt.'}{' '}
									Es wird kein Geld überwiesen.
								</>
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel className="min-h-11">Abbrechen</AlertDialogCancel>
						<AlertDialogAction
							className="min-h-11"
							disabled={
								!settleCandidate || pendingIds.has(settleCandidate.id) || pendingIds.has(expense.id)
							}
							onClick={() => {
								if (settleCandidate) onToggleSettle(expense.id, settleCandidate);
								setSettleCandidate(null);
							}}
						>
							{settleCandidate?.settledAt ? 'Als offen markieren' : 'Zahlung verbuchen'}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</li>
	);
});
