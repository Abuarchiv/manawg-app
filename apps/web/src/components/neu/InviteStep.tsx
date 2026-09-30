'use client';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@/components/ui/card';
import { type NavigatorWithShare, copyText } from '@/core/utils/clipboard';
import { cn } from '@/shared/lib/cn';
import { AlertTriangle, Check, MessageCircle, Share2 } from 'lucide-react';
import { useRef, useState } from 'react';

const SHARE_RESET_MS = 1500;

type ShareState = 'idle' | 'copied' | 'codeCopied' | 'shared' | 'failed' | 'codeFailed';

interface InviteStepProps {
	code: string;
	wgName: string;
	onSkip: () => void;
}

export function InviteStep({ code, wgName, onSkip }: InviteStepProps) {
	const [state, setState] = useState<ShareState>('idle');
	const [sharing, setSharing] = useState<'invite' | 'code' | null>(null);
	const timerRef = useRef<number | null>(null);
	const sharingRef = useRef(false);
	// Visually hidden live region so screen readers announce share state changes
	// without re-reading the entire button label each time.
	const liveId = 'share-status-live';

	function flash(next: ShareState): void {
		setState(next);
		if (timerRef.current) window.clearTimeout(timerRef.current);
		timerRef.current = window.setTimeout(() => setState('idle'), SHARE_RESET_MS);
	}

	async function onShare(): Promise<void> {
		if (sharingRef.current) return;
		sharingRef.current = true;
		setSharing('invite');
		const url =
			typeof window !== 'undefined'
				? `${window.location.origin}/neu?code=${code}`
				: `/neu?code=${code}`;
		const host = typeof window !== 'undefined' ? window.location.host : '';
		const text = `Komm in unsere WG „${wgName}“ auf ManaWG: ${url}\n(oder mit Code ${code} unter ${host} beitreten)`;
		const shareData = { title: 'ManaWG', text, url };
		try {
			const nav = (typeof navigator !== 'undefined' ? navigator : null) as
				| (Navigator & NavigatorWithShare)
				| null;
			if (nav?.share && (!nav.canShare || nav.canShare(shareData))) {
				await nav.share(shareData);
				flash('shared');
				return;
			}
			flash((await copyText(text)) ? 'copied' : 'failed');
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				setState('idle');
				return;
			}
			flash((await copyText(text)) ? 'copied' : 'failed');
		} finally {
			sharingRef.current = false;
			setSharing(null);
		}
	}

	async function onCopyCode(): Promise<void> {
		if (sharingRef.current) return;
		sharingRef.current = true;
		setSharing('code');
		try {
			flash((await copyText(code)) ? 'codeCopied' : 'codeFailed');
		} finally {
			sharingRef.current = false;
			setSharing(null);
		}
	}

	const whatsappHref = `https://wa.me/?text=${encodeURIComponent(
		`Komm in unsere WG „${wgName}“ auf ManaWG: ${typeof window !== 'undefined' ? `${window.location.origin}/neu?code=${code}` : `/neu?code=${code}`}\n(oder mit Code ${code} unter ${typeof window !== 'undefined' ? window.location.host : ''} beitreten)`,
	)}`;

	const shareLabel =
		sharing === 'invite'
			? 'Einladung wird geteilt…'
			: state === 'shared'
				? 'Einladung geteilt'
				: state === 'copied'
					? 'Einladung kopiert'
					: state === 'failed'
						? 'Teilen erneut versuchen'
						: 'Mitbewohner einladen';
	const sharingBlocked = sharing !== null;

	return (
		<div className="flex flex-col gap-5">
			{/* Visually hidden live region for share status announcements */}
			<span id={liveId} aria-live="polite" aria-atomic="true" className="sr-only">
				{state === 'shared'
					? 'Einladungslink wurde nativ geteilt.'
					: state === 'copied'
						? 'Einladungslink wurde kopiert.'
						: state === 'codeCopied'
							? 'Einladungscode wurde kopiert.'
							: state === 'failed'
								? 'Teilen fehlgeschlagen.'
								: state === 'codeFailed'
									? 'Einladungscode konnte nicht kopiert werden.'
									: ''}
			</span>

			<Card>
				<CardHeader className="items-center text-center">
					<div className="flex size-10 items-center justify-center rounded-lg bg-muted text-foreground">
						<Check aria-hidden />
					</div>
					<CardTitle className="max-w-full break-words">{wgName} ist live.</CardTitle>
					<CardDescription>Teile den Einladungscode mit deiner WG.</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col items-center gap-3 text-center">
					<Button
						type="button"
						variant="outline"
						onClick={() => void onCopyCode()}
						disabled={sharing !== null}
						aria-label={sharing === 'code' ? `Code ${code} wird kopiert…` : `Code ${code} kopieren`}
						className="h-auto min-h-12 max-w-full font-mono text-xl font-semibold tracking-[0.22em]"
					>
						{code}
					</Button>
					<p className="text-sm text-muted-foreground">Tippe auf den Code zum Kopieren.</p>
				</CardContent>
				{(state === 'codeCopied' || state === 'codeFailed') && (
					<CardFooter className="justify-center">
						<Badge variant={state === 'codeFailed' ? 'destructive' : 'secondary'}>
							{state === 'codeCopied' ? 'Code kopiert' : 'Code konnte nicht kopiert werden'}
						</Badge>
					</CardFooter>
				)}
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Einladung verschicken</CardTitle>
					<CardDescription>
						Nutze die Teilen-Funktion deines Telefons oder kopiere den Link.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-2">
					<Button
						type="button"
						variant="default"
						size="lg"
						onClick={() => void onShare()}
						disabled={sharing !== null}
						aria-label={shareLabel}
						aria-describedby={liveId}
						className="min-h-12 w-full"
					>
						{state === 'shared' || state === 'copied' ? (
							<Check data-icon="inline-start" aria-hidden />
						) : state === 'failed' ? (
							<AlertTriangle data-icon="inline-start" aria-hidden />
						) : (
							<Share2 data-icon="inline-start" aria-hidden />
						)}
						<span aria-hidden="true">{shareLabel}</span>
					</Button>
					<a
						href={whatsappHref}
						target="_blank"
						rel="noopener noreferrer"
						aria-label="Per WhatsApp teilen"
						aria-disabled={sharingBlocked}
						tabIndex={sharingBlocked ? -1 : undefined}
						onClick={(event) => {
							if (sharingBlocked) event.preventDefault();
						}}
						className={cn(
							buttonVariants({ variant: 'outline', size: 'lg' }),
							'min-h-12 w-full',
							sharingBlocked && 'pointer-events-none opacity-60',
						)}
					>
						<MessageCircle data-icon="inline-start" aria-hidden />
						Per WhatsApp teilen
					</a>
				</CardContent>
				{state !== 'idle' && state !== 'codeCopied' && state !== 'codeFailed' && (
					<CardFooter>
						<Badge variant={state === 'failed' ? 'destructive' : 'secondary'}>
							{state === 'shared'
								? 'Nativ geteilt'
								: state === 'copied'
									? 'Link kopiert'
									: 'Teilen fehlgeschlagen'}
						</Badge>
					</CardFooter>
				)}
			</Card>

			<Button
				type="button"
				variant="outline"
				onClick={onSkip}
				disabled={sharingBlocked}
				className="w-full"
			>
				Später → direkt zur WG
			</Button>
		</div>
	);
}
