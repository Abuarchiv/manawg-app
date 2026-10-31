'use client';

import { AlertCircle, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/Toast';
import { useWg } from '@/components/wg/WgContextProvider';
import { subscribeConnectivity, useOnlineStatus } from '@/core/hooks/use-online-status';
import {
	countOfflineActions,
	getSyncedCountForWg,
	needsManualOfflineResolution,
	OFFLINE_SYNCED_EVENT,
	offlineQueueReplaySupported,
	readOfflineQueue,
	subscribeOfflineQueueChanges,
	syncOfflineActions,
} from '@/core/offline/offline-client';
import {
	manualSyncResultMessage,
	OFFLINE_REPLAY_UNSUPPORTED_MESSAGE,
	offlineQueueCountMessage,
	offlineReviewNeededMessage,
	queuedOfflineActionsMessage,
	SYNC_NOT_STARTED_MESSAGE,
} from '@/core/offline/offline-copy';
import { type Message, useMessage } from '@/shared/i18n/message';

function isScopedSyncEventForOtherWg(event: Event, shareCode: string): boolean {
	if (!(event instanceof CustomEvent)) return false;
	const syncedByShareCode = event.detail?.syncedByShareCode;
	if (!syncedByShareCode || typeof syncedByShareCode !== 'object') return false;
	const scoped = syncedByShareCode[shareCode];
	return typeof scoped !== 'number' || scoped <= 0;
}

export function OfflineBanner() {
	const t = useTranslations('shell.offlineBanner');
	const render = useMessage();
	const renderRef = useRef(render);
	renderRef.current = render;
	const { wg, identity } = useWg();
	const settingsDataHref = `/wg/${encodeURIComponent(wg.shareCode)}/settings#data`;
	const online = useOnlineStatus();
	const [queueCount, setQueueCount] = useState(0);
	// Actions sync will not retry; "Jetzt senden" cannot help with them.
	const [reviewCount, setReviewCount] = useState(0);
	const [syncing, setSyncing] = useState(false);
	// Only a warning stays in the bar; a finished sync is a toast so the page below never shifts.
	const [notice, setNotice] = useState<Message | null>(null);
	const toast = useToast();
	const syncingRef = useRef(false);

	// The bar wraps instead of truncating, so its real height (small phones, large text) feeds
	// the sticky offsets of settings tabs and the chat frame via --offline-banner-height.
	const observerRef = useRef<ResizeObserver | null>(null);
	const bannerRef = useCallback((el: HTMLElement | null) => {
		observerRef.current?.disconnect();
		observerRef.current = null;
		const root = document.documentElement;
		if (!el) {
			root.style.removeProperty('--offline-banner-height');
			return;
		}
		const measure = () =>
			root.style.setProperty('--offline-banner-height', `${el.getBoundingClientRect().height}px`);
		measure();
		observerRef.current = new ResizeObserver(measure);
		observerRef.current.observe(el);
	}, []);

	useEffect(() => {
		const update = (options?: { clearNotice?: boolean }) => {
			const nextCount = countOfflineActions(wg.shareCode, { memberId: identity.memberId });
			setQueueCount(nextCount);
			setReviewCount(
				readOfflineQueue().filter(
					(item) =>
						item.shareCode === wg.shareCode &&
						item.memberId === identity.memberId &&
						needsManualOfflineResolution(item),
				).length,
			);
			if (options?.clearNotice !== false) setNotice(null);
		};
		const updateFromEvent = () => update();
		const onSynced = (event: Event) => {
			if (isScopedSyncEventForOtherWg(event, wg.shareCode)) return;
			const synced = getSyncedCountForWg(event, wg.shareCode);
			if (synced > 0) {
				const remaining = countOfflineActions(wg.shareCode, { memberId: identity.memberId });
				toast.success(
					renderRef.current(manualSyncResultMessage(synced, remaining, { offlineLabel: true })),
				);
			}
			update({ clearNotice: synced <= 0 });
		};
		update();
		const unsubscribeConnectivity = subscribeConnectivity(updateFromEvent);
		const unsubscribeQueueChanges = subscribeOfflineQueueChanges(updateFromEvent);
		window.addEventListener(OFFLINE_SYNCED_EVENT, onSynced);
		return () => {
			unsubscribeConnectivity();
			unsubscribeQueueChanges();
			window.removeEventListener(OFFLINE_SYNCED_EVENT, onSynced);
		};
	}, [identity, wg.shareCode, toast]);

	const offlineText = t('offline', {
		detail: queueCount > 0 ? render(offlineQueueCountMessage(queueCount)) : t('pending'),
	});
	// A live region only announces text written after it is mounted, so it stays mounted in every
	// state and receives text only when connectivity changes.
	const [announcement, setAnnouncement] = useState('');
	const offlineTextRef = useRef(offlineText);
	offlineTextRef.current = offlineText;
	const wasOnlineRef = useRef(online);
	const backOnlineText = t('backOnline');
	useEffect(() => {
		if (wasOnlineRef.current === online) return;
		wasOnlineRef.current = online;
		setAnnouncement(online ? backOnlineText : offlineTextRef.current);
	}, [online, backOnlineText]);
	const statusRegion = (
		<output className="sr-only" data-offline-banner-status>
			{announcement}
		</output>
	);

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
			// A successful sync already toasts through the synced-event listener above.
			if (synced <= 0 && before > 0 && after > 0) {
				setNotice({ key: 'shell.offlineBanner.notSent' });
			}
		} catch {
			setQueueCount(countOfflineActions(wg.shareCode, { memberId: identity.memberId }));
			setNotice(SYNC_NOT_STARTED_MESSAGE);
		} finally {
			syncingRef.current = false;
			setSyncing(false);
		}
	}

	if (!online) {
		return (
			<>
				{statusRegion}
				<div
					ref={bannerRef}
					data-offline-banner
					className="bg-muted text-foreground border-border sticky top-0 z-20 grid min-h-[calc(44px+1rem+1px)] grid-cols-[minmax(0,1fr)] content-center border-b px-4 py-2 text-meta font-medium"
				>
					<div className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-between gap-x-3">
						<div className="flex min-w-0 flex-[1_1_8rem] items-center gap-2">
							<WifiOff className="h-4 w-4 shrink-0" aria-hidden />
							<span>{offlineText}</span>
						</div>
						<Link
							href="/offline"
							aria-label={t('reviewLabel')}
							className="focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center rounded-md px-2 underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
						>
							{t('review')}
						</Link>
					</div>
				</div>
			</>
		);
	}

	if (queueCount === 0) return statusRegion;
	const replayUnsupported = !offlineQueueReplaySupported();
	const nothingToRetry = replayUnsupported || reviewCount >= queueCount;

	return (
		<>
			{statusRegion}
			<output
				ref={bannerRef}
				data-offline-banner
				className="bg-card text-foreground border-border sticky top-0 z-20 grid min-h-[calc(44px+1rem+1px)] grid-cols-[minmax(0,1fr)] content-center border-b px-4 py-2 text-meta font-medium"
				aria-live="polite"
			>
				<div className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-between gap-x-3">
					<Link
						href={settingsDataHref}
						className="flex min-h-11 min-w-0 flex-[1_1_8rem] items-center leading-snug text-pretty"
					>
						{render(
							notice ??
								(replayUnsupported
									? OFFLINE_REPLAY_UNSUPPORTED_MESSAGE
									: nothingToRetry
										? offlineReviewNeededMessage(reviewCount)
										: queuedOfflineActionsMessage(queueCount)),
						)}
					</Link>
					{nothingToRetry ? null : (
						<Button
							type="button"
							variant="outline"
							onClick={() => void retry()}
							disabled={syncing}
							aria-label={syncing ? t('sendingLabel') : t('sendNowLabel')}
							className="min-h-11 shrink-0 text-meta"
						>
							{syncing ? <Spinner aria-hidden /> : notice ? <AlertCircle aria-hidden /> : null}
							{t('sendNow')}
						</Button>
					)}
				</div>
			</output>
		</>
	);
}
