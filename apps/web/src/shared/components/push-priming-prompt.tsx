'use client';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
	PUSH_PRIMING_DISMISS_KEY,
	isPushPrimingDismissed,
	shouldAutoResubscribePush,
	shouldShowPushPriming,
} from '@/core/notifications/push-priming';
import { subscribeWebPush } from '@/core/notifications/push-subscribe';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

function safeLocalStorage(): Storage | null {
	if (typeof window === 'undefined') return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function isEditingTarget(): boolean {
	const active = document.activeElement;
	return (
		active instanceof HTMLElement &&
		(active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
	);
}

function isPushSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		'Notification' in window &&
		'serviceWorker' in navigator &&
		'PushManager' in window
	);
}

function rememberDismissed(): void {
	try {
		safeLocalStorage()?.setItem(PUSH_PRIMING_DISMISS_KEY, String(Date.now()));
	} catch {
		// Storage blocked (private mode etc.) — the prompt just won't persist its
		// dismissal across reloads this session; it still hides for now.
	}
}

/**
 * A one-time, non-blocking inline offer to turn on push notifications. Mounted
 * for every member with a resolved identity (see WgContextProvider), so it
 * naturally appears right after the moment a WG is created or joined for a
 * fresh device — without needing every join/create flow to know about it.
 *
 * `Notification.requestPermission()` (inside `subscribeWebPush`) only ever
 * fires from the user's tap on "Aktivieren" — never automatically. Most
 * browsers ignore/block an unsolicited call anyway, and a silent grant would
 * be the exact dark pattern app stores reject.
 */
export function PushPrimingPrompt({
	code,
	memberId,
	memberToken,
}: {
	code: string;
	memberId: string;
	memberToken?: string | undefined;
}) {
	const [visible, setVisible] = useState(false);
	const [busy, setBusy] = useState(false);
	const [activationError, setActivationError] = useState<string | null>(null);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		const supported = isPushSupported();
		const dismissed = isPushPrimingDismissed(
			safeLocalStorage()?.getItem(PUSH_PRIMING_DISMISS_KEY) ?? null,
		);
		// editingTarget is checked again at show-time and live below — typing can
		// start or stop between mount and the initial show, so a single mount-time
		// snapshot isn't enough.
		const eligible = shouldShowPushPriming({
			supported,
			configured: !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
			permission: supported ? Notification.permission : null,
			dismissed,
			editingTarget: false,
		});
		if (!eligible) return;
		if (!isEditingTarget()) setVisible(true);
		// Retract immediately if the user starts editing while the offer is visible.
		const onFocusIn = () => {
			if (isEditingTarget()) setVisible(false);
		};
		window.addEventListener('focusin', onFocusIn);
		return () => {
			window.removeEventListener('focusin', onFocusIn);
		};
	}, []);

	// Silent background resubscribe: if permission was already granted at some
	// earlier point (a previous session, or a standing OS/browser grant) but
	// this device has no live subscription (fresh profile, cleared/expired
	// subscription), re-create it without any card or gesture — permission was
	// already cleared, so no dark pattern here. Never requests permission
	// itself (see shouldAutoResubscribePush); the first-ever grant still goes
	// through the tap above or Einstellungen. Runs independently of the
	// priming-card visibility/dismissal state above.
	useEffect(() => {
		if (typeof window === 'undefined') return;
		let cancelled = false;
		async function autoResubscribe(): Promise<void> {
			const supported = isPushSupported();
			const configured = !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
			const permission = supported ? Notification.permission : null;
			if (permission !== 'granted' || !configured) return;
			let hasSubscription = true;
			try {
				const registration = await navigator.serviceWorker.getRegistration();
				if (cancelled) return;
				const existing = await registration?.pushManager.getSubscription();
				if (cancelled) return;
				hasSubscription = !!existing;
			} catch {
				return;
			}
			if (!shouldAutoResubscribePush({ supported, configured, permission, hasSubscription })) {
				return;
			}
			try {
				await subscribeWebPush(code, memberId, memberToken);
			} catch {
				// Silent: VAPID misconfig, network hiccup, etc. Einstellungen still
				// offers a manual retry with a real error message.
			}
		}
		void autoResubscribe();
		return () => {
			cancelled = true;
		};
	}, [code, memberId, memberToken]);

	function dismiss(): void {
		rememberDismissed();
		setVisible(false);
	}

	async function enable(): Promise<void> {
		if (busy) return;
		setBusy(true);
		setActivationError(null);
		try {
			await subscribeWebPush(code, memberId, memberToken);
			rememberDismissed();
			setVisible(false);
		} catch {
			setActivationError(
				'Aktivierung fehlgeschlagen. Prüfe die Browser-Einstellungen und versuche es erneut.',
			);
		} finally {
			setBusy(false);
		}
	}

	if (!visible) return null;

	return (
		<div
			// biome-ignore lint/a11y/useSemanticElements: native <output> can't host a nested interactive button+dismiss layout cleanly (see install-prompt.tsx for the same tradeoff)
			role="status"
			aria-live="polite"
			aria-label="Benachrichtigungen aktivieren"
			className="flex w-full flex-wrap items-center gap-3 border-t border-border pt-4"
		>
			<div className="min-w-0 flex-1 basis-48">
				<p className="text-sm font-medium">Benachrichtigungen</p>
				<p className="text-[12px] text-muted-foreground">
					Erhalte Hinweise zu fälligen Aufgaben und neuen WG-Nachrichten.
				</p>
				{activationError && (
					<p role="alert" className="text-sm text-destructive">
						{activationError}
					</p>
				)}
			</div>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void enable()}
					disabled={busy}
				>
					{busy && <Spinner data-icon="inline-start" aria-hidden />}
					Aktivieren
				</Button>
				<Button
					variant="ghost"
					size="icon"
					type="button"
					onClick={dismiss}
					aria-label="Hinweis schließen"
					className="size-9 text-muted-foreground"
				>
					<X aria-hidden />
				</Button>
			</div>
		</div>
	);
}
