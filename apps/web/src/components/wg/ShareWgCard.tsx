'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { copyViaTextArea } from '@/core/utils/clipboard';
import { cn } from '@/shared/lib/cn';
import { isValidShareCode } from '@/shared/lib/share-code';
import { Check, Copy, Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'react-qr-code';

interface Props {
	wgName: string;
	shareCode: string;
	appUrl?: string;
	hideHeader?: boolean;
	joiningEnabled?: boolean;
}

const COPY_FEEDBACK_MS = 1500;

function buildShareUrl(shareCode: string, explicitAppUrl?: string): string {
	// Never embed a code we cannot trust into link or QR code — a malformed
	// value would otherwise produce a join URL that fails silently.
	if (!isValidShareCode(shareCode)) return '/';
	if (explicitAppUrl) {
		return `${explicitAppUrl.replace(/\/$/, '')}/?code=${encodeURIComponent(shareCode)}`;
	}
	if (typeof window !== 'undefined') {
		return `${window.location.origin}/?code=${encodeURIComponent(shareCode)}`;
	}
	return `/?code=${encodeURIComponent(shareCode)}`;
}

export function ShareWgCard({
	wgName,
	shareCode,
	appUrl,
	hideHeader = false,
	joiningEnabled = true,
}: Props) {
	const [copied, setCopied] = useState<'code' | 'link' | 'shared' | null>(null);
	const [copyError, setCopyError] = useState<string | null>(null);
	const [copying, setCopying] = useState<'code' | 'link' | 'share' | null>(null);
	const feedbackTimerRef = useRef<number | null>(null);
	const copyingRef = useRef(false);
	const shareUrl = buildShareUrl(shareCode, appUrl);

	useEffect(() => {
		return () => {
			if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
		};
	}, []);

	function showCopied(kind: 'code' | 'link' | 'shared'): void {
		setCopied(kind);
		if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
		feedbackTimerRef.current = window.setTimeout(() => {
			setCopied(null);
			feedbackTimerRef.current = null;
		}, COPY_FEEDBACK_MS);
	}

	async function copy(value: string, kind: 'code' | 'link'): Promise<void> {
		if (!joiningEnabled) return;
		if (copyingRef.current) return;
		copyingRef.current = true;
		setCopying(kind);
		try {
			setCopyError(null);
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(value);
			} else if (!copyViaTextArea(value)) {
				throw new Error('copy_failed');
			}
			showCopied(kind);
		} catch {
			if (copyViaTextArea(value)) {
				showCopied(kind);
				return;
			}
			setCopied(null);
			setCopyError(
				`Kopieren fehlgeschlagen. Markiere ${kind === 'code' ? 'den Code' : 'den Link'} und kopiere ihn manuell.`,
			);
		} finally {
			copyingRef.current = false;
			setCopying(null);
		}
	}

	async function nativeShare(): Promise<void> {
		if (!joiningEnabled) return;
		if (copyingRef.current) return;
		copyingRef.current = true;
		setCopying('share');
		if (typeof navigator === 'undefined' || !('share' in navigator)) {
			copyingRef.current = false;
			setCopying(null);
			await copy(shareUrl, 'link');
			return;
		}
		try {
			await (navigator as Navigator & { share: (data: ShareData) => Promise<void> }).share({
				title: `WG ${wgName} beitreten`,
				text: `Tritt der WG "${wgName}" auf ManaWG bei. Code: ${shareCode}`,
				url: shareUrl,
			});
			showCopied('shared');
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') return;
			copyingRef.current = false;
			setCopying(null);
			await copy(shareUrl, 'link');
			return;
		} finally {
			copyingRef.current = false;
			setCopying(null);
		}
	}

	return (
		<div>
			{!hideHeader ? (
				<Card>
					<CardHeader>
						<CardTitle>WG teilen</CardTitle>
						<CardDescription>
							{joiningEnabled
								? 'Wer Code oder QR scannt, kommt zum Beitrittsflow.'
								: 'Beitritte sind gesperrt. Öffne den Zugang, bevor du teilst.'}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ShareWgBody
							shareUrl={shareUrl}
							shareCode={shareCode}
							wgName={wgName}
							joiningEnabled={joiningEnabled}
							copied={copied}
							copying={copying}
							copyError={copyError}
							onCopyCode={() => copy(shareCode, 'code')}
							onCopyLink={() => copy(shareUrl, 'link')}
							onShare={nativeShare}
						/>
					</CardContent>
				</Card>
			) : (
				<ShareWgBody
					shareUrl={shareUrl}
					shareCode={shareCode}
					wgName={wgName}
					joiningEnabled={joiningEnabled}
					copied={copied}
					copying={copying}
					copyError={copyError}
					onCopyCode={() => copy(shareCode, 'code')}
					onCopyLink={() => copy(shareUrl, 'link')}
					onShare={nativeShare}
				/>
			)}
		</div>
	);
}

