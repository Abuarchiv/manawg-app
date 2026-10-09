'use client';

import { Checkbox } from '@/components/animate-ui/components/base/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
	Drawer,
	DrawerClose,
	DrawerContent,
	DrawerDescription,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
	DrawerTrigger,
} from '@/components/ui/drawer';
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemMedia,
	ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { useWg } from '@/components/wg/WgContextProvider';
import { useConfirmDelete } from '@/core/hooks/useConfirmDelete';
import { ShoppingEditForm } from '@/features/shopping/components/ShoppingEditForm';
import type { ShoppingItem } from '@/features/shopping/components/shopping-types';
import type { EditShoppingItem } from '@/features/shopping/hooks/use-shopping-edit';
import { cn } from '@/shared/lib/cn';
import type { MemberInfo } from '@/shared/lib/member-types';
import { Check, MoreHorizontal, Pencil, Receipt, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { memo, useEffect, useRef, useState } from 'react';

// From this swipe distance to the right, the item counts as checked off (or open again).
const SWIPE_TOGGLE_PX = 72;

interface ShoppingItemRowProps {
	item: ShoppingItem;
	adder: MemberInfo;
	buyer: MemberInfo | null;
	pending: boolean;
	queued?: boolean;
	onToggle: (item: ShoppingItem) => void;
	onRemove: (id: string, itemName: string) => void;
	onEdit: EditShoppingItem;
	removeError?: string | null;
	highlighted: boolean;
	shareCode: string;
	canRemove: boolean;
}

export const ShoppingItemRow = memo(function ShoppingItemRow({
	item,
	adder,
	buyer,
	pending,
	queued = false,
	onToggle,
	onRemove,
	onEdit,
	removeError = null,
	highlighted,
	shareCode,
	canRemove,
}: ShoppingItemRowProps) {
	const isBought = item.boughtAt !== null;
	const deleteConfirm = useConfirmDelete();
	const isDeleteArmed = deleteConfirm.confirmId === item.id;
	const { identity } = useWg();
	// The own person is called "dir"/"dich", not by their own name.
	const buyerName = item.boughtByMemberId
		? item.boughtByMemberId === identity.memberId
			? 'dir'
			: buyer?.name
		: null;
	const adderName = item.addedByMemberId === identity.memberId ? 'dir' : adder.name;
	const swipeStartX = useRef<number | null>(null);
	const confirmAlertRef = useRef<HTMLDivElement>(null);
	const editButtonRef = useRef<HTMLButtonElement>(null);
	const wasEditingRef = useRef(false);
	const [swipeX, setSwipeX] = useState(0);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [editing, setEditing] = useState(false);

	// With large text the notice pushes the area over the close bar: bring it into view.
	useEffect(() => {
		if (isDeleteArmed) confirmAlertRef.current?.scrollIntoView({ block: 'nearest' });
	}, [isDeleteArmed]);

	// The form replaces the button: give focus back when it closes (no-op once the drawer is gone).
	useEffect(() => {
		if (!editing && wasEditingRef.current) editButtonRef.current?.focus();
		wasEditingRef.current = editing;
	}, [editing]);

	function endSwipe(): void {
		if (swipeStartX.current !== null && swipeX >= SWIPE_TOGGLE_PX && !pending && !queued) {
			onToggle(item);
		}
		swipeStartX.current = null;
		setSwipeX(0);
	}

	function handleDelete(): void {
		if (!deleteConfirm.request(item.id)) return;
		deleteConfirm.cancel();
		onRemove(item.id, item.name);
	}

	return (
		<li className={cn('relative', swipeX > 0 && 'overflow-hidden')}>
			{/* overflow-hidden only during an active swipe: otherwise it clips the checkbox's
			    invisible tap area (after:-inset-2.5) at the left edge, because the item has
			    px-0 here and the checkbox sits flush. */}
			<div
				aria-hidden
				className={cn(
					'absolute inset-0 flex items-center gap-2 bg-muted px-4 text-sm font-medium',
					swipeX === 0 && 'invisible',
				)}
			>
				{isBought ? <RotateCcw className="size-4" /> : <Check className="size-4" />}
				{isBought ? 'Wieder offen' : 'Gekauft'}
			</div>
			<Item
				data-shopping-row
				id={`shopping-${item.id}`}
				className={cn(
					'relative touch-pan-y scroll-mt-24 rounded-none bg-background py-1 pr-1.5 pl-3',
					swipeX === 0 && 'transition-transform',
					highlighted && 'ring-2 ring-inset ring-ring',
				)}
				style={swipeX > 0 ? { transform: `translateX(${swipeX}px)` } : undefined}
				aria-busy={pending}
				onPointerDown={(event) => {
					// The mouse stays on click; swiping is a touch gesture.
					if (event.pointerType !== 'mouse' && !pending && !queued) {
						swipeStartX.current = event.clientX;
						// Without capture, pointermove/-up would be redirected to a neighboring element
						// on a fast swipe and the row would stay visually stuck.
						event.currentTarget.setPointerCapture(event.pointerId);
					}
				}}
				onPointerMove={(event) => {
					if (swipeStartX.current === null) return;
					setSwipeX(Math.min(Math.max(0, event.clientX - swipeStartX.current), 120));
				}}
				onPointerUp={endSwipe}
				onPointerCancel={() => {
					swipeStartX.current = null;
					setSwipeX(0);
				}}
			>
				<ItemMedia className="size-auto self-center">
					<Checkbox
						checked={isBought}
						onCheckedChange={() => onToggle(item)}
						disabled={pending || queued}
						size="lg"
						className="relative size-6 rounded-md border-foreground/50 after:absolute after:-inset-2.5 [&_svg]:size-3.5"
						aria-label={isBought ? `${item.name} wieder öffnen` : `${item.name} erledigen`}
					/>
				</ItemMedia>
				{/* basis-0 + min-w instead of basis-32: with large text check mark, text and ⋯ stay in one row;
				    the ⋯ only drops below when a word would otherwise break mid-word. */}
				<ItemContent className="min-w-[10ch] basis-0 gap-0.5">
					<ItemTitle
						className={cn(
							'block line-clamp-none [overflow-wrap:break-word]',
							isBought && 'text-muted-foreground line-through',
						)}
					>
						{item.name}
					</ItemTitle>
					<ItemDescription className="line-clamp-1">
						{pending ? (
							<output aria-live="polite" className="flex items-center gap-1">
								<Spinner aria-hidden className="size-3" />
								Speichert…
							</output>
						) : queued ? (
							<output aria-live="polite">Wartet auf Synchronisierung…</output>
						) : (
							[
								item.quantity,
								isBought
									? buyerName
										? `Gekauft von ${buyerName}`
										: 'Gekauft'
									: `von ${adderName}`,
							]
								.filter(Boolean)
								.join(' · ')
						)}
					</ItemDescription>
				</ItemContent>
				<ItemActions className="ml-auto">
					<Drawer
						open={drawerOpen}
						onOpenChange={(open) => {
							setDrawerOpen(open);
							setEditing(false);
							deleteConfirm.cancel();
						}}
					>
						<DrawerTrigger
							render={
								<Button variant="ghost" size="icon" aria-label={`Artikelaktionen: ${item.name}`} />
							}
						>
							<MoreHorizontal aria-hidden />
						</DrawerTrigger>
						<DrawerContent className="mx-auto w-full max-w-md">
							<DrawerHeader>
								<DrawerTitle className="break-words">{item.name}</DrawerTitle>
								<DrawerDescription>
									{item.quantity ? `${item.quantity} · ` : ''}Hinzugefügt von {adderName}
									{isBought
										? buyerName
											? ` · Gekauft von ${buyerName}`
											: ' · Gekauft · Person nicht angegeben'
										: ''}
								</DrawerDescription>
							</DrawerHeader>
							<div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
								{editing ? (
									<ShoppingEditForm
										item={item}
										onSave={(fields) => onEdit(item, fields)}
										onDone={() => setEditing(false)}
									/>
								) : (
									<Button
										ref={editButtonRef}
										type="button"
										variant="outline"
										onClick={() => setEditing(true)}
									>
										<Pencil data-icon="inline-start" aria-hidden />
										Bearbeiten
									</Button>
								)}
								{isBought && (
									<>
										<Button
											nativeButton={false}
											render={
												<Link
													href={`/wg/${encodeURIComponent(shareCode)}/ausgaben?${new URLSearchParams({ desc: item.name, source: 'shopping', ...(item.boughtByMemberId ? { paidBy: item.boughtByMemberId } : {}) })}`}
												/>
											}
										>
											<Receipt data-icon="inline-start" aria-hidden />
											Als Ausgabe übernehmen
										</Button>
										<p className="text-sm text-muted-foreground">
											Betrag und Aufteilung prüfst du vor dem Speichern.
										</p>
									</>
								)}
								{canRemove && isDeleteArmed && (
									<Alert ref={confirmAlertRef}>
										<AlertDescription>
											„{item.name}“ endgültig entfernen? Das lässt sich nicht rückgängig machen.
										</AlertDescription>
									</Alert>
								)}
								{removeError && (
									<Alert variant="destructive">
										<AlertDescription>{removeError}</AlertDescription>
									</Alert>
								)}
							</div>
							<DrawerFooter className="pb-[max(1rem,env(safe-area-inset-bottom))]">
								{canRemove && (
									<Button
										type="button"
										variant="destructive"
										onClick={handleDelete}
										disabled={pending}
										aria-label={
											isDeleteArmed
												? `Endgültig entfernen: ${item.name}`
												: `Artikel entfernen: ${item.name}`
										}
									>
										<Trash2 data-icon="inline-start" aria-hidden />
										{isDeleteArmed ? 'Endgültig entfernen' : 'Artikel entfernen'}
									</Button>
								)}
								{!canRemove && (
									<p className="text-sm text-muted-foreground">
										Nur die Person, die den Artikel hinzugefügt hat, oder ein WG-Admin kann ihn
										entfernen.
									</p>
								)}
								<DrawerClose render={<Button variant="outline" />}>Schließen</DrawerClose>
							</DrawerFooter>
						</DrawerContent>
					</Drawer>
				</ItemActions>
			</Item>
		</li>
	);
});
