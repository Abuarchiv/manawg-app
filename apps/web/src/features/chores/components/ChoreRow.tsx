'use client';

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
import { getChoreRepairHint, getChoreStatus } from '@/features/chores/chore-status';
import type { Chore, MemberInfo, RecurrenceType } from '@/features/chores/components/chore-types';
import { cn } from '@/shared/lib/cn';
import { Check, Hand, MessageSquareMore, MoreHorizontal, Trash2 } from 'lucide-react';
import { type ReactElement, memo, useState } from 'react';

interface ChoreRowProps {
	chore: Chore;
	assignee: MemberInfo;
	isMine: boolean;
	isAdmin: boolean;
	isPending: boolean;
	isSwapPending: boolean;
	isTakePending: boolean;
	isCompleteArmed: boolean;
	completeError: string | null;
	nextAssigneeName: string | null;
	onCancelComplete: () => void;
	onComplete: (chore: Chore) => void;
	onSwapRequest: (chore: Chore) => void;
	onTakeOver: (chore: Chore) => void;
	onRemove: (id: string) => void;
	highlighted: boolean;
}

function formatChoreCadence(interval: number, type: RecurrenceType): string {
	if (interval <= 0) return 'einmalig';
	if (type === 'months') {
		if (interval === 1) return 'monatlich';
		if (interval === 3) return 'quartalsweise';
		if (interval === 6) return 'halbjährlich';
		if (interval === 12) return 'jährlich';
		return `alle ${interval} Mon.`;
	}
	if (interval === 1) return 'täglich';
	if (interval === 7) return 'wöchentlich';
	if (interval === 14) return 'alle 14 T.';
	return `alle ${interval} T.`;
}

export const ChoreRow = memo(function ChoreRow({
	chore,
	assignee,
	isMine,
	isAdmin,
	isPending,
	isSwapPending,
	isTakePending,
	isCompleteArmed,
	completeError,
	nextAssigneeName,
	onCancelComplete,
	onComplete,
	onSwapRequest,
	onTakeOver,
	onRemove,
	highlighted,
}: ChoreRowProps): ReactElement {
	const [actionsOpen, setActionsOpen] = useState(false);
	const removeConfirm = useConfirmDelete();
	const status = getChoreStatus(chore.nextDueAt);
	// Taking over your own chore is a no-op, so the shortcut only shows for others'.
	const needsTakeOver = !isMine && getChoreRepairHint(chore) !== null;
	const cadence = formatChoreCadence(chore.intervalDays, chore.recurrenceType);
	const busy = isPending || isTakePending || isSwapPending;

	return (
		<Item
			id={`chore-${chore.id}`}
			render={<li />}
			className={cn(
				'scroll-mt-24 rounded-none py-2 pr-1.5',
				highlighted && 'ring-2 ring-inset ring-ring',
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
			{/* Mindestbreite in rem: bei großer Schrift rutschen die Knöpfe unter den Titel statt ihn zu zerquetschen. */}
			<ItemContent className="min-w-[7rem] gap-0.5">
				<ItemTitle className="line-clamp-none w-auto break-words text-[14px] [overflow-wrap:anywhere]">
					{chore.title}
				</ItemTitle>
				<ItemDescription className="line-clamp-none break-words text-[12px]">
					<span className="sr-only">Zuständig: {isMine ? 'du' : assignee.name} · </span>
					<span className={cn(status.state === 'overdue' && 'font-medium text-foreground')}>
						{status.label}
					</span>
					{' · '}
					{cadence}
					{nextAssigneeName && ` · danach ${nextAssigneeName}`}
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
			<ItemActions className="ml-auto flex-nowrap gap-0.5">
				<Button
					onClick={() => onComplete(chore)}
					disabled={busy}
					variant={status.state === 'planned' ? 'outline' : 'default'}
					size="icon"
					className="size-8 rounded-full"
					aria-label={
						status.actionLabel === 'Nachholen'
							? `Aufgabe nachholen: ${chore.title}`
							: `Als erledigt markieren: ${chore.title}`
					}
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
						<div className="flex flex-col gap-3 overflow-y-auto overscroll-contain p-4">
							<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
								<dt className="text-muted-foreground">Zuständig</dt>
								<dd>{isMine ? 'du' : assignee.name}</dd>
								<dt className="text-muted-foreground">Fällig</dt>
								<dd>
									{parseValidDate(chore.nextDueAt)?.toLocaleDateString('de-DE') ?? 'unbekannt'} (
									{status.label})
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
							{/* Bei der eigenen Aufgabe gäbe es nichts zu übernehmen. */}
							{!isMine && (
								<Button
									variant="outline"
									className="min-h-11 shrink-0"
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
								className="min-h-11 shrink-0"
								disabled={busy}
								aria-label={`Tausch auf der Pinnwand anfragen: ${chore.title}`}
								onClick={() => {
									setActionsOpen(false);
									onSwapRequest(chore);
								}}
							>
								<MessageSquareMore data-icon="inline-start" aria-hidden />
								Tausch auf der Pinnwand anfragen
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
										className="min-h-11 shrink-0"
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
							<DrawerClose render={<Button variant="outline" />}>Schließen</DrawerClose>
						</DrawerFooter>
					</DrawerContent>
				</Drawer>
			</ItemActions>
			<AlertDialog
				open={isCompleteArmed}
				onOpenChange={(next) => {
					if (!next && !busy) onCancelComplete();
				}}
			>
				<AlertDialogContent className="w-[calc(100%-2rem)]">
					<AlertDialogHeader>
						<AlertDialogTitle>„{chore.title}“ erledigt?</AlertDialogTitle>
						<AlertDialogDescription>
							{nextAssigneeName
								? `Danach ist ${nextAssigneeName} dran.`
								: 'Für die nächste Runde ist gerade niemand verfügbar.'}{' '}
							Lässt sich nicht rückgängig machen.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{completeError && (
						<Alert variant="destructive">
							<AlertDescription>{completeError}</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy} className="min-h-11">
							Abbrechen
						</AlertDialogCancel>
						<Button
							onClick={() => onComplete(chore)}
							disabled={busy}
							aria-label={`${status.actionLabel} bestätigen: ${chore.title}`}
						>
							{status.actionLabel} bestätigen
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Item>
	);
});
