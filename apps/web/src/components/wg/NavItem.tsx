'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/shared/lib/cn';
import { haptic } from '@/shared/lib/haptics';
import { Home, ListChecks, type LucideIcon, Megaphone, Receipt } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export type NavIconKey = 'home' | 'haushalt' | 'finanzen' | 'austausch';

const ICONS: Record<NavIconKey, LucideIcon> = {
	home: Home,
	haushalt: ListChecks,
	finanzen: Receipt,
	austausch: Megaphone,
};

interface NavItemProps {
	href: string;
	label: string;
	iconKey: NavIconKey;
	badgeCount?: number;
	/**
	 * Explicit active state for grouped destinations (Start/Haushalt/Finanzen/
	 * Austausch). When omitted, falls back to exact href matching so existing
	 * callers keep their behavior.
	 */
	active?: boolean;
	/**
	 * Additional hrefs that mark this item active (parent grouping). Compared
	 * by exact path or `<prefix>/…` so `/wg/ABC/vorraete` keeps Haushalt
	 * active while all deep links keep resolving.
	 */
	activePrefixes?: string[];
}

const BADGE_MAX_DISPLAY = 99;

export function NavItem({
	href,
	label,
	iconKey,
	badgeCount,
	active,
	activePrefixes,
}: NavItemProps) {
	const pathname = usePathname();
	const normalizedPath = pathname?.replace(/\/+$/, '') ?? '';
	const normalizedHref = new URL(href, 'https://manawg.invalid').pathname.replace(/\/+$/, '');
	const normalizedPrefixes = (activePrefixes ?? []).map((prefix) =>
		new URL(prefix, 'https://manawg.invalid').pathname.replace(/\/+$/, ''),
	);
	const prefixActive = normalizedPrefixes.some(
		(prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
	);
	const isCurrentPage = normalizedPath === normalizedHref;
	const isActive = active ?? (isCurrentPage || prefixActive);
	const Icon = ICONS[iconKey];
	const normalizedBadge = typeof badgeCount === 'number' && badgeCount > 0 ? badgeCount : null;
	const showBadge = normalizedBadge !== null;
	const badgeText =
		normalizedBadge !== null && normalizedBadge > BADGE_MAX_DISPLAY
			? `${BADGE_MAX_DISPLAY}+`
			: normalizedBadge;

	return (
		<li>
			<Link
				href={href}
				prefetch={true}
				aria-current={isActive ? (isCurrentPage ? 'page' : 'location') : undefined}
				data-bottom-nav-item
				onClick={() => {
					if (!isActive) haptic('light');
				}}
				className={cn(
					'flex min-h-11 w-full flex-col items-center justify-center gap-0.5 rounded-[14px] py-0.5 text-foreground/70 outline-none transition-colors duration-[120ms] select-none focus-visible:ring-2 focus-visible:ring-ring',
					isActive
						? 'bg-foreground/8 text-foreground ring-1 ring-inset ring-foreground/12'
						: 'active:bg-foreground/5',
				)}
			>
				<span className="relative">
					<Icon aria-hidden className="size-[18px]" strokeWidth={1.5} />
					{showBadge && (
						<Badge
							variant="destructive"
							aria-label={`${badgeCount} ungelesen`}
							aria-live="polite"
							aria-atomic="true"
							className="absolute -right-3 -top-2 tabular-nums"
						>
							{badgeText}
						</Badge>
					)}
				</span>
				<span className="max-w-full whitespace-nowrap text-center text-[10px] font-semibold leading-3.5">
					{label}
				</span>
			</Link>
		</li>
	);
}
