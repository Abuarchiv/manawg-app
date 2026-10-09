import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { useWg } from '@/components/wg/WgContextProvider';
import { activityItemKey } from '@/composition/activity';
import { formatEuroCents } from '@/core/utils/money';
import { formatRelativeTime } from '@/core/utils/time';
import { cn } from '@/shared/lib/cn';
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
	/** Server-built sentence starting with a verb; user content never sets this. */
	sentence?: boolean;
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

export function ActivityFeed({ items, inset }: { items: ActivityItem[]; inset?: boolean }) {
	const { identity } = useWg();
	if (items.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>Noch keine Aktivität</EmptyTitle>
					<EmptyDescription>
						Hier erscheint, was in der WG passiert: Ausgaben, Einkäufe, Putzplan.
					</EmptyDescription>
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
				// Sentences („hat … geändert“) need the person in front; keywords („Brot gekauft“) are the title.
				const sentence = item.sentence === true;
				const text =
					sentence && isMe
						? item.text.replace(/^hat\b/, 'hast').replace(/^ist\b/, 'bist')
						: item.text;
				const content = (
					<>
						{inset ? (
							<span className="flex size-8 shrink-0 items-center justify-center">
								<Icon className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden />
							</span>
						) : (
							<Icon
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								strokeWidth={1.5}
								aria-hidden
							/>
						)}
						{/* The amount drops below the text at large font sizes so titles never break mid-word in a narrow column. */}
						<div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
							<div className="min-w-0 grow basis-[10rem]">
								<p
									className={cn(
										'line-clamp-3 break-words text-sm leading-5',
										inset && 'text-[14px] font-medium',
									)}
								>
									{sentence && <span className="font-medium">{who} </span>}
									{text}
								</p>
								<p className="line-clamp-2 text-[12px] text-muted-foreground">
									{!sentence && `${who} · `}
									<time dateTime={item.timestamp}>{formatRelativeTime(item.timestamp, now)}</time>
									{item.detail && ` · ${item.detail}`}
								</p>
							</div>
							{item.amountCents !== undefined && (
								<span className="ml-auto shrink-0 font-mono text-[12px] tabular-nums">
									{formatEuroCents(item.amountCents, item.currency ?? 'EUR')}
								</span>
							)}
						</div>
					</>
				);
				return (
					<li
						key={activityItemKey(item, index)}
						className="[contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]"
					>
						{item.href ? (
							<Link
								href={item.href}
								className={cn(
									'flex min-h-12 items-start gap-3 rounded-lg py-2 focus-visible:outline-2 focus-visible:outline-ring active:bg-muted',
									inset && 'items-center gap-2 px-2',
								)}
							>
								{content}
							</Link>
						) : (
							<div
								className={cn(
									'flex min-h-12 items-start gap-3 py-2',
									inset && 'items-center gap-2 px-2',
								)}
							>
								{content}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
