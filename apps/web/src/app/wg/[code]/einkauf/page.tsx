'use client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { SubNav } from '@/components/wg/SubNav';
import { useWg } from '@/components/wg/WgContextProvider';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { formatQueuedOfflineEntries } from '@/core/offline/offline-copy';
import { InventoryRestockPrompt } from '@/features/inventory/components/InventoryRestockPrompt';
import {
	type InventoryItemDto,
	isBelowThreshold,
	normalizeForMatch,
} from '@/features/inventory/inventory';
import { ClearBoughtDialog } from '@/features/shopping/components/ClearBoughtDialog';
import { ListSkeleton, SuggestionsSkeleton } from '@/features/shopping/components/ListSkeleton';
import { ShoppingAddBar } from '@/features/shopping/components/ShoppingAddBar';
import { ShoppingList } from '@/features/shopping/components/ShoppingList';
import { ShoppingReceiptPrompt } from '@/features/shopping/components/ShoppingReceiptPrompt';
import { ShoppingSuggestions } from '@/features/shopping/components/ShoppingSuggestions';
import { QUICK_SHOPPING_ITEMS } from '@/features/shopping/components/constants';
import { useShoppingPage } from '@/features/shopping/hooks/use-shopping-page';
import { splitShoppingItems } from '@/features/shopping/shopping-view';
import { ListChecks } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';

const NO_INVENTORY: InventoryItemDto[] = [];
const RECENTLY_BOUGHT_MS = 24 * 60 * 60 * 1000;
const RESTOCK_WINDOW_MS = 12 * 60 * 60 * 1000;

