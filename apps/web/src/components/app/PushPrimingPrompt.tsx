'use client';

import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
	PUSH_PRIMING_DISMISS_KEY,
	isPushOptedOut,
	isPushPrimingDismissed,
	shouldAutoResubscribePush,
	shouldShowPushPriming,
} from '@/core/notifications/push-priming';
import { isPushSupported, subscribeWebPush } from '@/core/notifications/push-subscribe';
import { isEditingTarget, safeLocalStorage } from '@/core/utils/browser';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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
}: {
	code: string;
	memberId: string;
}) {
	const [visible, setVisible] = useState(false);
	const [busy, setBusy] = useState(false);
	const [activationError, setActivationError] = useState<string | null>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const toast = useToast();

	// The card sits at the page end: the error line makes it taller, so bring it fully back
	// into view (above the bottom navigation, see scroll-mb on the card).
	useEffect(() => {
		if (activationError) cardRef.current?.scrollIntoView({ block: 'nearest' });
	}, [activationError]);

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
			if (
				!shouldAutoResubscribePush({
					supported,
					configured,
					permission,
					hasSubscription,
					optedOut: isPushOptedOut(memberId),
				})
			) {
				return;
			}
			try {
				await subscribeWebPush(code, memberId);
			} catch {
				// Silent: VAPID misconfig, network hiccup, etc. Einstellungen still
				// offers a manual retry with a real error message.
			}
		}
		void autoResubscribe();
		return () => {
			cancelled = true;
		};
	}, [code, memberId]);

	// The focused button leaves the DOM with the card; park focus on the page instead of <body>.
	function hideCard(): void {
		rememberDismissed();
		setVisible(false);
		document.getElementById('main')?.focus({ preventScroll: true });
	}

	async function enable(): Promise<void> {
		if (busy) return;
		setBusy(true);
		setActivationError(null);
		try {
			await subscribeWebPush(code, memberId);
			hideCard();
			toast.success('Benachrichtigungen sind aktiv.');
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
			ref={cardRef}
			className="flex w-full scroll-mb-[calc(var(--app-nav-height,5rem)+0.5rem)] flex-wrap items-center gap-3 rounded-xl border p-3"
		>
			<div className="min-w-0 flex-1 basis-48">
				<p className="text-sm font-medium">Benachrichtigungen</p>
				<p className="text-meta text-muted-foreground">Push für fällige Aufgaben und Chat.</p>
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
					aria-disabled={busy}
					className="aria-disabled:opacity-50"
				>
					{busy && <Spinner data-icon="inline-start" aria-hidden />}
					Aktivieren
				</Button>
				<Button
					variant="ghost"
					size="icon"
					type="button"
					onClick={hideCard}
					aria-label="Hinweis schließen"
					className="text-muted-foreground"
				>
					<X aria-hidden />
				</Button>
			</div>
		</div>
	);
}
