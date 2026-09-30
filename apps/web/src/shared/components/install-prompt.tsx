'use client';

import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
	type BeforeInstallEvent,
	isAppInstalled,
	subscribeInstall,
	triggerInstall,
} from '../lib/pwa-install';
import { InstallButton } from './install-button';
import { LogoMark } from './ui/LogoMark';

/**
 * True while the user has an input/textarea/contentEditable focused — e.g.
 * typing a chat message. The prompt is fixed just above the BottomNav, which
 * is exactly where feature composers (chat, pinnwand) sit, so popping up
 * unconditionally can slide the prompt over an in-progress keystroke and eat
 * the tap meant for the composer's send button.
 */
function isEditingTarget(): boolean {
	const active = document.activeElement;
	return (
		active instanceof HTMLElement &&
		(active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
	);
}

/**
 * Floating install prompt — shown on the start page of every app start until
 * ManaWG is installed.
 * Dismissing hides it until the next page load. Browsers without a native prompt
 * (iOS, Firefox) get the manual steps from `InstallButton`. Liest das
 * `beforeinstallprompt`-Event aus dem globalen Pub/Sub-Modul
 * (`../lib/pwa-install`), damit kein Race-Condition mit dem `InstallButton`
 * in den Einstellungen entsteht.
 *
 * Implementation note: rendered as a normal div (not <dialog>) — toggling the
 * `open` attribute on a native dialog flips `display:none` and breaks the
 * slide-in animation. The prompt sits above the BottomNav and respects the
 * iOS safe-area-bottom so it doesn't sit under the home-indicator bar.
 */
export function InstallPrompt() {
	const [event, setEvent] = useState<BeforeInstallEvent | null>(null);
	const [manual, setManual] = useState(false);
	const [hidden, setHidden] = useState(true);
	const pathname = usePathname() ?? '';
	// Every app start lands on a start page. Feature pages keep their composer
	// or primary action right above the BottomNav, where the prompt would sit.
	const onStartPage = pathname === '/' || /^\/wg\/[^/]+\/?$/.test(pathname);

	useEffect(() => {
		if (isAppInstalled()) return;

		// Chromium fires beforeinstallprompt only while the app is not installed,
		// so there we wait for it. Other browsers can only install manually.
		setManual(!('onbeforeinstallprompt' in window));
		const timer = window.setTimeout(() => {
			if (!isEditingTarget()) setHidden(false);
		}, 1200);

		// Retract the prompt when the user taps into a composer so it never
		// sits over the input or its send button.
		const onFocusIn = () => {
			if (isEditingTarget()) setHidden(true);
		};
		window.addEventListener('focusin', onFocusIn);

		const unsub = subscribeInstall((ev) => {
			setEvent(ev);
			if (!ev && isAppInstalled()) setHidden(true);
		});

		return () => {
			window.removeEventListener('focusin', onFocusIn);
			window.clearTimeout(timer);
			unsub();
		};
	}, []);

	const dismiss = () => setHidden(true);

	const install = async () => {
		const result = await triggerInstall();
		if (result !== 'unavailable') dismiss();
	};

	if (hidden || !onStartPage || (!event && !manual)) return null;

	return (
		<div
			className="fixed inset-x-0 z-40 mx-auto w-[calc(100%-1rem)] max-w-[calc(var(--app-frame-width)-1rem)] animate-in fade-in slide-in-from-bottom-2 duration-[220ms]"
			// Use the measured BottomNav height so wrapped labels and zoomed text leave room.
			style={{ bottom: 'calc(var(--app-nav-height, 5rem) + 0.5rem)' }}
		>
			<section aria-live="polite" aria-label="App installieren">
				{/* Kompakt statt hoher Karte: verdeckt über der Navigation möglichst wenig Inhalt. */}
				<Card size="sm" className="gap-2 px-3 py-2.5">
					<div className="flex min-w-0 items-center gap-2.5">
						<LogoMark
							size={28}
							radius={10}
							tileFill="var(--primary)"
							markFill="var(--primary-foreground)"
							className="shrink-0"
						/>
						<div className="min-w-0 flex-1">
							<CardTitle className="text-sm">ManaWG als App installieren</CardTitle>
							<CardDescription className="text-[12px]">
								Schneller starten, offline-fähig.
							</CardDescription>
						</div>
						<Button
							type="button"
							onClick={dismiss}
							variant="ghost"
							size="icon-sm"
							aria-label="Installationshinweis ausblenden"
							className="shrink-0"
						>
							<X aria-hidden="true" />
						</Button>
					</div>
					{event ? (
						<Button type="button" size="sm" onClick={install} className="w-full">
							Jetzt installieren
						</Button>
					) : (
						<InstallButton variant="solid" label="So installierst du ManaWG" className="w-full" />
					)}
				</Card>
			</section>
		</div>
	);
}
