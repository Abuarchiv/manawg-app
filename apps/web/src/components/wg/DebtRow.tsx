'use client';

import { Badge } from '@/components/ui/badge';
import { Item, ItemContent, ItemDescription, ItemFooter, ItemTitle } from '@/components/ui/item';
import { formatEuroCents } from '@/core/utils/money';
import { cn } from '@/shared/lib/cn';
import type { ReactNode } from 'react';

interface DebtRowMember {
	id: string;
	name: string;
	color: string | null;
}

interface DebtRowProps {
	debtor: DebtRowMember;
	creditor: DebtRowMember;
	amountCents: number;
	currency: string;
	oldestDebtAgeDays: number;
	/** Aus Sicht dieser Person formulieren: „schuldet dir“ statt des eigenen Namens. */
	currentMemberId?: string;
	action?: ReactNode;
}

export function DebtRow({
	debtor,
	creditor,
	amountCents,
	currency,
	oldestDebtAgeDays,
	currentMemberId,
	action,
}: DebtRowProps) {
	const owedToMe = creditor.id === currentMemberId;
	const iOwe = debtor.id === currentMemberId;
	const ageLabel =
		oldestDebtAgeDays >= 1
			? `seit ${oldestDebtAgeDays} ${oldestDebtAgeDays === 1 ? 'Tag' : 'Tagen'}`
			: 'heute fällig';

	return (
		<li>
			<Item variant="outline" className="items-start">
				<ItemContent className="min-w-0">
					<ItemTitle className="line-clamp-none break-words">
						{iOwe ? 'Du schuldest' : `${debtor.name} schuldet`} {owedToMe ? 'dir' : creditor.name}
					</ItemTitle>
					<ItemDescription>{ageLabel}</ItemDescription>
				</ItemContent>
				<Badge
					variant="secondary"
					className={cn(
						'font-mono tabular-nums',
						owedToMe ? 'text-settled' : iOwe ? 'text-destructive' : 'text-foreground',
					)}
				>
					{formatEuroCents(amountCents, currency)}
				</Badge>
				{action && <ItemFooter className="justify-end">{action}</ItemFooter>}
			</Item>
		</li>
	);
}
