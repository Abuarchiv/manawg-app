import { haptic } from '@/shared/lib/haptics';
import { type PointerEvent, type RefObject, useEffect, useRef } from 'react';

const LONG_PRESS_MS = 400;
const SWIPE_TRIGGER_PX = 56;
const SWIPE_MAX_PX = 72;
const MOVE_SLOP_PX = 8;
/** The click that ends a gesture must not toggle the bubble menu. */
const CLICK_SWALLOW_MS = 400;

type Gesture = {
	pointerId: number;
	x: number;
	y: number;
	mode: 'pending' | 'swipe' | 'scroll' | 'longpress';
	armed: boolean;
};

/**
 * Messenger gestures on a message row: swipe right to reply, long press to open the menu.
 * Touch and pen only; mouse and keyboard keep the click menu. The row moves through its style,
 * so a drag does not re-render the list.
 */
export function useBubbleGestures({
	rowRef,
	iconRef,
	enabled,
	onReply,
	onLongPress,
}: {
	rowRef: RefObject<HTMLElement | null>;
	iconRef: RefObject<HTMLElement | null>;
	enabled: boolean;
	onReply: () => void;
	onLongPress: () => void;
}) {
	const gesture = useRef<Gesture | null>(null);
	const timer = useRef<number | undefined>(undefined);
	const swallowUntil = useRef(0);
	useEffect(() => () => window.clearTimeout(timer.current), []);

	function moveRow(offset: number) {
		const row = rowRef.current;
		const icon = iconRef.current;
		if (row) {
			row.style.transition = offset ? 'none' : '';
			row.style.transform = offset ? `translateX(${offset}px)` : '';
		}
		if (icon) icon.style.opacity = `${Math.min(1, offset / SWIPE_TRIGGER_PX)}`;
	}

	function end(event: PointerEvent, commit: boolean) {
		const current = gesture.current;
		if (!current || event.pointerId !== current.pointerId) return;
		window.clearTimeout(timer.current);
		gesture.current = null;
		if (current.mode === 'swipe' || current.mode === 'longpress') {
			swallowUntil.current = performance.now() + CLICK_SWALLOW_MS;
		}
		if (current.mode === 'swipe') {
			moveRow(0);
			if (commit && current.armed) onReply();
		}
	}

	const handlers = {
		onPointerDown(event: PointerEvent) {
			if (!enabled || event.pointerType === 'mouse' || !event.isPrimary) return;
			// React bubbles events out of portals: the open menu, picker and dialog must not start a gesture.
			const target = event.target;
			if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
			gesture.current = {
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				mode: 'pending',
				armed: false,
			};
			window.clearTimeout(timer.current);
			// Long press only on the bubble itself; reaction chips and the image keep their own tap.
			if (!target.closest('[data-slot="bubble-content"]')) return;
			timer.current = window.setTimeout(() => {
				if (gesture.current?.mode !== 'pending') return;
				gesture.current.mode = 'longpress';
				haptic('medium');
				onLongPress();
			}, LONG_PRESS_MS);
		},
		onPointerMove(event: PointerEvent) {
			const current = gesture.current;
			if (!current || event.pointerId !== current.pointerId) return;
			const dx = event.clientX - current.x;
			const dy = event.clientY - current.y;
			if (current.mode === 'pending') {
				if (Math.abs(dx) < MOVE_SLOP_PX && Math.abs(dy) < MOVE_SLOP_PX) return;
				window.clearTimeout(timer.current);
				current.mode = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5 ? 'swipe' : 'scroll';
			}
			if (current.mode !== 'swipe') return;
			const offset = Math.min(SWIPE_MAX_PX, Math.max(0, dx));
			moveRow(offset);
			const armed = offset >= SWIPE_TRIGGER_PX;
			if (armed && !current.armed) haptic('selection');
			current.armed = armed;
		},
		onPointerUp: (event: PointerEvent) => end(event, true),
		onPointerCancel: (event: PointerEvent) => end(event, false),
	};

	return {
		handlers,
		/** True right after a swipe or long press, while its trailing click on the trigger arrives. */
		swallowsClick: () =>
			gesture.current?.mode === 'swipe' ||
			gesture.current?.mode === 'longpress' ||
			performance.now() < swallowUntil.current,
	};
}
