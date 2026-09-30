'use client';

import { buttonVariants } from '@/components/ui/button';
import { ChatTopBarLink } from '@/components/wg/ChatTopBarLink';
import { useWg } from '@/components/wg/WgContextProvider';
import { LogoMark } from '@/shared/components/ui/LogoMark';
import { cn } from '@/shared/lib/cn';
import { UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function WgAppHeader() {
	const { wg, identity } = useWg();
	const pathname = usePathname() ?? '';
	const baseHref = `/wg/${encodeURIComponent(wg.shareCode)}`;
	const isStart = /^\/wg\/[^/]+\/?$/.test(pathname);

	// Unterseiten besitzen ihren eigenen Titel und ihre eigene Bereichs- oder
	// Zurücknavigation. Ein globaler WG-Streifen würde dort nur den Inhalt
	// wiederholen und vertikalen Platz verbrauchen. Der Kopf gehört deshalb
	// ausschließlich zur Startseite.
	if (!isStart) return null;

	return (
		<header
			data-home-header
			data-app-chrome
			className="mx-auto flex w-full max-w-[var(--app-frame-width)] flex-col gap-3 px-4 pt-4"
		>
			<div className="flex min-w-0 flex-wrap items-center gap-1">
				<LogoMark
					size={24}
					tile={false}
					markFill="currentColor"
					className="size-6 shrink-0 text-foreground"
				/>
				<div className="min-w-0 flex-[1_1_128px] py-1">
					<h1
						aria-label={`${wg.name} – Start`}
						title={wg.name}
						className="truncate text-xl font-semibold tracking-tight"
					>
						{wg.name}
					</h1>
					<p className="truncate text-sm text-muted-foreground">Hallo, {identity.name}.</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<ChatTopBarLink
						href={`${baseHref}/chat`}
						className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'relative shrink-0')}
					/>
					<Link
						href={`${baseHref}/einstellungen`}
						aria-label="Konto und WG-Einstellungen öffnen"
						className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'shrink-0')}
					>
						<UserRound aria-hidden />
					</Link>
				</div>
			</div>
		</header>
	);
}
