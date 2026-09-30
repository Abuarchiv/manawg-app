'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
	Drawer,
	DrawerClose,
	DrawerContent,
	DrawerDescription,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
} from '@/components/ui/drawer';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { ItemGroup } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import type { InventoryItemDto, InventoryMutationItemDto } from '@/features/inventory/inventory';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';

interface QuickRestockSheetProps {
	open: boolean;
	items: InventoryItemDto[];
	shareCode: string;
	memberId: string;
	memberToken?: string | undefined;
	onClose: () => void;
	onChanged: (item: InventoryMutationItemDto) => void;
}

const QUICK_RESTOCK_LIMIT = 5;

export function QuickRestockSheet({
	open,
	items,
	shareCode,
	memberId,
	memberToken,
	onClose,
	onChanged,
}: QuickRestockSheetProps) {
	const encodedShareCode = encodeURIComponent(shareCode);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const restockRequestKeysRef = useRef(new Map<string, string>());

	const sorted = [...items]
		.filter((item) => item.decrementCount30d > 0 || item.lastDecrementedAt !== null)
		.sort((a, b) => b.decrementCount30d - a.decrementCount30d)
		.slice(0, QUICK_RESTOCK_LIMIT);

	async function quickRestock(item: InventoryItemDto): Promise<void> {
		if (pendingId !== null) return;
		setPendingId(item.id);
		setError(null);
		const idempotencyKey =
			restockRequestKeysRef.current.get(item.id) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setPendingId(null);
			setError('Aktualisierung konnte nicht sicher gesendet werden. Versuche es erneut.');
			return;
		}
		restockRequestKeysRef.current.set(item.id, idempotencyKey);
		const res = await apiFetch<{ item: InventoryMutationItemDto }>(
			`/api/wg/${encodedShareCode}/inventory/${encodeURIComponent(item.id)}`,
			{
				method: 'PATCH',
				memberId,
				memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ quantityDelta: 1 }),
			},
		);
		setPendingId(null);
		if (res.ok) {
			restockRequestKeysRef.current.delete(item.id);
			onChanged(res.data.item);
		} else {
			if (res.status > 0 && res.status < 500) restockRequestKeysRef.current.delete(item.id);
			setError('Aktualisierung fehlgeschlagen.');
		}
	}

	return (
		<Drawer
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DrawerContent className="mx-auto w-full max-w-md">
				<DrawerHeader>
					<DrawerTitle>Schnell nachfüllen</DrawerTitle>
					<DrawerDescription>
						Die fünf am häufigsten verbrauchten Vorräte der letzten 30 Tage.
					</DrawerDescription>
				</DrawerHeader>
				<div
					className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4"
					style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
				>
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					{sorted.length === 0 ? (
						<Empty className="border border-dashed">
							<EmptyHeader>
								<EmptyTitle>Noch keine Verbrauchs-Daten</EmptyTitle>
								<EmptyDescription>
									Sobald Vorräte verbraucht werden, erscheinen hier Vorschläge.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<Card className="py-0">
							<CardContent className="p-0">
								<ItemGroup className="gap-0 divide-y divide-border">
									{sorted.map((item) => (
										<Item key={item.id} className="px-3 py-2.5">
											<ItemContent className="min-w-0 flex-1">
												<ItemTitle className="w-full min-w-0 line-clamp-none">
													<span className="min-w-0 flex-1 break-words text-sm font-medium">
														{item.name}
													</span>
												</ItemTitle>
												<ItemDescription className="text-xs tabular-nums">
													{item.quantity} {item.unit} · {item.decrementCount30d}× in 30 Tagen
												</ItemDescription>
											</ItemContent>
											<ItemActions>
												<Button
													type="button"
													onClick={() => void quickRestock(item)}
													disabled={pendingId !== null}
													aria-busy={pendingId === item.id}
													aria-label={`${item.name} um eins erhöhen`}
												>
													{pendingId === item.id ? <Spinner aria-hidden /> : <Plus aria-hidden />}
													+1
												</Button>
											</ItemActions>
										</Item>
									))}
								</ItemGroup>
							</CardContent>
						</Card>
					)}
				</div>
				<DrawerFooter className="pb-[max(1rem,env(safe-area-inset-bottom))]">
					<DrawerClose render={<Button variant="outline" />}>Schließen</DrawerClose>
				</DrawerFooter>
			</DrawerContent>
		</Drawer>
	);
}
