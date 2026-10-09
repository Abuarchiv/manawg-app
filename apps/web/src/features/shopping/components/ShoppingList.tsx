import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { readOfflineQueue } from '@/core/offline/offline-client';
import { ShoppingItemRow } from '@/features/shopping/components/ShoppingItemRow';
import type { ShoppingItem } from '@/features/shopping/components/shopping-types';
import type { EditShoppingItem } from '@/features/shopping/hooks/use-shopping-edit';
import type { MemberInfo } from '@/shared/lib/member-types';

import { ChevronRight, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

/** Rows per list rendered initially; "Mehr anzeigen" loads more. */
const ROW_RENDER_PAGE = 100;

const UNKNOWN_MEMBER: MemberInfo = { name: '?', color: null };

interface ShoppingListProps {
	openItems: ShoppingItem[];
	doneItems: ShoppingItem[];
	members: { id: string; name: string; color?: string | null }[];
	memberId: string;
	shareCode: string;
	highlightedId: string | null;
	doneOpen: boolean;
	onDoneOpenChange: (open: boolean) => void;
	isPending: (id: string) => boolean;
	onToggle: (item: ShoppingItem) => Promise<void>;
	onRemove: (id: string, itemName: string) => Promise<unknown>;
	onEdit: EditShoppingItem;
	removeError: string | null;
	removeErrorId: string | null;
	isAdmin: boolean;
	clearingBought: boolean;
	onClearRequest: () => void;
}

export function ShoppingList({
	openItems,
	doneItems,
	members,
	memberId,
	shareCode,
	highlightedId,
	doneOpen,
	onDoneOpenChange,
	isPending,
	onToggle,
	onRemove,
	onEdit,
	removeError,
	removeErrorId,
	isAdmin,
	clearingBought,
	onClearRequest,
}: ShoppingListProps) {
	const [rowLimit, setRowLimit] = useState(ROW_RENDER_PAGE);

	const memberInfoById = useMemo(() => {
		const map = new Map<string, MemberInfo>();
		for (const member of members) {
			map.set(member.id, { name: member.name, color: member.color ?? null });
		}
		return map;
	}, [members]);

	const memberLookup = useCallback(
		(id: string | null): MemberInfo => {
			if (!id) return UNKNOWN_MEMBER;
			return memberInfoById.get(id) ?? UNKNOWN_MEMBER;
		},
		[memberInfoById],
	);

	const queuedShoppingUpdateIds = new Set(
		readOfflineQueue()
			.filter(
				(action) =>
					action.type === 'shopping.update' &&
					action.shareCode === shareCode &&
					action.memberId === memberId,
			)
			.map((action) => String(action.payload.itemId)),
	);

	// Render long lists truncated at first; the highlighted element always stays in the DOM.
	const visibleCount = (list: ShoppingItem[]): number =>
		Math.max(rowLimit, list.findIndex((item) => item.id === highlightedId) + 1);
	const visibleOpenCount = visibleCount(openItems);
	const visibleDoneCount = visibleCount(doneItems);
	const moreButton = (hidden: number) => (
		<Button variant="outline" onClick={() => setRowLimit((limit) => limit + ROW_RENDER_PAGE)}>
			Mehr anzeigen ({hidden})
		</Button>
	);

	function renderRow(item: ShoppingItem) {
		return (
			<ShoppingItemRow
				key={item.id}
				item={item}
				adder={memberLookup(item.addedByMemberId)}
				buyer={item.boughtByMemberId ? memberLookup(item.boughtByMemberId) : null}
				pending={isPending(item.id)}
				queued={queuedShoppingUpdateIds.has(item.id)}
				onToggle={onToggle}
				onRemove={onRemove}
				onEdit={onEdit}
				removeError={removeErrorId === item.id ? removeError : null}
				// The server route also lets the admin remove other people's items.
				canRemove={item.addedByMemberId === memberId || isAdmin}
				highlighted={highlightedId === item.id}
				shareCode={shareCode}
			/>
		);
	}

	return (
		<section aria-label="Einkaufsartikel" className="flex flex-col gap-4">
			{openItems.length > 0 ? (
				<ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
					{openItems.slice(0, visibleOpenCount).map(renderRow)}
				</ul>
			) : (
				<p className="text-[12px] text-muted-foreground">Alles eingekauft.</p>
			)}
			{visibleOpenCount < openItems.length && moreButton(openItems.length - visibleOpenCount)}
			{doneItems.length > 0 && (
				<details
					open={doneOpen}
					onToggle={(event) => onDoneOpenChange(event.currentTarget.open)}
					className="group -mt-2"
				>
					<summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[12px] font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
						<ChevronRight
							aria-hidden
							className="size-4 transition-transform group-open:rotate-90"
						/>
						Erledigt ({doneItems.length})
					</summary>
					<ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
						{/* Render done items only while the block is open (highlight opens it). */}
						{doneOpen && doneItems.slice(0, visibleDoneCount).map(renderRow)}
					</ul>
					{doneOpen &&
						visibleDoneCount < doneItems.length &&
						moreButton(doneItems.length - visibleDoneCount)}
					{isAdmin && (
						<Button
							variant="ghost"
							onClick={onClearRequest}
							disabled={clearingBought}
							aria-label={`Erledigte Artikel entfernen (${doneItems.length})`}
							className="mt-1 justify-start text-left text-muted-foreground"
						>
							{clearingBought ? (
								<Spinner data-icon="inline-start" aria-hidden />
							) : (
								<Trash2 data-icon="inline-start" aria-hidden />
							)}
							Erledigte entfernen
						</Button>
					)}
				</details>
			)}
		</section>
	);
}
