'use client';

import { Badge } from '@/components/ui/badge';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { formatEuroCents } from '@/core/utils/money';

interface SplitReviewProps {
	members: ReadonlyArray<{ id: string; name: string }>;
	splits: ReadonlyArray<{ debtorMemberId: string; amountCents: number }> | null;
	paidByMemberId: string;
	currency?: string;
}

// The caller supplies the exact split result used by its existing save handler.
export function SplitReview({
	members,
	splits,
	paidByMemberId,
	currency = 'EUR',
}: SplitReviewProps) {
	if (!splits) {
		return (
			<p className="text-xs text-muted-foreground">
				Die Anteile erscheinen, sobald der Betrag gültig ist.
			</p>
		);
	}
	const payer = members.find((member) => member.id === paidByMemberId)?.name ?? 'Zahler:in';
	return (
		<ItemGroup aria-label="Anteile vor dem Speichern" aria-live="polite" className="gap-1">
			{members.map((member) => {
				const share = splits?.find((split) => split.debtorMemberId === member.id);
				return (
					<Item key={member.id} variant="muted" size="xs">
						<ItemContent className="min-w-0">
							<ItemTitle className="line-clamp-none break-words">{member.name}</ItemTitle>
							<ItemDescription className="line-clamp-none">
								{!splits
									? 'Anteil nach gültiger Aufteilung'
									: !share || share.amountCents === 0
										? 'Kein Anteil'
										: member.id === paidByMemberId
											? 'Eigener Anteil · bereits bezahlt'
											: `Schuldet ${payer} diesen Anteil`}
							</ItemDescription>
						</ItemContent>
						<Badge variant="outline" className="font-mono tabular-nums">
							{splits ? formatEuroCents(share?.amountCents ?? 0, currency) : '—'}
						</Badge>
					</Item>
				);
			})}
		</ItemGroup>
	);
}
