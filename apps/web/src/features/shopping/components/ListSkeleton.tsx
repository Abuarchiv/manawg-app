import { Item, ItemContent, ItemGroup, ItemMedia } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_KEYS = ['s0', 's1', 's2', 's3'];
const SUGGESTION_KEYS = ['g0', 'g1'];

// Reserves the space of the suggestion chips so the list does not jump down while they load.
export function SuggestionsSkeleton() {
	return (
		<div aria-hidden className="flex flex-col gap-3">
			{SUGGESTION_KEYS.map((k) => (
				<div key={k} className="flex flex-col gap-2">
					<Skeleton className="h-3 w-16" />
					<div className="flex flex-wrap gap-2">
						<Skeleton className="h-8 w-24 rounded-lg" />
						<Skeleton className="h-8 w-28 rounded-lg" />
						<Skeleton className="h-8 w-20 rounded-lg" />
					</div>
				</div>
			))}
		</div>
	);
}

// Mirrors ShoppingItemRow: a flat stacked list, not a bordered card.
export function ListSkeleton({ withSuggestions = false }: { withSuggestions?: boolean }) {
	return (
		<>
			{withSuggestions && <SuggestionsSkeleton />}
			<ItemGroup aria-busy="true" aria-label="Einkaufsliste wird geladen" className="gap-0">
				{SKELETON_KEYS.map((k) => (
					<Item key={k} className="px-0 py-2.5">
						<ItemMedia variant="icon" className="self-center">
							<Skeleton className="size-6 rounded-md" />
						</ItemMedia>
						<ItemContent className="flex-1 space-y-1.5">
							{/* Name line */}
							<Skeleton className="h-3.5 w-3/5" />
							{/* Meta line */}
							<Skeleton className="h-3 w-2/5" />
						</ItemContent>
					</Item>
				))}
			</ItemGroup>
		</>
	);
}
