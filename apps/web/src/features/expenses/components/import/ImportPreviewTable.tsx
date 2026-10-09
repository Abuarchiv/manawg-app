'use client';

import { Checkbox } from '@/components/animate-ui/components/base/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemFooter,
	ItemGroup,
	ItemTitle,
} from '@/components/ui/item';
import { formatEuroCents } from '@/core/utils/money';
import {
	type ParsedExpense,
	describeParsedExpenseWarning,
} from '@/features/expenses/import-parsers';
import { cn } from '@/shared/lib/cn';

interface MemberOption {
	id: string;
	name: string;
}

interface Props {
	expenses: ReadonlyArray<ParsedExpense>;
	mapping: Readonly<Record<string, string | null>>;
	members: readonly MemberOption[];
	skipIndexes: ReadonlySet<number>;
	onToggleSkip: (index: number) => void;
	disabled?: boolean;
}

export function formatDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat('de-DE', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
	}).format(date);
}

function resolveName(
	mapping: Readonly<Record<string, string | null>>,
	members: readonly MemberOption[],
	parsedName: string,
): string {
	const id = mapping[parsedName];
	if (!id) return `${parsedName} (nicht zugeordnet)`;
	const member = members.find((m) => m.id === id);
	return member?.name ?? parsedName;
}

export function ImportPreviewTable({
	expenses,
	mapping,
	members,
	skipIndexes,
	onToggleSkip,
	disabled = false,
}: Props) {
	if (expenses.length === 0)
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>Keine Ausgaben gefunden</EmptyTitle>
				</EmptyHeader>
			</Empty>
		);
	return (
		<ItemGroup className="gap-2" aria-label="Import-Vorschau">
			{expenses.map((parsed, index) => {
				const skipped = skipIndexes.has(index);
				return (
					<Item
						key={`${parsed.date}-${index}`}
						variant="outline"
						className={cn('items-start', skipped && '[&>:not([data-slot=checkbox])]:opacity-60')}
					>
						<Checkbox
							id={`import-entry-${index}`}
							checked={!skipped}
							onCheckedChange={() => onToggleSkip(index)}
							disabled={disabled}
							aria-label={`Eintrag ${index + 1} importieren`}
							className="relative mt-0.5 after:absolute after:-inset-3"
						/>
						<ItemContent className="min-w-0 basis-40">
							{/* Label instead of div: tapping title or meta toggles the entry. */}
							<label
								htmlFor={`import-entry-${index}`}
								className="flex min-w-0 cursor-pointer flex-col gap-1"
							>
								<ItemTitle className="line-clamp-none [overflow-wrap:break-word]">
									{parsed.description}
								</ItemTitle>
								<ItemDescription className="line-clamp-none [overflow-wrap:break-word]">
									<span className="whitespace-nowrap">{formatDate(parsed.date)}</span> · bezahlt von{' '}
									{resolveName(mapping, members, parsed.paidByName)}
									{skipped && ' · wird übersprungen'}
								</ItemDescription>
							</label>
						</ItemContent>
						<Badge variant="outline" className="font-mono tabular-nums">
							{formatEuroCents(parsed.amountCents, 'EUR')}
						</Badge>
						<ItemFooter className="flex-col items-stretch">
							<ul className="flex w-full flex-col gap-1 text-sm" aria-label="Aufteilung">
								{parsed.splits.map((split, splitIndex) => (
									<li
										key={`${split.memberName}-${splitIndex}`}
										className="flex justify-between gap-3"
									>
										<span className="min-w-0 break-words">
											{resolveName(mapping, members, split.memberName)}
										</span>
										<span className="shrink-0 font-mono tabular-nums">
											{formatEuroCents(split.amountCents, 'EUR')}
										</span>
									</li>
								))}
							</ul>
							{parsed.warnings.length > 0 && (
								<Alert className="border-0 bg-transparent p-0 text-xs">
									<AlertDescription>
										{parsed.warnings.map(describeParsedExpenseWarning).join(' ')}
									</AlertDescription>
								</Alert>
							)}
						</ItemFooter>
					</Item>
				);
			})}
		</ItemGroup>
	);
}
