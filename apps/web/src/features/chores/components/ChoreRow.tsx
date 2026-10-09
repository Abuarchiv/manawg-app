'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
	Drawer,
	DrawerClose,
	DrawerContent,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
	DrawerTrigger,
} from '@/components/ui/drawer';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { useConfirmDelete } from '@/core/hooks/useConfirmDelete';
import { formatRelativeTime, parseValidDate } from '@/core/utils/time';
import type { ChoreEditChanges } from '@/features/chores/chore-edit';
import { getChoreRepairHint, getChoreStatus } from '@/features/chores/chore-status';
import {
	ChoreCompleteDialog,
	completeTriggerLabel,
} from '@/features/chores/components/ChoreCompleteDialog';
import { ChoreEditDrawer } from '@/features/chores/components/ChoreEditDrawer';
import type {
	ChoreMember,
	PlanChore,
	RecurrenceType,
} from '@/features/chores/components/chore-types';
import { cn } from '@/shared/lib/cn';
import type { MemberInfo } from '@/shared/lib/member-types';

import { Check, Hand, MessageSquareMore, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { type ReactElement, memo, useState } from 'react';

interface ChoreRowProps {
	chore: PlanChore;
	assignee: MemberInfo;
	members: ChoreMember[];
	isMine: boolean;
	isAdmin: boolean;
	isPending: boolean;
	isSwapPending: boolean;
	isSwapRequested: boolean;
	isTakePending: boolean;
	isEditPending: boolean;
	isCompleteArmed: boolean;
	completeError: string | null;
	nextAssigneeName: string | null;
	onCancelComplete: () => void;
	onComplete: (chore: PlanChore) => void;
	onSwapRequest: (chore: PlanChore) => void;
	onTakeOver: (chore: PlanChore) => void;
	onEdit: (chore: PlanChore, changes: ChoreEditChanges) => Promise<boolean>;
	onRemove: (id: string) => void;
	highlighted: boolean;
}

/** Two-digit like in the form ("06.10.2026"), not "6.10.2026". */
const DUE_DATE_FORMAT = new Intl.DateTimeFormat('de-DE', {
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
	timeZone: 'Europe/Berlin',
});

function formatChoreCadence(interval: number, type: RecurrenceType): string {
	if (interval <= 0) return 'einmalig';
	if (type === 'months') {
		if (interval === 1) return 'monatlich';
		if (interval === 3) return 'quartalsweise';
		if (interval === 6) return 'halbjährlich';
		if (interval === 12) return 'jährlich';
		return `alle ${interval}\u00a0Mon.`;
	}
	if (interval === 1) return 'täglich';
	if (interval === 7) return 'wöchentlich';
	if (interval === 14) return 'alle 14\u00a0T.';
	return `alle ${interval}\u00a0T.`;
}

export const ChoreRow = memo(function ChoreRow({
	chore,
	assignee,
	members,
	isMine,
	isAdmin,
	isPending,
	isSwapPending,
	isSwapRequested,
	isTakePending,
	isEditPending,
	isCompleteArmed,
	completeError,
	nextAssigneeName,
	onCancelComplete,
	onComplete,
	onSwapRequest,
	onTakeOver,
	onEdit,
	onRemove,
	highlighted,
}: ChoreRowProps): ReactElement {
	const [actionsOpen, setActionsOpen] = useState(false);
	const [editOpen, setEditOpen] = useState(false);
	const removeConfirm = useConfirmDelete();
	const status = getChoreStatus(chore.nextDueAt);
	// Taking over your own chore is a no-op, so the shortcut only shows for others'.
	const needsTakeOver = !isMine && getChoreRepairHint(chore) !== null;
	const cadence = formatChoreCadence(chore.intervalDays, chore.recurrenceType);
	const busy = isPending || isTakePending || isSwapPending || isEditPending;
	const dueDate = parseValidDate(chore.nextDueAt);

	return (
		<Item
			id={`chore-${chore.id}`}
			render={<li />}
			className={cn(
				'scroll-mt-24 rounded-none py-2 pr-1.5 transition-colors duration-700 [contain-intrinsic-size:auto_4.5rem] [content-visibility:auto]',
				highlighted && 'bg-primary/10',
			)}
			aria-busy={busy}
		>
			{chore.assignedMemberId ? (
				<MemberAvatar name={assignee.name} size={28} />
			) : (
				<span
					aria-hidden
					className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground"
				>
					?
				</span>
			)}
			{/* Minimum width in rem: with large text the buttons wrap below the title instead of squashing it. */}
			<ItemContent className="min-w-[7rem] gap-0.5">
				<ItemTitle className="line-clamp-none w-auto break-words text-[14px] [overflow-wrap:anywhere]">
					{chore.title}
				</ItemTitle>
				<ItemDescription className="line-clamp-none break-words text-[12px] leading-snug">
					<span className="sr-only">Zuständig: {isMine ? 'du' : assignee.name} · </span>
					<span className={cn(status.state === 'overdue' && 'font-medium text-foreground')}>
						{status.label}
					</span>
					{' · '}
					{cadence}
					{chore.assigneeAbsent && !isMine && ` · ${assignee.name} ist abwesend`}
				</ItemDescription>
				{needsTakeOver && (
					<Button
						variant="link"
						size="sm"
						onClick={() => onTakeOver(chore)}
						disabled={busy}
						aria-label={`Aufgabe übernehmen: ${chore.title}`}
						className="h-auto self-start px-0 text-[12px]"
					>
						{isTakePending && <Spinner data-icon="inline-start" aria-hidden />}Ich übernehme
					</Button>
				)}
			</ItemContent>
			<ItemActions className="ml-auto flex-nowrap gap-3">
				<Button
					onClick={() => {
						if (!busy) onComplete(chore);
					}}
					aria-disabled={busy}
					variant={status.state === 'planned' ? 'outline' : 'default'}
					size="icon"
					className="size-8 rounded-full aria-disabled:opacity-50"
					aria-label={completeTriggerLabel(chore.title, status.actionLabel)}
				>
					{isPending ? <Spinner aria-hidden /> : <Check aria-hidden />}
				</Button>
				<Drawer
					open={actionsOpen}
					onOpenChange={(next) => {
						setActionsOpen(next);
						removeConfirm.cancel();
					}}
				>
					<DrawerTrigger
						render={
							<Button
								variant="ghost"
								size="icon"
								className="size-8"
								aria-label={`Aufgabenaktionen: ${chore.title}`}
							/>
						}
					>
						<MoreHorizontal aria-hidden />
					</DrawerTrigger>
					<DrawerContent className="mx-auto w-full max-w-md data-ending-style:transform-none data-starting-style:transform-none">
						<DrawerHeader>
							<DrawerTitle className="break-words">{chore.title}</DrawerTitle>
						</DrawerHeader>
						<div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-4">
							<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm [&>dd]:break-words">
								<dt className="text-muted-foreground">Zuständig</dt>
								<dd>{isMine ? 'du' : assignee.name}</dd>
								<dt className="text-muted-foreground">Fällig</dt>
								<dd>
									{dueDate ? DUE_DATE_FORMAT.format(dueDate) : 'unbekannt'} ({status.label})
								</dd>
								<dt className="text-muted-foreground">Rhythmus</dt>
								<dd>{cadence}</dd>
								<dt className="text-muted-foreground">Danach</dt>
								<dd>{nextAssigneeName ?? 'niemand verfügbar'}</dd>
								{chore.lastCompletedAt && chore.lastCompletedByName && (
									<>
										<dt className="text-muted-foreground">Zuletzt</dt>
										<dd>
											{formatRelativeTime(chore.lastCompletedAt)} von {chore.lastCompletedByName}
										</dd>
									</>
								)}
							</dl>
							<Button
								variant="outline"
								className="min-h-11 shrink-0 py-2"
								disabled={busy}
								aria-label={`Aufgabe bearbeiten: ${chore.title}`}
								onClick={() => {
									setActionsOpen(false);
									setEditOpen(true);
								}}
							>
								<Pencil data-icon="inline-start" aria-hidden />
								Bearbeiten
							</Button>
							{/* Nothing to take over for the own chore. */}
							{!isMine && (
								<Button
									variant="outline"
									className="min-h-11 shrink-0 py-2"
									disabled={busy}
									onClick={() => {
										setActionsOpen(false);
										onTakeOver(chore);
									}}
								>
									<Hand data-icon="inline-start" aria-hidden />
									Ich übernehme
								</Button>
							)}
							<Button
								variant="outline"
								className="min-h-11 shrink-0 py-2"
								disabled={busy || isSwapRequested}
								aria-label={`${isSwapRequested ? 'Tausch angefragt' : 'Tausch auf der Pinnwand anfragen'}: ${chore.title}`}
								onClick={() => {
									setActionsOpen(false);
									onSwapRequest(chore);
								}}
							>
								<MessageSquareMore data-icon="inline-start" aria-hidden />
								{isSwapRequested ? 'Tausch angefragt' : 'Tausch auf der Pinnwand anfragen'}
							</Button>
							{isAdmin && (
								<>
									{removeConfirm.confirmId === chore.id && (
										<Alert className="shrink-0">
											<AlertDescription>
												Diese Aufgabe endgültig entfernen? Das lässt sich nicht rückgängig machen.
											</AlertDescription>
										</Alert>
									)}
									<Button
										variant="destructive"
										className="min-h-11 shrink-0 py-2"
										disabled={busy}
										aria-label={`${removeConfirm.confirmId === chore.id ? 'Endgültig entfernen' : 'Aufgabe entfernen'}: ${chore.title}`}
										onClick={() => {
											if (removeConfirm.request(chore.id)) {
												setActionsOpen(false);
												onRemove(chore.id);
											}
										}}
									>
										<Trash2 data-icon="inline-start" aria-hidden />
										{removeConfirm.confirmId === chore.id
											? 'Endgültig entfernen'
											: 'Aufgabe entfernen'}
									</Button>
								</>
							)}
						</div>
						<DrawerFooter className="pb-[max(1rem,env(safe-area-inset-bottom))]">
							<DrawerClose render={<Button variant="outline" className="min-h-11 py-2" />}>
								Schließen
							</DrawerClose>
						</DrawerFooter>
					</DrawerContent>
				</Drawer>
			</ItemActions>
			<ChoreEditDrawer
				open={editOpen}
				onOpenChange={setEditOpen}
				chore={chore}
				members={members}
				pending={isEditPending}
				error={editOpen ? completeError : null}
				onSave={(changes) => {
					void onEdit(chore, changes).then((saved) => {
						if (saved) setEditOpen(false);
					});
				}}
			/>
			<ChoreCompleteDialog
				open={isCompleteArmed}
				title={chore.title}
				actionLabel={status.actionLabel}
				busy={busy}
				error={completeError}
				nextAssigneeName={nextAssigneeName}
				onCancel={onCancelComplete}
				onConfirm={() => onComplete(chore)}
			/>
		</Item>
	);
});
