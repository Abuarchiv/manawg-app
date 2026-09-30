'use client';

import { Checkbox } from '@/components/animate-ui/components/base/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
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
	conflicts?: ReadonlySet<string>;
	skipIndexes: ReadonlySet<number>;
	onToggleSkip: (index: number) => void;
	disabled?: boolean;
}

const NO_CONFLICTS: ReadonlySet<string> = new Set();

function formatDate(iso: string): string {
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
	// An id that is not among the offered members (moved-out member, foreign
	// id) must not render as if the row were fine — the row alert below names
	// it as a conflict.
	return member?.name ?? `${parsedName} (Zuordnung ungültig)`;
}

export function ImportPreviewTable({
	expenses,
	mapping,
	members,
	conflicts = NO_CONFLICTS,
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
		<ItemGroup aria-label="Import-Vorschau">
			{expenses.map((parsed, index) => {
				const skipped = skipIndexes.has(index);
				const conflictNames = new Set<string>();
				if (conflicts.has(parsed.paidByName)) conflictNames.add(parsed.paidByName);
				for (const split of parsed.splits) {
					if (conflicts.has(split.memberName)) conflictNames.add(split.memberName);
				}
				return (
					<Item
						key={`${parsed.date}-${index}`}
						variant="outline"
						className={cn('items-start', skipped && 'opacity-60')}
					>
						<ItemContent className="min-w-0">
							<ItemTitle className="line-clamp-none break-words">{parsed.description}</ItemTitle>
							<ItemDescription className="line-clamp-none">
								{formatDate(parsed.date)} · bezahlt von{' '}
								{resolveName(mapping, members, parsed.paidByName)}
							</ItemDescription>
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
							{conflictNames.size > 0 && (
								<Alert variant="destructive">
									<AlertDescription>
										{Array.from(conflictNames).join(', ')}{' '}
										{conflictNames.size === 1 ? 'ist' : 'sind'} keinem aktiven Mitglied zugeordnet.
										Diese Zeile kann erst importiert werden, wenn die Zuordnung korrekt ist.
									</AlertDescription>
								</Alert>
							)}
							{parsed.warnings.length > 0 && (
								<Alert>
									<AlertDescription>
										{parsed.warnings.map(describeParsedExpenseWarning).join(' ')}
									</AlertDescription>
								</Alert>
							)}
							<Field orientation="horizontal" className="min-h-11" data-disabled={disabled}>
								<Checkbox
									id={`import-entry-${index}`}
									checked={!skipped}
									onCheckedChange={() => onToggleSkip(index)}
									disabled={disabled}
									aria-label={`Eintrag ${index + 1} importieren`}
								/>
								<FieldLabel htmlFor={`import-entry-${index}`} className="min-h-11 flex-1">
									{skipped ? 'Wird übersprungen' : 'Diesen Eintrag importieren'}
								</FieldLabel>
							</Field>
						</ItemFooter>
					</Item>
				);
			})}
		</ItemGroup>
	);
}
