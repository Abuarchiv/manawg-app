'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * WCAG 2.4.3 / SPA route announcement.
 *
 * The WG shell's <main> never remounts across `/wg/[code]/*` client-side
 * navigations (same layout, one static per-WG <title> from generateMetadata),
 * so Next's App Router announcer has no title/h1 change to announce and focus
 * stays wherever the previous page left it (e.g. a bottom-nav link). This
 * moves focus to the shared #main landmark on every route change so screen
 * reader and keyboard users land at the top of the new view — the same
 * target the global skip link already uses.
 *
 * This layout-level effect can run after the new page's own mount effects,
 * so it only moves focus when it isn't already somewhere inside #main —
 * otherwise it would steal focus back from a page that autofocused its own
 * element (e.g. a search field) on mount.
 */
export function RouteFocusOnNavigate() {
	const pathname = usePathname();
	const previousPathname = useRef(pathname);

	useEffect(() => {
		if (previousPathname.current === pathname) return;
		previousPathname.current = pathname;
		const main = document.getElementById('main');
		if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
	}, [pathname]);

	return null;
}