export default function EinkaufPage() {
	const { wg, members, identity, isAdmin } = useWg();
	const searchParams = useSearchParams();
	const highlightedId = searchParams.get('highlight');
	const prefillName = searchParams.get('name');
	const {
		data: cachedInventory,
		isLoading: inventoryLoading,
		error: inventoryError,
		refresh: refreshInventory,
	} = useCachedFetch<{
		items: InventoryItemDto[];
	}>(`/api/wg/${encodeURIComponent(wg.shareCode)}/inventory`, {
		memberId: identity.memberId,
	});
	const shopping = useShoppingPage({ wg, identity, prefillName, highlightedId, refreshInventory });
	const { items, initialLoading, loadError, add } = shopping;
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	// Row or done block disappears together with its focus: keep it on the page instead of letting it fall to BODY.
	const keepFocus = (ok: boolean): void => {
		if (ok) requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
	};

	// Derived directly instead of mirrored via an effect: otherwise one frame
	// renders with an empty pantry and the suggestions jump.
	const inventory = cachedInventory?.items ?? NO_INVENTORY;
	const { open, done, openItems, doneItems } = splitShoppingItems(items);
	const actionError =
		shopping.toggleError ?? (shopping.removeErrorId ? null : shopping.removeError);

	// Suggestions for articles that are not already open on the list.
	const openNames = new Set(open.map((item) => normalizeForMatch(item.name)));
	// Do not offer just-bought items again right away: otherwise ticking one off pops up a chip,
	// shifts the list and invites buying it again.
	const recentCutoff = Date.now() - RECENTLY_BOUGHT_MS;
	const recentlyBought = new Set(
		done
			.filter((item) => item.boughtAt !== null && Date.parse(item.boughtAt) > recentCutoff)
			.map((item) => normalizeForMatch(item.name)),
	);
	const lowStock = inventory
		.filter((item) => {
			const key = normalizeForMatch(item.name);
			return isBelowThreshold(item) && !openNames.has(key) && !recentlyBought.has(key);
		})
		.map((item) => item.name);
	const taken = new Set([...openNames, ...recentlyBought, ...lowStock.map(normalizeForMatch)]);
	const frequent = [
		...inventory
			.filter((item) => item.decrementCount30d > 0)
			.sort((a, b) => b.decrementCount30d - a.decrementCount30d)
			.map((item) => item.name),
	].filter((name) => {
		const key = normalizeForMatch(name);
		if (taken.has(key)) return false;
		taken.add(key);
		return true;
	});
	// Suggestions and list appear together once list and pantry are loaded: otherwise
	// the groups swap after loading and push the list down (layout shift).
	// Without a list (load error) the open items are unknown, so nothing is offered for adding.
	const listUnknown = Boolean(loadError) && items.length === 0;
	// Only the first load without an error holds the suggestions back; a slow or failing pantry
	// request must never hide the list itself.
	const inventoryPending = inventoryLoading && !inventoryError && cachedInventory === undefined;
	const suggestionsPending = initialLoading || inventoryPending || listUnknown;
	const suggestionGroups = [
		{ label: 'Bald leer', names: lowStock.slice(0, 4) },
		frequent.length > 0
			? { label: 'Oft gekauft', names: frequent.slice(0, 4) }
			: {
					label: 'Vorschläge',
					names:
						items.length === 0
							? QUICK_SHOPPING_ITEMS.filter((name) => !taken.has(normalizeForMatch(name)))
							: [],
				},
	].filter((group) => !suggestionsPending && group.names.length > 0);

	return (
		<div data-household-content className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-3">
			<SubNav liveCount={!initialLoading && !loadError ? open.length : undefined} />
			{/* The active tab already names the page; title and count stay for screen readers. */}
			<header className="sr-only">
				<h1 ref={headingRef} tabIndex={-1}>
					Einkäufe
				</h1>
				<p
					className="mt-0.5 text-[12px] text-muted-foreground tabular-nums"
					aria-live="polite"
					aria-atomic="true"
				>
					{initialLoading && items.length === 0 ? 'Lädt…' : `${open.length} offen`}
				</p>
			</header>

			{inventoryPending && !initialLoading && !listUnknown && <SuggestionsSkeleton />}
			{suggestionGroups.length > 0 && (
				<ShoppingSuggestions
					groups={suggestionGroups}
					disabled={add.adding}
					onAdd={(name) => void add.add(name)}
				/>
			)}

			{shopping.queuedCount > 0 && (
				<Alert>
					<AlertDescription>{formatQueuedOfflineEntries(shopping.queuedCount)}</AlertDescription>
				</Alert>
			)}
			{loadError && (
				<LoadErrorBanner
					message={loadError}
					onRetry={() => void shopping.load(false)}
					busy={initialLoading}
					retryLabel="Liste erneut laden"
				/>
			)}
			{initialLoading && items.length === 0 ? (
				<ListSkeleton withSuggestions />
			) : listUnknown ? null : items.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ListChecks aria-hidden />
						</EmptyMedia>
						<EmptyTitle>Noch nichts auf der Liste</EmptyTitle>
						<EmptyDescription>
							{suggestionGroups.length > 0
								? 'Schreib unten einen Artikel auf oder tippe einen Vorschlag.'
								: 'Schreib unten einen Artikel auf.'}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ShoppingList
					openItems={openItems}
					doneItems={doneItems}
					members={members}
					memberId={identity.memberId}
					shareCode={wg.shareCode}
					highlightedId={shopping.flashId ?? highlightedId}
					doneOpen={shopping.doneOpen}
					onDoneOpenChange={shopping.setDoneOpen}
					isPending={shopping.isPending}
					onToggle={shopping.toggleBought}
					onRemove={(id, name) => shopping.remove(id, name).then(keepFocus)}
					onEdit={shopping.edit}
					removeError={shopping.removeError}
					removeErrorId={shopping.removeErrorId}
					isAdmin={isAdmin}
					clearingBought={shopping.clearingBought}
					onClearRequest={() => setClearConfirmOpen(true)}
				/>
			)}
			<ShoppingReceiptPrompt
				doneItems={doneItems}
				memberId={identity.memberId}
				shareCode={wg.shareCode}
			/>
			<InventoryRestockPrompt
				items={inventory}
				boughtNames={done
					.filter(
						(item) =>
							item.boughtByMemberId === identity.memberId &&
							item.boughtAt !== null &&
							Date.now() - Date.parse(item.boughtAt) < RESTOCK_WINDOW_MS,
					)
					.map((item) => item.name)}
				shareCode={wg.shareCode}
				memberId={identity.memberId}
				onRestocked={refreshInventory}
			/>
			<ShoppingAddBar
				value={add.newName}
				onChange={add.changeName}
				onSubmit={() => void add.add()}
				adding={add.adding}
				addError={add.addError}
				addNotice={shopping.addNotice}
				actionError={actionError}
				toggleNotice={shopping.toggleNotice}
			/>
			{isAdmin && (
				<ClearBoughtDialog
					open={clearConfirmOpen}
					onOpenChange={setClearConfirmOpen}
					doneCount={done.length}
					clearing={shopping.clearingBought}
					onConfirm={() => void shopping.clearBought().then(keepFocus)}
				/>
			)}
		</div>
	);
}
