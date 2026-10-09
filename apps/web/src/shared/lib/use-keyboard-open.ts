'use client';

import { useEffect, useState } from 'react';

/** Threshold: how much smaller than the page the visible area must be to assume an on-screen keyboard. */
const KEYBOARD_MIN_HEIGHT = 100;

/** True while an input has focus and the on-screen keyboard shrinks the visible area. */
export function useKeyboardOpen(): boolean {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		// The keyboard is open when the visual viewport is much shorter than the page height seen
		// before typing began. innerHeight alone is unreliable: Android (resizes-content) and iOS 27
		// shrink it together with the keyboard, so the difference stays near 0 or depends on event order.
		const pageHeight = () => Math.max(document.documentElement.clientHeight, vv.height);
		let base = pageHeight();
		const sync = (event?: Event) => {
			const el = document.activeElement;
			const typing =
				el instanceof HTMLElement && el.matches('input, textarea, [contenteditable="true"]');
			// Moving focus between fields blurs first while the keyboard is still up: keep the old base.
			if (!typing && event?.type !== 'focusout') base = pageHeight();
			setOpen(typing && base - vv.height > KEYBOARD_MIN_HEIGHT);
		};
		// On a field switch, activeElement is briefly body during focusout; measure only afterwards.
		let timer: number | undefined;
		const syncLater = (event: Event) => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => sync(event), 0);
		};
		sync();
		vv.addEventListener('resize', sync);
		vv.addEventListener('scroll', sync);
		window.addEventListener('resize', sync);
		window.addEventListener('orientationchange', sync);
		document.addEventListener('focusin', sync);
		document.addEventListener('focusout', syncLater);
		return () => {
			vv.removeEventListener('resize', sync);
			vv.removeEventListener('scroll', sync);
			window.removeEventListener('resize', sync);
			window.removeEventListener('orientationchange', sync);
			document.removeEventListener('focusin', sync);
			document.removeEventListener('focusout', syncLater);
			window.clearTimeout(timer);
		};
	}, []);
	return open;
}
