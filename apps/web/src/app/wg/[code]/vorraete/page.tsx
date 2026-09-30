'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemContent, ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { SubNav } from '@/components/wg/SubNav';
import { ThumbAction } from '@/components/wg/ThumbAction';
import { useWg } from '@/components/wg/WgContextProvider';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { InventoryList } from '@/features/inventory/components/InventoryList';
import {
	type InventoryCategory,
	type InventoryItemDto,
	type InventoryMutationItemDto,
	groupItemsByCategory,
} from '@/features/inventory/inventory';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface InventoryResponse {
	items: InventoryItemDto[];
	grouped: Record<InventoryCategory, InventoryItemDto[]>;
}

function applyInventoryMutation(
	items: InventoryItemDto[],
	updated?: InventoryMutationItemDto,
	deletedId?: string,
): InventoryItemDto[] {
	if (deletedId) return items.filter((item) => item.id !== deletedId);
	if (!updated) return items;
	const existing = items.find((item) => item.id === updated.id);
	const merged: InventoryItemDto = {
		...(existing ?? {}),
		...updated,
		decrementCount30d: updated.decrementCount30d ?? existing?.decrementCount30d ?? 0,
	};
	return existing
		? items.map((item) => (item.id === updated.id ? merged : item))
		: [...items, merged];
}

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function VorraetePage() {
	const { wg, identity } = useWg();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const inventoryUrl = `/api/wg/${encodedShareCode}/inventory`;
	const {
		data: inventoryData,
		error: inventoryError,
		isLoading: inventoryLoading,
		refresh: refreshInventory,
		setData: setInventoryData,
	} = useCachedFetch<InventoryResponse>(inventoryUrl, {
		memberId: identity.memberId,
	});
	const [items, setItems] = useState<InventoryItemDto[]>(() => inventoryData?.items ?? []);
	const [initialLoading, setInitialLoading] = useState(inventoryLoading);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	const requestIdRef = useRef(0);
	const hasInventoryDataRef = useRef(inventoryData !== undefined);

	const load = useCallback(
		async (silent = false): Promise<void> => {
			const requestId = requestIdRef.current + 1;
			requestIdRef.current = requestId;
			if (!silent && !hasInventoryDataRef.current) setInitialLoading(true);
			const res = await refreshInventory();
			if (requestId !== requestIdRef.current) {
				return;
			}
			if (res.ok) {
				setLoadError(null);
				setItems(res.data.items);
			} else {
				setLoadError(getWgLoadErrorMessage('Vorräte', res.status, res.error));
			}
			setInitialLoading(false);
		},
		[refreshInventory],
	);

	useEffect(() => {
		if (inventoryData) {
			hasInventoryDataRef.current = true;
			setItems(inventoryData.items);
			setLoadError(null);
		} else if (inventoryError) {
			setLoadError(getWgLoadErrorMessage('Vorräte', inventoryError.status, inventoryError.error));
		}
	}, [inventoryData, inventoryError]);

	useEffect(() => {
		void load(false);
	}, [load]);
	// Auto-Refresh wie auf dem Dashboard — ersetzt den manuellen Reload-Button.
	useVisibilityPausedInterval(() => void load(true), 30_000);

	return (
		<div data-household-content className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
			<SubNav />
			{/* Der aktive Tab benennt die Seite schon; Titel und Zähler bleiben für Screenreader. */}
			<header className="sr-only">
				<div className="min-w-0 flex-1">
					<h1 className="font-heading text-[26px] leading-8 font-semibold tracking-tight text-foreground">
						Vorräte
					</h1>
					<p
						className="mt-0.5 text-[12px] text-muted-foreground tabular-nums"
						aria-live="polite"
						aria-atomic="true"
					>
						{initialLoading && items.length === 0
							? 'Lädt…'
							: loadError && items.length === 0
								? 'Derzeit nicht verfügbar'
								: items.length === 0
									? null
									: `${items.length} Artikel im Bestand`}
					</p>
				</div>
			</header>

			{loadError && (
				<Alert variant="destructive">
					<AlertTitle>Laden fehlgeschlagen</AlertTitle>
					<AlertDescription className="flex flex-wrap items-center justify-between gap-2">
						<span>{loadError}</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void load(false)}
							disabled={initialLoading}
						>
							{initialLoading && <Spinner aria-hidden />}
							{initialLoading ? 'Lädt…' : 'Erneut laden'}
						</Button>
					</AlertDescription>
				</Alert>
			)}

			{initialLoading && items.length === 0 ? (
				<Card className="py-0">
					<CardContent className="p-0">
						<ItemGroup className="gap-0" aria-busy="true" aria-label="Vorräte werden geladen">
							{['s0', 's1', 's2'].map((k) => (
								<Item key={k} className="px-3 py-3">
									<ItemContent className="flex-1 gap-2">
										<Skeleton className="h-3.5 w-2/5" />
										<Skeleton className="h-3 w-3/5" />
									</ItemContent>
								</Item>
							))}
						</ItemGroup>
					</CardContent>
				</Card>
			) : loadError && items.length === 0 ? (
				<Empty className="border border-dashed">
					<EmptyHeader>
						<EmptyTitle>Vorräte noch nicht geladen</EmptyTitle>
						<EmptyDescription>
							Versuche es erneut, sobald die Verbindung wieder da ist.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<InventoryList
					items={items}
					shareCode={wg.shareCode}
					memberId={identity.memberId}
					memberToken={identity.memberToken}
					onChanged={(updated, deletedId) => {
						if (updated || deletedId) {
							setItems((prev) => applyInventoryMutation(prev, updated, deletedId));
							setInventoryData((current) => {
								if (!current && !updated) return current;
								const nextItems = applyInventoryMutation(current?.items ?? [], updated, deletedId);
								return {
									items: nextItems,
									grouped: groupItemsByCategory(nextItems),
								};
							});
						}
						void load(true);
					}}
					addOpen={addOpen}
					onAddOpenChange={setAddOpen}
				/>
			)}
			{!(initialLoading && items.length === 0) && !(loadError && items.length === 0) && (
				<ThumbAction>
					<Button type="button" className="min-h-11 w-full" onClick={() => setAddOpen(true)}>
						<Plus data-icon="inline-start" aria-hidden />
						Vorrat hinzufügen
					</Button>
				</ThumbAction>
			)}
			<div aria-hidden className="h-[env(safe-area-inset-bottom,0px)]" />
		</div>
	);
}
