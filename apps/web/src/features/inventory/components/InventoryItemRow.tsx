'use client';

import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/core/infra/api-client';
import { useInventoryQuantity } from '@/features/inventory/hooks/use-inventory-quantity';
import {
	type InventoryItemDto,
	type InventoryMutationItemDto,
	formatQuantity,
} from '@/features/inventory/inventory';
import { Minus, Pencil, Plus, Trash2 } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

interface InventoryItemRowProps {
	item: InventoryItemDto;
	shareCode: string;
	memberId: string;
	onChanged: (item?: InventoryMutationItemDto, deletedId?: string) => void;
	onEdit: (item: InventoryItemDto) => void;
	/** Delete confirmation; the list holds only one armed row so never two are open. */
	deleteArmed: boolean;
	onDeleteArmedChange: (id: string | null) => void;
	/** Deep-link hit (?highlight=<id>): ring around the row. */
	highlighted?: boolean;
}

// While a request runs, focus stays on the button (aria-disabled instead of disabled).
const BUSY_CLASS = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';

/** How long "Entfernen/Abbrechen" stays before the row falls back. */
const DELETE_CONFIRM_MS = 6000;

type PendingAction = 'delete';

export const InventoryItemRow = memo(function InventoryItemRow({
	item,
	highlighted = false,
	shareCode,
	memberId,
	onChanged,
	onEdit,
	deleteArmed,
	onDeleteArmedChange,
}: InventoryItemRowProps) {
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(shareCode);
	const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
	// Hide a deleted row right away; until the refetch lands it would stay tappable.
	const [removed, setRemoved] = useState(false);
	const rowRef = useRef<HTMLDivElement>(null);
	const trashRef = useRef<HTMLButtonElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const { quantity, action, tap } = useInventoryQuantity({
		item,
		shareCode,
		memberId,
		onChanged,
		onGone: () => {
			setRemoved(true);
			onChanged(undefined, item.id);
		},
	});
	const isDeleteArmed = deleteArmed;
	const pending = action !== null || pendingAction === 'delete';
	const armed = isDeleteArmed || pendingAction === 'delete';

	// Another member deleted the item meanwhile: drop the row instead of offering a retry that can never succeed.
	function dropIfGone(res: { status: number; error?: string }): boolean {
		if (res.status !== 404 || res.error !== 'item_not_found') return false;
		setRemoved(true);
		onChanged(undefined, item.id);
		return true;
	}

	// The row disappears: focus moves to the neighboring row instead of BODY.
	function focusNeighborRow(): void {
		const rows = [...document.querySelectorAll<HTMLElement>('[data-inventory-row]')];
		const index = rows.findIndex((row) => row === rowRef.current);
		const neighbor = rows[index + 1] ?? rows[index - 1];
		const target = neighbor?.querySelector<HTMLElement>('button') ?? document.querySelector('h1');
		requestAnimationFrame(() => target?.focus());
	}

	async function remove(): Promise<void> {
		if (pending) return;
		setPendingAction('delete');
		try {
			const res = await apiFetch(
				`/api/wg/${encodedShareCode}/inventory/${encodeURIComponent(item.id)}`,
				{ method: 'DELETE', memberId },
			);
			if (res.ok) {
				focusNeighborRow();
				setRemoved(true);
				onChanged(undefined, item.id);
			} else if (!dropIfGone(res)) {
				toast.error(`„${item.name}“ konnte nicht entfernt werden. Versuche es erneut.`);
			}
		} finally {
			setPendingAction(null);
		}
	}

	function handleDelete(): void {
		if (pending) return;
		if (!isDeleteArmed) {
			onDeleteArmedChange(item.id);
			// The trash button is swapped out: focus moves to the safe choice.
			requestAnimationFrame(() => cancelRef.current?.focus());
			return;
		}
		onDeleteArmedChange(null);
		void remove();
	}

	function handleCancel(): void {
		if (pending) return;
		onDeleteArmedChange(null);
		requestAnimationFrame(() => trashRef.current?.focus());
	}

	// The confirmation falls back after a few seconds; focus stays in the row meanwhile.
	useEffect(() => {
		if (!isDeleteArmed || pending) return;
		const timer = window.setTimeout(() => {
			const hadFocus = document.activeElement === cancelRef.current;
			onDeleteArmedChange(null);
			if (hadFocus) requestAnimationFrame(() => trashRef.current?.focus());
		}, DELETE_CONFIRM_MS);
		return () => window.clearTimeout(timer);
	}, [isDeleteArmed, pending, onDeleteArmedChange]);

	if (removed) return null;

	return (
		// The wrapper is the group's list item (role=list); it also carries the divider
		// (the group's divide-y) and the jump target for ?highlight=.
		<div
			// biome-ignore lint/a11y/useSemanticElements: ItemGroup ist role=list über <div>, Kinder brauchen role=listitem.
			role="listitem"
			id={`inventory-${item.id}`}
			className="w-full min-w-0"
		>
			<Item
				className={`flex-col items-stretch gap-2 ${highlighted ? 'ring-2 ring-inset ring-ring' : ''}`}
				aria-busy={pending}
			>
				<div
					ref={rowRef}
					data-inventory-row
					className="flex w-full min-w-0 flex-wrap items-center gap-2"
				>
					{/* In confirm mode a smaller base width, so Entfernen/Abbrechen stay in the row
					    and the list below does not jump. */}
					<ItemContent className={armed ? 'min-w-0 flex-[1_1_7rem]' : 'min-w-0 flex-[1_1_6.5rem]'}>
						<ItemTitle className="w-full min-w-0 gap-2 line-clamp-none">
							<span className="min-w-0 flex-1 break-words hyphens-auto" title={item.name}>
								{item.name}
							</span>
						</ItemTitle>
						<ItemDescription className="line-clamp-none tabular-nums">
							{formatQuantity(quantity, item.unit)} · Nachkaufen{'\u00a0'}ab{'\u00a0'}
							{item.threshold}
						</ItemDescription>
					</ItemContent>

					{/* pr-1.5: otherwise the 44 px hit area of the last button sticks out past the row edge. */}
					<ItemActions className="ml-auto flex-wrap justify-end gap-1.5 pr-1.5">
						{!armed && (
							<>
								<Button
									type="button"
									variant="outline"
									size="icon"
									onClick={() => tap(-1)}
									disabled={quantity === 0}
									focusableWhenDisabled
									className={BUSY_CLASS}
									aria-busy={action === 'decrement'}
									aria-label={
										quantity === 0
											? `${item.name} um eins verringern (Bestand 0)`
											: `${item.name} um eins verringern`
									}
								>
									{action === 'decrement' ? <Spinner aria-hidden /> : <Minus aria-hidden />}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="icon"
									onClick={() => tap(1)}
									aria-busy={action === 'increment'}
									aria-label={`${item.name} um eins erhöhen`}
								>
									{action === 'increment' ? <Spinner aria-hidden /> : <Plus aria-hidden />}
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={() => onEdit(item)}
									disabled={pending}
									aria-label={`${item.name} bearbeiten`}
									className="text-muted-foreground"
								>
									<Pencil aria-hidden />
								</Button>
							</>
						)}
						{armed ? (
							<>
								<Button
									type="button"
									variant="destructive"
									size="sm"
									onClick={handleDelete}
									disabled={pending}
									focusableWhenDisabled
									aria-busy={pendingAction === 'delete'}
									aria-label={`Endgültig entfernen: ${item.name}`}
									className={`px-3.5 ${BUSY_CLASS}`}
								>
									{pendingAction === 'delete' && <Spinner aria-hidden />}
									Entfernen
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									ref={cancelRef}
									onClick={handleCancel}
									disabled={pending}
									focusableWhenDisabled
									className={BUSY_CLASS}
									aria-label={`Abbrechen: Löschen von ${item.name}`}
								>
									Abbrechen
								</Button>
							</>
						) : (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								ref={trashRef}
								onClick={handleDelete}
								disabled={pending}
								focusableWhenDisabled
								aria-label={`${item.name} entfernen`}
								className={`text-muted-foreground hover:text-destructive active:text-destructive ${BUSY_CLASS}`}
							>
								<Trash2 aria-hidden />
							</Button>
						)}
					</ItemActions>
				</div>
			</Item>
		</div>
	);
});
