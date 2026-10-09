'use client';

import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { ItemGroup } from '@/components/ui/item';
import { InventoryAddModal } from '@/features/inventory/components/InventoryAddModal';
import { InventoryItemRow } from '@/features/inventory/components/InventoryItemRow';
import { QuickRestockSheet } from '@/features/inventory/components/QuickRestockSheet';
import {
	INVENTORY_CATEGORIES,
	INVENTORY_CATEGORY_LABELS,
	type InventoryCategory,
	type InventoryItemDto,
	type InventoryMutationItemDto,
	groupItemsByCategory,
	isBelowThreshold,
} from '@/features/inventory/inventory';
import { cn } from '@/shared/lib/cn';
import { Package, ShoppingBasket, Zap } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a row stays in its group after +/- so it does not jump away under the thumb. */
const REGROUP_DELAY_MS = 1500;

interface InventoryListProps {
	items: InventoryItemDto[];
	shareCode: string;
	memberId: string;
	onChanged: (item?: InventoryMutationItemDto, deletedId?: string) => void;
	addOpen: boolean;
	onAddOpenChange: (open: boolean) => void;
	highlightedId?: string | null;
}

export function InventoryList({
	items,
	shareCode,
	memberId,
	onChanged,
	addOpen,
	onAddOpenChange: setAddOpen,
	highlightedId = null,
}: InventoryListProps) {
	const [quickOpen, setQuickOpen] = useState(false);
	const [editing, setEditing] = useState<InventoryItemDto | null>(null);
	const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
	// Scarce items are collected at the top, the rest stays sorted by category. A known
	// row's group only changes after a rest period; the quantity stays live.
	const settledLowRef = useRef(new Map<string, boolean>());
	const [, setRegroupTick] = useState(0);
	const settledLow = settledLowRef.current;
	for (const item of items) {
		if (!settledLow.has(item.id)) settledLow.set(item.id, isBelowThreshold(item));
	}
	useEffect(() => {
		const timer = window.setTimeout(() => {
			settledLowRef.current = new Map(items.map((item) => [item.id, isBelowThreshold(item)]));
			setRegroupTick((tick) => tick + 1);
		}, REGROUP_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [items]);
	const isLow = (item: InventoryItemDto): boolean =>
		settledLow.get(item.id) ?? isBelowThreshold(item);
	const lowItems = items.filter(isLow);
	const grouped = groupItemsByCategory(items.filter((item) => !isLow(item)));
	const isEmpty = items.length === 0;
	const hasQuickRestockItems = items.some(
		(item) => isBelowThreshold(item) || item.decrementCount30d > 0,
	);

	const openEdit = useCallback((item: InventoryItemDto): void => {
		setEditing(item);
	}, []);

	return (
		<div className="flex flex-col gap-4">
			{!isEmpty && hasQuickRestockItems && (
				<Button
					type="button"
					variant="outline"
					onClick={() => setQuickOpen(true)}
					className="self-start"
				>
					<Zap data-icon="inline-start" aria-hidden />
					Schnell nachfüllen
				</Button>
			)}
			{isEmpty ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Package aria-hidden />
						</EmptyMedia>
						<EmptyTitle>Noch keine Vorräte erfasst</EmptyTitle>
						<EmptyDescription>
							Fällt ein Vorrat unter seine Grenze, landet er automatisch auf der Einkaufsliste.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="flex flex-col gap-4">
					{lowItems.length > 0 && (
						<section aria-labelledby="inventory-low" className="flex flex-col gap-2">
							<h2 id="inventory-low" className="text-sm font-medium text-muted-foreground">
								Bald leer ({lowItems.length})
							</h2>
							<Card className="py-0">
								<CardContent className="p-0">
									<ItemGroup className="gap-0 divide-y divide-border">
										{lowItems.map((item) => (
											<InventoryItemRow
												key={item.id}
												item={item}
												highlighted={item.id === highlightedId}
												shareCode={shareCode}
												memberId={memberId}
												onChanged={onChanged}
												onEdit={openEdit}
												deleteArmed={armedDeleteId === item.id}
												onDeleteArmedChange={setArmedDeleteId}
											/>
										))}
									</ItemGroup>
								</CardContent>
							</Card>
							<Link
								href={`/wg/${encodeURIComponent(shareCode)}/einkauf`}
								className={cn(buttonVariants({ variant: 'outline' }), 'self-start')}
							>
								<ShoppingBasket data-icon="inline-start" aria-hidden />
								Einkaufsliste öffnen
							</Link>
						</section>
					)}
					{INVENTORY_CATEGORIES.filter(
						(category): category is InventoryCategory => grouped[category].length > 0,
					).map((category) => (
						<section
							key={category}
							aria-labelledby={`inventory-${category}`}
							className="flex flex-col gap-2"
						>
							<h2
								id={`inventory-${category}`}
								className="text-sm font-medium text-muted-foreground"
							>
								{INVENTORY_CATEGORY_LABELS[category]} ({grouped[category].length})
							</h2>
							<Card className="py-0">
								<CardContent className="p-0">
									<ItemGroup className="gap-0 divide-y divide-border">
										{grouped[category].map((item) => (
											<InventoryItemRow
												key={item.id}
												item={item}
												highlighted={item.id === highlightedId}
												shareCode={shareCode}
												memberId={memberId}
												onChanged={onChanged}
												onEdit={openEdit}
												deleteArmed={armedDeleteId === item.id}
												onDeleteArmedChange={setArmedDeleteId}
											/>
										))}
									</ItemGroup>
								</CardContent>
							</Card>
						</section>
					))}
				</div>
			)}

			<InventoryAddModal
				open={addOpen || editing !== null}
				shareCode={shareCode}
				memberId={memberId}
				mode={editing ? 'edit' : 'create'}
				initial={editing}
				items={items}
				onItemRefreshed={setEditing}
				onClose={() => {
					setAddOpen(false);
					setEditing(null);
				}}
				onSaved={onChanged}
			/>
			<QuickRestockSheet
				open={quickOpen}
				items={items}
				shareCode={shareCode}
				memberId={memberId}
				onClose={() => setQuickOpen(false)}
				onChanged={onChanged}
			/>
		</div>
	);
}