function ShareWgBody({
	shareUrl,
	shareCode,
	wgName,
	joiningEnabled,
	copied,
	copying,
	copyError,
	onCopyCode,
	onCopyLink,
	onShare,
}: {
	shareUrl: string;
	shareCode: string;
	wgName: string;
	joiningEnabled: boolean;
	copied: 'code' | 'link' | 'shared' | null;
	copying: 'code' | 'link' | 'share' | null;
	copyError: string | null;
	onCopyCode: () => void;
	onCopyLink: () => void;
	onShare: () => void;
}) {
	return (
		<div>
			{!joiningEnabled ? (
				<Alert className="mb-3">
					<AlertTitle>Beitritte gesperrt</AlertTitle>
					<AlertDescription>
						Neue Beitritte sind gerade gesperrt. Link, QR und Teilen bleiben blockiert.
					</AlertDescription>
				</Alert>
			) : null}

			<div
				role="img"
				aria-label={`QR-Code zum Beitritt der WG ${wgName}`}
				className={cn(
					'mx-auto mb-4 flex w-fit justify-center rounded-lg bg-white p-3',
					joiningEnabled ? '' : 'opacity-45 grayscale',
				)}
			>
				<QRCode value={shareUrl} size={148} level="M" />
			</div>

			<div className="border-border overflow-hidden rounded-lg border">
				<button
					type="button"
					onClick={onCopyCode}
					disabled={!joiningEnabled || copying !== null}
					aria-label={
						copying === 'code'
							? 'WG-Code wird kopiert…'
							: copied === 'code'
								? 'Code kopiert'
								: 'WG-Code kopieren'
					}
					className="hover:bg-muted focus-visible:ring-ring flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
				>
					<span className="min-w-0">
						<span className="text-muted-foreground block text-xs font-medium tracking-wider uppercase">
							Code
						</span>
						<span className="text-foreground mt-0.5 block font-mono text-base font-medium tracking-[0.12em]">
							{shareCode}
						</span>
					</span>
					{copying === 'code' ? (
						<Spinner aria-hidden />
					) : copied === 'code' ? (
						<Check className="text-primary h-4 w-4" aria-hidden />
					) : (
						<Copy className="text-muted-foreground h-4 w-4" aria-hidden />
					)}
				</button>
				<button
					type="button"
					onClick={onCopyLink}
					disabled={!joiningEnabled || copying !== null}
					aria-label={
						copying === 'link'
							? 'Einladungslink wird kopiert…'
							: copied === 'link'
								? 'Link kopiert'
								: 'Einladungslink kopieren'
					}
					className="border-border hover:bg-muted focus-visible:ring-ring flex min-h-[44px] w-full items-center justify-between gap-3 border-t px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
				>
					<span className="min-w-0">
						<span className="text-muted-foreground block text-xs font-medium tracking-wider uppercase">
							Link
						</span>
						<span className="text-foreground mt-0.5 block truncate text-sm">{shareUrl}</span>
					</span>
					{copying === 'link' ? (
						<Spinner aria-hidden />
					) : copied === 'link' ? (
						<Check className="text-primary h-4 w-4 shrink-0" aria-hidden />
					) : (
						<Copy className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
					)}
				</button>
			</div>
			{copyError ? (
				<Alert variant="destructive" className="mt-2">
					<AlertDescription>{copyError}</AlertDescription>
				</Alert>
			) : null}
			{(copied === 'link' || copied === 'shared') && !copyError ? (
				<p aria-live="polite" className="text-muted-foreground mt-2 block text-xs">
					Einladungslink bereit.
				</p>
			) : null}

			<Button
				type="button"
				onClick={onShare}
				disabled={!joiningEnabled || copying !== null}
				aria-label={copying === 'share' ? 'WG-Einladung wird geteilt…' : 'WG-Einladung teilen'}
				className="mt-3 w-full"
			>
				{copying === 'share' ? <Spinner aria-hidden /> : <Share2 aria-hidden />}
				{copying === 'share' ? 'Teilt…' : 'Teilen'}
			</Button>
		</div>
	);
}
