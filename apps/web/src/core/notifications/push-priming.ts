export const PUSH_PRIMING_DISMISS_KEY = 'manawg:push-priming-dismissed';

/**
 * Unlike the install-prompt's 14-day cooldown, the push priming offer is a
 * one-time question: once a member has answered (dismissed the card, or
 * `Notification.permission` moved off 'default'), it never comes back. Any
 * stored value at all — timestamp or otherwise — counts as "already asked".
 */
export function isPushPrimingDismissed(value: string | null): boolean {
	return value !== null;
}

export interface PushPrimingState {
	/** `Notification`, `serviceWorker` and `PushManager` all exist in this browser. */
	supported: boolean;
	/** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is set — without it, subscribing always fails. */
	configured: boolean;
	/** `Notification.permission`, or `null` when Notification isn't supported at all. */
	permission: NotificationPermission | null;
	/** Already dismissed (or otherwise answered) on this device before. */
	dismissed: boolean;
	/** An input/textarea/contentEditable is focused right now (e.g. a chat composer). */
	editingTarget: boolean;
}

/**
 * Decides whether the proactive "turn on notifications?" card should show.
 * Pure so the timing/dismissal/permission-state logic is unit-testable
 * without a DOM or a real Notification API.
 */
export function shouldShowPushPriming(state: PushPrimingState): boolean {
	if (!state.supported || !state.configured) return false;
	if (state.permission !== 'default') return false;
	if (state.dismissed) return false;
	if (state.editingTarget) return false;
	return true;
}
