'use client';

import { Button, buttonVariants } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ExpenseRow } from '@/features/expenses/components/ausgaben/ExpenseRow';
import { ExpensesSkeleton } from '@/features/expenses/components/ausgaben/ExpensesSkeleton';
import type { Expense, ExpenseSplit } from '@/features/expenses/components/ausgaben/expense-types';
import type { ExpenseScope } from '@/features/expenses/expense-filter';
import { cn } from '@/shared/lib/cn';
import { FileInput } from 'lucide-react';
import Link from 'next/link';

/** Below this many expenses the list is short enough to scan without a filter. */
const FILTER_MIN_EXPENSES = 6;

interface ExpenseHistoryProps {
	expenseCount: number;
	shownCount: number;
	query: string;
	onQueryChange: (query: string) => void;
	scope: ExpenseScope;
	onScopeChange: (scope: ExpenseScope) => void;
	weeks: Array<{ label: string; items: Expense[] }>;
	showSkeleton: boolean;
	initialLoading: boolean;
	loadFailed: boolean;
	hiddenCount: number;
	onShowMore: () => void;
	importHref: string;
	expanded: Set<string>;
	highlightedId: string | null;
	currentMemberId: string;
	pendingIds: ReadonlySet<string>;
	memberName: (id: string) => string;
	onToggleExpand: (id: string) => void;
	onDelete: (id: string) => void;
	onEdit: (expense: Expense) => void;
	onToggleSettle: (expenseId: string, split: ExpenseSplit) => void;
}

export function ExpenseHistory({
	expenseCount,
	shownCount,
	query,
	onQueryChange,
	scope,
	onScopeChange,
	weeks,
	showSkeleton,
	initialLoading,
	loadFailed,
	hiddenCount,
	onShowMore,
	importHref,
	expanded,
	highlightedId,
	currentMemberId,
	pendingIds,
	memberName,
	onToggleExpand,
	onDelete,
	onEdit,
	onToggleSettle,
}: ExpenseHistoryProps): React.ReactElement {
	return (
		<section className="flex flex-col gap-3" aria-label="Eingetragene Ausgaben">
			{expenseCount > 0 && <h2 className="sr-only">Verlauf</h2>}
			{showSkeleton ? (
				<ExpensesSkeleton />
			) : loadFailed && expenseCount === 0 ? null : expenseCount === 0 && !initialLoading ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Noch keine Ausgaben</EmptyTitle>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="flex flex-col gap-4">
					{expenseCount >= FILTER_MIN_EXPENSES && (
						<div className="flex flex-col gap-2">
							<Input
								type="search"
								value={query}
								onChange={(event) => onQueryChange(event.target.value)}
								placeholder="Ausgaben suchen"
								aria-label="Ausgaben suchen"
								enterKeyHint="search"
								className="text-base"
							/>
							<ToggleGroup
								variant="segmented"
								value={[scope]}
								onValueChange={(values) => {
									const value = values[0];
									if (value === 'all' || value === 'paid' || value === 'involved') {
										onScopeChange(value);
									}
								}}
								className="w-full"
								aria-label="Ausgaben filtern"
							>
								<ToggleGroupItem value="all" className="flex-1">
									Alle
								</ToggleGroupItem>
								<ToggleGroupItem value="paid" className="flex-1">
									Von mir bezahlt
								</ToggleGroupItem>
								<ToggleGroupItem value="involved" className="flex-1">
									Ich bin beteiligt
								</ToggleGroupItem>
							</ToggleGroup>
						</div>
					)}
					{shownCount === 0 && (
						<output className="block py-6 text-center text-sm text-muted-foreground">
							Keine passenden Ausgaben gefunden.
						</output>
					)}
					{weeks.map((week) => (
						<section key={week.label} aria-label={week.label} className="flex flex-col gap-1.5">
							<h3 className="px-0 text-[12px] font-medium text-muted-foreground">{week.label}</h3>
							<ul
								className={cn(
									'divide-y divide-border/60 overflow-hidden rounded-xl border',
									// With ?highlight=, use real row heights: otherwise the page grows after scrolling and the target slides under the nav.
									highlightedId && '[&>li]:[content-visibility:visible]',
								)}
							>
								{week.items.map((expense) => (
									<ExpenseRow
										key={expense.id}
										expense={expense}
										expanded={expanded.has(expense.id)}
										onToggleExpand={onToggleExpand}
										onDelete={onDelete}
										onEdit={onEdit}
										onToggleSettle={onToggleSettle}
										pendingIds={pendingIds}
										memberName={memberName}
										currentMemberId={currentMemberId}
										highlighted={highlightedId === expense.id}
									/>
								))}
							</ul>
						</section>
					))}
					{hiddenCount > 0 && (
						<Button variant="outline" onClick={onShowMore}>
							Mehr anzeigen ({hiddenCount})
						</Button>
					)}
				</div>
			)}
			{/* Rarely needed: import at the end of the list rather than as an icon above the balance. */}
			{!showSkeleton && (
				<Link
					href={importHref}
					className={cn(
						buttonVariants({ variant: 'ghost', size: 'sm' }),
						'self-center text-muted-foreground',
					)}
				>
					<FileInput data-icon="inline-start" aria-hidden />
					Ausgaben importieren
				</Link>
			)}
		</section>
	);
}
