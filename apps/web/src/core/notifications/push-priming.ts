import { safeLocalStorage } from '@/core/utils/browser';

export const PUSH_PRIMING_DISMISS_KEY = 'manawg:push-priming-dismissed';

// Deliberately not `manawg:`/`manawg_`: clearLocalAccountData wipes those on
// sign-out, which would turn a member's explicit opt-out back into "no
// subscription yet" and let the silent resubscribe undo it on the next login.
const PUSH_OPTOUT_KEY_PREFIX = 'manawg-push-optout:';

/** True when this member switched Web Push off on this device on purpose. */
export function isPushOptedOut(memberId: string): boolean {
	try {
		return safeLocalStorage()?.getItem(PUSH_OPTOUT_KEY_PREFIX + memberId) === '1';
	} catch {
		return false;
	}
}

export function setPushOptOut(memberId: string, optedOut: boolean): void {
	try {
		const ls = safeLocalStorage();
		if (!ls) return;
		if (optedOut) ls.setItem(PUSH_OPTOUT_KEY_PREFIX + memberId, '1');
		else ls.removeItem(PUSH_OPTOUT_KEY_PREFIX + memberId);
	} catch {
		// Storage blocked — the opt-out then only lives on the server this session.
	}
}

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

export interface AutoResubscribeState {
	/** `Notification`, `serviceWorker` and `PushManager` all exist in this browser. */
	supported: boolean;
	/** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is set — without it, subscribing always fails. */
	configured: boolean;
	/** `Notification.permission`, or `null` when Notification isn't supported at all. */
	permission: NotificationPermission | null;
	/** This device already has a live `PushSubscription` for our service worker. */
	hasSubscription: boolean;
	/** The member switched Web Push off on purpose; a lost subscription is then not a bug. */
	optedOut: boolean;
}

/**
 * Decides whether to silently (re)create a push subscription in the
 * background, with no card and no tap involved. Never requests permission —
 * only fires once permission was already granted at some earlier point (a
 * previous session, or a browser/OS that carried a standing grant for this
 * origin), closing the gap where a granted permission never actually
 * produced an active subscription (fresh browser profile, cleared
 * subscription, etc). The first-ever grant still goes through the
 * tap-triggered priming card or Einstellungen — this never bypasses that.
 */
export function shouldAutoResubscribePush(state: AutoResubscribeState): boolean {
	if (!state.supported || !state.configured) return false;
	if (state.permission !== 'granted') return false;
	if (state.hasSubscription) return false;
	if (state.optedOut) return false;
	return true;
}
