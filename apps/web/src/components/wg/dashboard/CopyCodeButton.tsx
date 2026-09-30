'use client';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { type NavigatorWithShare, copyViaTextArea } from '@/core/utils/clipboard';
import { AlertTriangle, Check, Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const RESET_MS = 1500;

interface CopyCodeButtonProps {
	code: string;
	wgName?: string;
	joiningEnabled?: boolean;
	variant?: 'default' | 'ghost';
}

type CopyState = 'idle' | 'shared' | 'copied' | 'failed';

export function CopyCodeButton({
	code,
	wgName,
	joiningEnabled = true,
	variant = 'ghost',
}: CopyCodeButtonProps) {
	const [state, setState] = useState<CopyState>('idle');
	const [sharing, setSharing] = useState(false);
	const timerRef = useRef<number | null>(null);
	const sharingRef = useRef(false);

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		};
	}, []);

	function flash(next: CopyState): void {
		setState(next);
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		timerRef.current = window.setTimeout(() => {
			setState('idle');
			timerRef.current = null;
		}, RESET_MS);
	}

	async function onClick(): Promise<void> {
		if (!joiningEnabled) return;
		if (sharingRef.current) return;
		sharingRef.current = true;
		setSharing(true);
		const url =
			typeof window !== 'undefined'
				? `${window.location.origin}/neu?code=${encodeURIComponent(code)}`
				: `/neu?code=${encodeURIComponent(code)}`;
		const host = typeof window !== 'undefined' ? window.location.host : '';
		const text = wgName
			? `Komm in unsere WG "${wgName}" auf ManaWG: ${url}\n(oder mit Code ${code} unter ${host} beitreten)`
			: `Komm in unsere WG auf ManaWG: ${url}\n(oder mit Code ${code})`;
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
			if (nav?.clipboard?.writeText) {
				await nav.clipboard.writeText(text);
				flash('copied');
				return;
			}
			flash(copyViaTextArea(text) ? 'copied' : 'failed');
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				setState('idle');
				return;
			}
			flash(copyViaTextArea(text) ? 'copied' : 'failed');
		} finally {
			sharingRef.current = false;
			setSharing(false);
		}
	}

	const statusMessage =
		state === 'shared'
			? 'WG geteilt'
			: state === 'copied'
				? 'Einladung kopiert'
				: state === 'failed'
					? 'Teilen fehlgeschlagen'
					: '';

	return (
		<>
			<output aria-live="polite" className="sr-only">
				{statusMessage}
			</output>
			<Button
				type="button"
				variant={variant}
				onClick={onClick}
				disabled={!joiningEnabled || sharing}
				className="h-auto whitespace-normal"
			>
				{sharing ? (
					<Spinner data-icon="inline-start" aria-hidden />
				) : !joiningEnabled ? (
					<AlertTriangle data-icon="inline-start" aria-hidden />
				) : state === 'copied' || state === 'shared' ? (
					<Check data-icon="inline-start" aria-hidden />
				) : state === 'failed' ? (
					<AlertTriangle data-icon="inline-start" aria-hidden />
				) : (
					<Share2 data-icon="inline-start" aria-hidden />
				)}
				{!joiningEnabled
					? 'Beitritte gesperrt'
					: sharing
						? 'Einladung wird geteilt…'
						: state === 'copied'
							? 'Einladung kopiert'
							: state === 'shared'
								? 'WG geteilt'
								: state === 'failed'
									? 'Erneut teilen'
									: 'Mitbewohner einladen'}
			</Button>
		</>
	);
}
