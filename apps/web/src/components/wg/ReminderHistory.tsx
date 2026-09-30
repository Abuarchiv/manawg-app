'use client';

import { Badge } from '@/components/ui/badge';
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { formatEuroCents } from '@/core/utils/money';
import { formatRelativeTime, formatTimeFull } from '@/core/utils/time';
import { Bell } from 'lucide-react';

export interface ReminderHistoryItem {
	id: string;
	debtorMemberId: string;
	creditorMemberId: string;
	amountCents: number;
	currency: string;
	channel: string;
	sentAt: string;
	oldestDebtAgeDays: number;
}

interface ReminderHistoryProps {
	items: ReadonlyArray<ReminderHistoryItem>;
	memberName: (id: string) => string;
	currentMemberId?: string;
}

// The API stores internal channel codes ('push' | 'inapp'); an unmapped
// optimistic label like "Wird gesendet" passes through unchanged.
const CHANNEL_LABELS: Readonly<Record<string, string>> = {
	push: 'Push-Benachrichtigung',
	inapp: 'In der App',
};

function channelLabel(channel: string): string {
	return CHANNEL_LABELS[channel] ?? channel;
}

export function ReminderHistory({ items, memberName, currentMemberId }: ReminderHistoryProps) {
	if (items.length === 0)
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Bell />
					</EmptyMedia>
					<EmptyTitle>Noch keine Erinnerungen</EmptyTitle>
					<EmptyDescription>Versendete Erinnerungen erscheinen hier.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	return (
		<ItemGroup>
			{items.map((item) => (
				<Item key={item.id} variant="outline" size="sm">
					<ItemContent className="min-w-0">
						<ItemTitle className="line-clamp-none break-words">
							{item.debtorMemberId === currentMemberId
								? 'Du schuldest'
								: `${memberName(item.debtorMemberId)} schuldet`}{' '}
							{item.creditorMemberId === currentMemberId
								? 'dir'
								: memberName(item.creditorMemberId)}
						</ItemTitle>
						<ItemDescription>
							<time dateTime={item.sentAt} title={formatTimeFull(item.sentAt)}>
								{formatRelativeTime(item.sentAt)}
							</time>{' '}
							· {channelLabel(item.channel)}
						</ItemDescription>
					</ItemContent>
					<Badge variant="outline" className="font-mono tabular-nums">
						{formatEuroCents(item.amountCents, item.currency)}
					</Badge>
				</Item>
			))}
		</ItemGroup>
	);
}
