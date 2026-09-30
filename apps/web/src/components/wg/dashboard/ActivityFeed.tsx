import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { useWg } from '@/components/wg/WgContextProvider';
import { activityItemKey } from '@/core/reads/activity';
import { formatEuroCents } from '@/core/utils/money';
import { formatCompactRelativeTime } from '@/core/utils/time';
import {
	CalendarOff,
	History,
	ListChecks,
	Megaphone,
	Receipt,
	Repeat2,
	Sparkles,
} from 'lucide-react';
import Link from 'next/link';

interface ActivityItem {
	id?: string;
	kind: 'expense' | 'shopping' | 'announcement' | 'chore' | 'recurring' | 'absence' | 'audit';
	timestamp: string;
	memberId?: string | null;
	memberName: string;
	text: string;
	detail?: string;
	amountCents?: number;
	currency?: string;
	href?: string;
}

const kindIcon: Record<ActivityItem['kind'], typeof Receipt> = {
	expense: Receipt,
	shopping: ListChecks,
	announcement: Megaphone,
	chore: Sparkles,
	recurring: Repeat2,
	absence: CalendarOff,
	audit: History,
};

// Protokoll-Texte beginnen mit einem Verb („hat … geändert“) und brauchen die Person davor;
// alle anderen sind Stichworte („Brot gekauft“) und stehen als Titel, die Person darunter.
const VERB_START = /^(hat|ist)\b/;

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
	const { identity } = useWg();
	if (items.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>Noch keine Aktivität.</EmptyTitle>
					<EmptyDescription>Neue Einträge erscheinen hier.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const now = Date.now();
	return (
		<ul aria-label="Aktivitätsverlauf" className="divide-y divide-border/60">
			{items.map((item, index) => {
				const Icon = kindIcon[item.kind];
				const isMe = Boolean(item.memberId) && item.memberId === identity.memberId;
				const who = isMe ? 'Du' : item.memberName;
				const sentence = VERB_START.test(item.text);
				const text =
					sentence && isMe
						? item.text.replace(/^hat\b/, 'hast').replace(/^ist\b/, 'bist')
						: item.text;
				const content = (
					<>
						<Icon
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							strokeWidth={1.5}
							aria-hidden
						/>
						<div className="min-w-0 flex-1">
							<p className="line-clamp-2 break-words text-sm leading-5">
								{sentence && <span className="font-medium">{who} </span>}
								{text}
							</p>
							<p className="line-clamp-2 text-[12px] text-muted-foreground">
								{!sentence && `${who} · `}
								<time dateTime={item.timestamp}>
									{formatCompactRelativeTime(item.timestamp, now)}
								</time>
								{item.detail && ` · ${item.detail}`}
							</p>
						</div>
						{item.amountCents !== undefined && (
							<span className="shrink-0 font-mono text-[12px] tabular-nums">
								{formatEuroCents(item.amountCents, item.currency ?? 'EUR')}
							</span>
						)}
					</>
				);
				return (
					<li key={activityItemKey(item, index)}>
						{item.href ? (
							<Link
								href={item.href}
								className="flex min-h-12 items-start gap-3 rounded-lg py-2.5 focus-visible:outline-2 focus-visible:outline-ring active:bg-muted"
							>
								{content}
							</Link>
						) : (
							<div className="flex min-h-12 items-start gap-3 py-2.5">{content}</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
