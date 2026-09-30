'use client';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useWg } from '@/components/wg/WgContextProvider';
import {
	countOfflineActions,
	getSyncedCountForWg,
	syncOfflineActions,
} from '@/core/offline/offline-client';
import {
	formatManualOfflineSyncResult,
	formatQueuedOfflineActions,
	getOfflineSyncFailureMessage,
} from '@/core/offline/offline-copy';
import { AlertCircle, CheckCircle2, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

function formatQueuedActions(count: number): string {
	if (count === 1) return '1 Aktion wartet.';
	return `${count} Aktionen warten.`;
}

function isScopedSyncEventForOtherWg(event: Event, shareCode: string): boolean {
	if (!(event instanceof CustomEvent)) return false;
	const syncedByShareCode = event.detail?.syncedByShareCode;
	if (!syncedByShareCode || typeof syncedByShareCode !== 'object') return false;
	const scoped = syncedByShareCode[shareCode];
	return typeof scoped !== 'number' || scoped <= 0;
}

export function OfflineBanner() {
	const { wg, identity } = useWg();
	const settingsDataHref = `/wg/${encodeURIComponent(wg.shareCode)}/einstellungen#daten`;
	const [online, setOnline] = useState(true);
	const [queueCount, setQueueCount] = useState(0);
	const [syncing, setSyncing] = useState(false);
	const [notice, setNotice] = useState<{
		type: 'success' | 'warning';
		text: string;
	} | null>(null);
	const syncingRef = useRef(false);

	useEffect(() => {
		setOnline(navigator.onLine);
		const update = (options?: { clearNotice?: boolean }) => {
			setOnline(navigator.onLine);
			const nextCount = countOfflineActions(wg.shareCode, { memberId: identity.memberId });
			setQueueCount(nextCount);
			if (options?.clearNotice !== false) setNotice(null);
		};
		const updateFromEvent = () => update();
		const onSynced = (event: Event) => {
			if (isScopedSyncEventForOtherWg(event, wg.shareCode)) return;
			const synced = getSyncedCountForWg(event, wg.shareCode);
			if (synced > 0) {
				const remaining = countOfflineActions(wg.shareCode, { memberId: identity.memberId });
				setNotice({
					type: 'success',
					text: formatManualOfflineSyncResult(synced, remaining),
				});
			}
			update({ clearNotice: synced <= 0 });
		};
		update();
		window.addEventListener('online', updateFromEvent);
		window.addEventListener('offline', updateFromEvent);
		window.addEventListener('manawg:offline-queue', updateFromEvent);
		window.addEventListener('manawg:offline-synced', onSynced);
		return () => {
			window.removeEventListener('online', updateFromEvent);
			window.removeEventListener('offline', updateFromEvent);
			window.removeEventListener('manawg:offline-queue', updateFromEvent);
			window.removeEventListener('manawg:offline-synced', onSynced);
		};
	}, [identity, wg.shareCode]);

	async function retry(): Promise<void> {
		if (syncingRef.current) return;
		syncingRef.current = true;
		setSyncing(true);
		try {
			const before = countOfflineActions(wg.shareCode, { memberId: identity.memberId });
			const synced = await syncOfflineActions(wg.shareCode, {
				force: true,
				memberId: identity.memberId,
			});
			const after = countOfflineActions(wg.shareCode, { memberId: identity.memberId });
			setQueueCount(after);
			if (synced > 0) {
				setNotice({
					type: 'success',
					text: formatManualOfflineSyncResult(synced, after),
				});
			} else if (before > 0 && after > 0) {
				setNotice({
					type: 'warning',
					text: 'Noch nicht gesendet. Die Aktionen bleiben gespeichert.',
				});
			}
		} catch {
			setQueueCount(countOfflineActions(wg.shareCode, { memberId: identity.memberId }));
			setNotice({
				type: 'warning',
				text: getOfflineSyncFailureMessage(),
			});
		} finally {
			syncingRef.current = false;
			setSyncing(false);
		}
	}

	if (!online) {
		return (
			<output
				data-offline-banner
				className="bg-muted text-foreground border-border sticky top-0 z-20 grid min-h-[var(--offline-banner-height)] grid-cols-[minmax(0,1fr)] content-center border-b px-4 py-2 text-[12px] font-medium"
				aria-live="polite"
			>
				<div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						<WifiOff className="h-4 w-4 shrink-0" aria-hidden />
						<span className="truncate">
							Offline.{' '}
							{queueCount > 0 ? formatQueuedActions(queueCount) : 'Änderungen werden vorgemerkt.'}
						</span>
					</div>
					<Link
						href="/offline"
						aria-label="Offline-Übersicht prüfen"
						className="focus-visible:ring-ring inline-flex min-h-[44px] shrink-0 items-center rounded-md px-2 underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
					>
						Prüfen
					</Link>
				</div>
			</output>
		);
	}

	if (queueCount === 0 && !notice) return null;

	if (notice && queueCount === 0) {
		return (
			<output
				data-offline-banner
				className="bg-card text-foreground border-border sticky top-0 z-20 grid min-h-[var(--offline-banner-height)] grid-cols-[minmax(0,1fr)] content-center border-b px-4 py-2 text-[12px] font-medium"
				aria-live="polite"
			>
				<div className="mx-auto flex w-full max-w-2xl items-center gap-2">
					<CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
					{notice.text}
				</div>
			</output>
		);
	}

	return (
		<output
			data-offline-banner
			className="bg-card text-foreground border-border sticky top-0 z-20 grid min-h-[var(--offline-banner-height)] grid-cols-[minmax(0,1fr)] content-center border-b px-4 py-2 text-[12px] font-medium"
			aria-live="polite"
		>
			<div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3">
				<Link href={settingsDataHref} className="min-w-0 flex-1 truncate">
					{notice ? notice.text : formatQueuedOfflineActions(queueCount)}
				</Link>
				<Button
					type="button"
					variant="outline"
					onClick={() => void retry()}
					disabled={syncing}
					aria-label={
						syncing ? 'Offline-Aktionen werden gesendet' : 'Offline-Aktionen jetzt senden'
					}
					className="min-h-[44px] shrink-0 text-[12px]"
				>
					{syncing ? (
						<Spinner aria-hidden />
					) : notice?.type === 'warning' ? (
						<AlertCircle aria-hidden />
					) : null}
					Jetzt senden
				</Button>
			</div>
		</output>
	);
}
