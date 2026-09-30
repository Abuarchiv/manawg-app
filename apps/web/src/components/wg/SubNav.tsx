'use client';

import { getWgSection } from '@/components/app/navigation';
import { useChatUnreadCount, useDashboardCounts } from '@/components/wg/useWgCounts';
import type { SegmentCountState } from '@/components/wg/useWgCounts';
import { cn } from '@/shared/lib/cn';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface SubNavItem {
	href: string;
	label: string;
	icon: LucideIcon;
	count?: number | undefined;
	countHint?: string | undefined;
	countState?: SegmentCountState | undefined;
	countOverflow?: boolean | undefined;
	countExact?: number | undefined;
}

interface SubNavProps {
	label?: string;
	items?: SubNavItem[];
	className?: string;
	liveCount?: number | undefined;
}

export function SubNav({ label, items = [], className, liveCount }: SubNavProps) {
	const pathname = usePathname()?.replace(/\/+$/, '') ?? '';
	const section = getWgSection(pathname);

	return section ? (
		<WgSubNav
			section={section}
			pathname={pathname}
			label={label}
			className={className}
			liveCount={liveCount}
		/>
	) : (
		<SegmentList links={items} pathname={pathname} label={label} className={className} />
	);
}

function WgSubNav(props: {
	section: NonNullable<ReturnType<typeof getWgSection>>;
	pathname: string;
	label: string | undefined;
	className: string | undefined;
	liveCount: number | undefined;
}) {
	const dashboardCounted = props.section.pages.some((page) =>
		['einkauf', 'putzen', 'abos'].includes(page.slug),
	);
	return dashboardCounted ? <DashboardSubNav {...props} /> : <ChatSubNav {...props} />;
}

function DashboardSubNav({
	section,
	pathname,
	label,
	className,
	liveCount,
}: {
	section: NonNullable<ReturnType<typeof getWgSection>>;
	pathname: string;
	label: string | undefined;
	className: string | undefined;
	liveCount: number | undefined;
}) {
	const counts = useDashboardCounts();
	const links = section.pages.map((page) => {
		const href = `${section.baseHref}/${page.slug}`;
		const count = counts[page.slug];
		const isCurrent = pathname === href;
		const useLiveCount = isCurrent && liveCount !== undefined;
		return {
			href,
			label: page.label,
			icon: page.icon,
			count: useLiveCount ? liveCount : count?.count,
			countHint: count?.hint,
			countState: useLiveCount ? 'ready' : count?.state,
			countOverflow: count?.overflow,
		};
	});

	return (
		<SegmentList
			links={links}
			pathname={pathname}
			label={label ?? section.label}
			className={className}
		/>
	);
}

function ChatSubNav({
	section,
	pathname,
	label,
	className,
}: {
	section: NonNullable<ReturnType<typeof getWgSection>>;
	pathname: string;
	label: string | undefined;
	className: string | undefined;
}) {
	const chat = useChatUnreadCount();
	const state: SegmentCountState =
		chat.data !== undefined
			? chat.error
				? 'stale'
				: 'ready'
			: chat.error
				? 'unavailable'
				: 'loading';
	const links = section.pages.map((page) => ({
		href: `${section.baseHref}/${page.slug}`,
		label: page.label,
		icon: page.icon,
		...(page.slug === 'chat'
			? {
					count: chat.data?.count,
					countHint: 'ungelesen',
					countState: state,
					countOverflow: chat.data?.overflow,
					countExact: chat.data?.exactCount,
				}
			: {}),
	}));
	return (
		<SegmentList
			links={links}
			pathname={pathname}
			label={label ?? section.label}
			className={className}
		/>
	);
}

function countSuffix(
	count: number | undefined,
	hint: string | undefined,
	state: SegmentCountState | undefined,
	overflow: boolean | undefined,
	exactCount: number | undefined,
): string | null {
	if (count === undefined) {
		if (state === 'loading') return 'Zähler wird geladen';
		if (state === 'unavailable') return 'Zähler nicht verfügbar';
		return null;
	}
	const value =
		exactCount !== undefined ? String(exactCount) : overflow ? 'mehr als 99' : String(count);
	const freshness = state === 'stale' ? ', Stand möglicherweise veraltet' : '';
	return `${value} ${hint ?? 'offen'}${freshness}`;
}

function SegmentList({
	links,
	pathname,
	label,
	className,
}: {
	links: SubNavItem[];
	pathname: string;
	label?: string | undefined;
	className?: string | undefined;
}) {
	if (links.length < 2) return null;
	return (
		<nav aria-label={label ?? 'Unterbereiche'} className={cn('min-w-0', className)}>
			<ul className="grid auto-cols-[minmax(max-content,1fr)] grid-flow-col gap-1 overflow-x-auto rounded-xl bg-muted p-1 [scrollbar-width:none]">
				{links.map(
					({
						href,
						label: itemLabel,
						icon: Icon,
						count,
						countHint,
						countState,
						countOverflow,
						countExact,
					}) => {
						const target = new URL(href, 'https://manawg.invalid').pathname.replace(/\/+$/, '');
						const current = pathname === target;
						const active = current || pathname.startsWith(`${target}/`);
						const suffix = countSuffix(count, countHint, countState, countOverflow, countExact);
						const marker =
							countState === 'loading'
								? '…'
								: countState === 'unavailable'
									? '!'
									: countState === 'stale'
										? '~'
										: null;
						const showCount = typeof count === 'number' && count > 0;
						return (
							<li key={href} className="min-w-0">
								<Link
									href={href}
									prefetch
									aria-current={active ? (current ? 'page' : 'location') : undefined}
									aria-label={suffix ? `${itemLabel}, ${suffix}` : undefined}
									className={cn(
										"relative flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] max-[419px]:px-1 max-[419px]:text-[12px] outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
										active
											? 'bg-background text-foreground ring-1 ring-border'
											: 'text-foreground/75 hover:text-foreground',
									)}
								>
									<Icon aria-hidden className="size-4 shrink-0 max-[419px]:hidden" />
									<span className="truncate">{itemLabel}</span>
									{showCount && (
										<span
											aria-hidden
											className="font-mono text-xs tabular-nums text-muted-foreground"
										>
											{marker}
											{countOverflow || count > 99 || (countExact ?? 0) > 99 ? '99+' : count}
										</span>
									)}
									{!showCount && marker && (
										<span aria-hidden className="font-mono text-xs text-muted-foreground">
											{marker}
										</span>
									)}
								</Link>
							</li>
						);
					},
				)}
			</ul>
		</nav>
	);
}
