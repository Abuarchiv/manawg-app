'use client';

import { useKeyboardOpen } from '@/shared/lib/use-keyboard-open';
import { type ReactNode, useLayoutEffect, useRef } from 'react';

/**
 * One floating bottom navigation for the public shell and the WG shell: same
 * frame, same spacing, children are the NavItems. Reserves the actual height
 * as --app-nav-height, including wrapped/zoomed labels.
 */
export function AppBottomNav({ label, children }: { label: string; children: ReactNode }) {
	const ref = useRef<HTMLElement>(null);
	// iOS keeps fixed bars at the layout viewport, so with the keyboard open the bar floats mid-screen.
	// Hidden by collapsing to zero height at the viewport bottom (not display:none): a display:none
	// element reports an all-zero rect, and the chat frame fit would then reserve the whole
	// visible height for it and collapse to 0px. A zero-height rect at the bottom reserves nothing.
	const keyboardOpen = useKeyboardOpen();
	useLayoutEffect(() => {
		const nav = ref.current;
		const frame = nav?.parentElement;
		if (!nav || !frame) return;
		const root = nav.ownerDocument.documentElement;
		const measure = () => {
			const height = `${nav.getBoundingClientRect().height}px`;
			frame.style.setProperty('--app-nav-height', height);
			root.style.setProperty('--app-nav-height', height);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(nav);
		return () => {
			observer.disconnect();
			frame.style.removeProperty('--app-nav-height');
			root.style.removeProperty('--app-nav-height');
		};
	}, []);
	return (
		<nav
			ref={ref}
			aria-label={label}
			data-app-chrome
			className={`fixed inset-x-0 bottom-0 z-30 mx-auto bg-background w-full min-w-0 max-w-[var(--app-nav-width)] px-2 ${keyboardOpen ? 'invisible h-0 overflow-hidden pb-0' : 'pb-[max(0.5rem,var(--safe-area-bottom,0px))]'}`}
		>
			<div className="rounded-[20px] border border-border bg-background text-foreground">
				<ul className="flex flex-wrap gap-0.5 p-0.5 [&>li]:min-w-fit [&>li]:flex-1">{children}</ul>
			</div>
		</nav>
	);
}
