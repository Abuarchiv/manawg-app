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
import { useConfirmDelete } from '@/core/hooks/useConfirmDelete';
import { formatRelativeTime, parseValidDate } from '@/core/utils/time';
import { getChoreRepairHint, getChoreStatus } from '@/features/chores/chore-status';
import type { Chore, MemberInfo, RecurrenceType } from '@/features/chores/components/chore-types';
import { cn } from '@/shared/lib/cn';
import { Check, Hand, History, MessageSquareMore, MoreHorizontal, Trash2 } from 'lucide-react';
import { type ReactElement, memo, useState } from 'react';

interface ChoreRowProps {
	chore: Chore;
	assignee: MemberInfo;
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
	const needsTakeOver = getChoreRepairHint(chore) !== null;
	const busy = isPending || isTakePending || isSwapPending;

	return (
		<Item
			id={`chore-${chore.id}`}
			render={<li />}
			variant="outline"
			className={cn('scroll-mt-24', highlighted && 'ring-2 ring-inset ring-ring')}
			aria-busy={busy}
		>
			<ItemContent className="min-w-0 basis-40">
				<ItemTitle className="line-clamp-none break-words [overflow-wrap:anywhere]">
					{chore.title}
				</ItemTitle>
				<ItemDescription className="line-clamp-none break-words">
					Zuständig: <span>{assignee.name}</span> ·{' '}
					{formatChoreCadence(chore.intervalDays, chore.recurrenceType)} ·{' '}
					<span className={cn(status.state === 'overdue' && 'font-medium text-foreground')}>
						{status.label}
					</span>
					{status.escalationLabel && ` · ${status.escalationLabel}`}
				</ItemDescription>
				<ItemDescription className="line-clamp-none break-words">
					{nextAssigneeName
						? `Voraussichtlich als Nächstes: ${nextAssigneeName}.`
						: 'Für die nächste Runde ist niemand verfügbar.'}
				</ItemDescription>
				{chore.lastCompletedAt && (
					<ItemDescription className="line-clamp-none">
						Nächste Fälligkeit:{' '}
						{parseValidDate(chore.nextDueAt)?.toLocaleDateString('de-DE') ?? 'unbekannt'}
					</ItemDescription>
				)}
				{chore.lastCompletedAt && chore.lastCompletedByName && (
					<div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
						<History className="size-3.5" aria-hidden />
						<span>
							Zuletzt {formatRelativeTime(chore.lastCompletedAt)} von {chore.lastCompletedByName}
						</span>
					</div>
				)}
				{needsTakeOver && (
					<Button
						variant="link"
						onClick={() => onTakeOver(chore)}
						disabled={busy}
						aria-label={`Aufgabe übernehmen: ${chore.title}`}
						className="self-start px-0"
					>
						{isTakePending && <Spinner data-icon="inline-start" aria-hidden />}Ich übernehme
					</Button>
				)}
			</ItemContent>
			<ItemActions className="ml-auto">
				<Button
					onClick={() => onComplete(chore)}
					disabled={busy}
					variant="outline"
					aria-label={
						status.actionLabel === 'Nachholen'
							? `Aufgabe nachholen: ${chore.title}`
							: `Als erledigt markieren: ${chore.title}`
					}
				>
					{isPending ? (
						<Spinner data-icon="inline-start" aria-hidden />
					) : (
						<Check data-icon="inline-start" aria-hidden />
					)}
					{status.actionLabel}
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
								className="size-9"
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
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => {
									setActionsOpen(false);
									onTakeOver(chore);
								}}
							>
								<Hand data-icon="inline-start" aria-hidden />
								Ich übernehme
							</Button>
							<Button
								variant="outline"
								disabled={busy}
								aria-label={`Tausch anfragen: ${chore.title}`}
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
										<Alert>
											<AlertDescription>
												Diese Aufgabe endgültig entfernen? Das lässt sich nicht rückgängig machen.
											</AlertDescription>
										</Alert>
									)}
									<Button
										variant="destructive"
										disabled={busy}
										aria-label={`${removeConfirm.confirmId === chore.id ? 'Aufgabe entfernen bestätigen' : 'Aufgabe entfernen'}: ${chore.title}`}
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
								? `Voraussichtlich als Nächstes: ${nextAssigneeName}.`
								: 'Aktuell ist niemand für die nächste Runde verfügbar.'}{' '}
							Die Rotation berücksichtigt Aufgaben und Abwesenheiten. Die nächste zuständige Person
							und Fälligkeit werden beim Speichern bestätigt. Der Abschluss bleibt im Verlauf und
							lässt sich hier nicht zurücknehmen.
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
