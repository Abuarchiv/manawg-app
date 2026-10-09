'use client';

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
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
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from '@/components/ui/empty';
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemFooter,
	ItemGroup,
	ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { formatEuroCents } from '@/core/utils/money';
import { formatRelativeTime, formatShortDate, parseTimestamp } from '@/core/utils/time';
import {
	canBookRecurringTemplate,
	canManageRecurringTemplate,
	getRecurringExpenseHref,
	wasRecurringExpenseAlreadyCreated,
} from '@/features/expenses/recurring-expenses';
import { cn } from '@/shared/lib/cn';
import { ChevronDown, MoreHorizontal, Pencil, Repeat2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { RecurringExpense } from './expense-types';

interface RecurringExpensesSectionProps {
	recurringExpenses: RecurringExpense[];
	recurringFilterActive: boolean;
	wgBaseHref: string;
	shareCode: string;
	hiddenRecurringCount: number;
	visibleRecurringExpenses: RecurringExpense[];
	recurringId: string | null;
	recurringActionPending: boolean;
	creatingRecurringId: string | null;
	isPending: (id: string) => boolean;
	onCreateFromTemplate: (item: RecurringExpense) => void;
	onEditTemplate: (item: RecurringExpense) => void;
	onDeleteTemplate: (item: RecurringExpense) => void;
	onPrepareNewExpense: () => void;
	memberName: (id: string) => string;
	currentMemberId: string;
	isAdmin: boolean;
}

export function RecurringExpensesSection({
	recurringExpenses,
	recurringFilterActive,
	wgBaseHref,
	shareCode,
	hiddenRecurringCount,
	visibleRecurringExpenses,
	recurringId,
	recurringActionPending,
	creatingRecurringId,
	isPending,
	onCreateFromTemplate,
	onEditTemplate,
	onDeleteTemplate,
	onPrepareNewExpense,
	memberName,
	currentMemberId,
	isAdmin,
}: RecurringExpensesSectionProps): React.ReactElement {
	const [open, setOpen] = useState(recurringFilterActive || recurringId !== null);
	const [deleteCandidate, setDeleteCandidate] = useState<RecurringExpense | null>(null);
	// The dialog has no trigger; after deletion the row that focus would return to is gone.
	const triggerRef = useRef<HTMLButtonElement>(null);
	const deletedRef = useRef(false);
	useEffect(() => {
		if (recurringFilterActive || recurringId) setOpen(true);
	}, [recurringFilterActive, recurringId]);
	return (
		<>
			<Collapsible
				id="recurring-expenses"
				open={open}
				onOpenChange={setOpen}
				className="scroll-mt-24"
			>
				{recurringFilterActive && <h2 className="text-base font-semibold">Fixkosten-Fokus</h2>}
				<CollapsibleTrigger
					ref={triggerRef}
					render={<Button variant="outline" className="w-full justify-start" />}
				>
					<Repeat2 data-icon="inline-start" />
					Fixkosten<Badge variant="secondary">{recurringExpenses.length}</Badge>
					<ChevronDown data-icon="inline-end" className={cn('ml-auto', open && 'rotate-180')} />
				</CollapsibleTrigger>
				<CollapsiblePanel>
					<div className="flex flex-col gap-3 pt-3">
						{hiddenRecurringCount > 0 && (
							<Link
								href={`${wgBaseHref}/ausgaben?filter=recurring`}
								className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11')}
							>
								Alle {recurringExpenses.length} Fixkosten anzeigen
							</Link>
						)}
						{recurringExpenses.length === 0 ? (
							<Empty>
								<EmptyHeader>
									<EmptyTitle>Noch keine Fixkosten-Vorlage</EmptyTitle>
									<EmptyDescription>Betrag und Aufteilung einmal vorbereiten.</EmptyDescription>
								</EmptyHeader>
								<EmptyContent>
									<Button onClick={onPrepareNewExpense}>Neue Ausgabe vorbereiten</Button>
								</EmptyContent>
							</Empty>
						) : (
							<ItemGroup>
								{visibleRecurringExpenses.map((item) => {
									const paused = Boolean(item.pausedAt);
									const alreadyCreated = !paused && wasRecurringExpenseAlreadyCreated(item);
									const nextDueAt = parseTimestamp(item.nextDueAt);
									const due = !paused && nextDueAt !== null && nextDueAt <= Date.now();
									const pending = recurringActionPending || isPending(item.id);
									const canManage = canManageRecurringTemplate(item, currentMemberId, isAdmin);
									// The server refuses a booking for someone else's payment without a share of one's own.
									const canBook = canBookRecurringTemplate(item, currentMemberId);
									const primary = (due && canBook) || alreadyCreated;
									const menu =
										canManage || canBook ? (
											<ItemActions className="shrink-0 self-start">
												<DropdownMenu>
													<DropdownMenuTrigger
														render={<Button variant="ghost" size="icon" />}
														disabled={pending}
														aria-label={`Fixkosten-Aktionen: ${item.description}`}
													>
														<MoreHorizontal aria-hidden />
													</DropdownMenuTrigger>
													<DropdownMenuContent
														align="end"
														className="w-52 max-w-[calc(100vw-2rem)]"
													>
														<DropdownMenuGroup>
															{canManage && (
																<DropdownMenuItem
																	onClick={() => onEditTemplate(item)}
																	disabled={pending}
																	className="min-h-11"
																	aria-label={`Fixkosten-Vorlage bearbeiten: ${item.description}`}
																>
																	<Pencil aria-hidden />
																	Vorlage bearbeiten
																</DropdownMenuItem>
															)}
															{canBook && (
																<DropdownMenuItem
																	render={
																		<Link href={getRecurringExpenseHref(shareCode, item.id)} />
																	}
																	disabled={pending || paused}
																	className="min-h-11"
																	aria-label={`Fixkosten-Ausgabe manuell erfassen: ${item.description}`}
																>
																	Manuell erfassen
																</DropdownMenuItem>
															)}
															{canManage && (
																<DropdownMenuItem
																	variant="destructive"
																	onClick={() => setDeleteCandidate(item)}
																	disabled={pending}
																	className="min-h-11"
																	aria-label={`Fixkosten-Vorlage löschen: ${item.description}`}
																>
																	<Trash2 aria-hidden />
																	Löschen
																</DropdownMenuItem>
															)}
														</DropdownMenuGroup>
													</DropdownMenuContent>
												</DropdownMenu>
											</ItemActions>
										) : null;
									return (
										<Item
											key={item.id}
											id={`recurring-${item.id}`}
											variant="outline"
											className={cn('scroll-mt-24', item.id === recurringId && 'ring-2 ring-ring')}
										>
											<ItemContent className="min-w-0">
												<ItemTitle className="line-clamp-none break-words">
													{item.description}
												</ItemTitle>
												<ItemDescription className="line-clamp-none">
													<span className="font-mono tabular-nums">
														{formatEuroCents(item.amountCents, item.currency)}
													</span>{' '}
													· bezahlt von {memberName(item.paidByMemberId)} ·{' '}
													{paused ? 'pausiert' : `fällig ${formatShortDate(item.nextDueAt)}`}
													{item.lastCreatedAt
														? ` · zuletzt ${formatRelativeTime(item.lastCreatedAt)}`
														: ''}
												</ItemDescription>
												<div className="flex flex-wrap gap-1.5 pt-1">
													{item.splits.map((split) => (
														<Badge
															key={split.debtorMemberId}
															variant="secondary"
															className="whitespace-normal"
														>
															{memberName(split.debtorMemberId)}:{' '}
															<span className="font-mono tabular-nums">
																{formatEuroCents(split.amountCents, item.currency)}
															</span>
														</Badge>
													))}
												</div>
												{alreadyCreated && (
													<ItemDescription className="line-clamp-none">
														Für diese Fälligkeit vermutlich schon übernommen.
													</ItemDescription>
												)}
												{due && !alreadyCreated && !canBook && (
													<ItemDescription className="line-clamp-none">
														Nur beteiligte Personen können diese Fixkosten erfassen.
													</ItemDescription>
												)}
											</ItemContent>
											{!primary && menu}
											{primary && (
												<ItemFooter className="flex-row items-center justify-end gap-2">
													{due && !alreadyCreated && canBook ? (
														<Button
															className="flex-1"
															onClick={() => onCreateFromTemplate(item)}
															disabled={pending}
															aria-label={`Fixkosten-Ausgabe direkt erstellen: ${item.description}`}
														>
															{creatingRecurringId === item.id && (
																<Spinner data-icon="inline-start" />
															)}
															Erfassen
														</Button>
													) : alreadyCreated ? (
														<Link
															href={getRecurringExpenseHref(shareCode, item.id)}
															className={cn(
																buttonVariants({ variant: 'outline', className: 'flex-1' }),
																pending && 'pointer-events-none opacity-50',
															)}
															aria-disabled={pending || undefined}
															tabIndex={pending ? -1 : undefined}
															aria-label={`Fixkosten-Ausgabe prüfen: ${item.description}`}
															onClick={(event) => {
																if (pending) event.preventDefault();
															}}
														>
															Prüfen
														</Link>
													) : null}
													{menu}
												</ItemFooter>
											)}
										</Item>
									);
								})}
							</ItemGroup>
						)}
					</div>
				</CollapsiblePanel>
			</Collapsible>
			<AlertDialog
				open={deleteCandidate !== null}
				onOpenChange={(next) => {
					if (!next) setDeleteCandidate(null);
				}}
			>
				<AlertDialogContent
					finalFocus={() => {
						if (!deletedRef.current) return true;
						deletedRef.current = false;
						return triggerRef.current;
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle>Vorlage löschen?</AlertDialogTitle>
						<AlertDialogDescription>
							„{deleteCandidate?.description}“ wird entfernt. Bereits erfasste Ausgaben bleiben
							erhalten.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel className="min-h-11">Abbrechen</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							className="min-h-11"
							disabled={recurringActionPending}
							onClick={() => {
								if (deleteCandidate) {
									deletedRef.current = true;
									onDeleteTemplate(deleteCandidate);
								}
								setDeleteCandidate(null);
							}}
						>
							Löschen
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
