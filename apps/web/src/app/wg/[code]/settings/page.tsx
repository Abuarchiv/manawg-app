'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWg } from '@/components/wg/WgContextProvider';
import {
	buildEmptyExportSummary,
	buildExportSummaryFromCounts,
	type ExportSectionCounts,
} from '@/composition/export';
import { wgLoadError } from '@/core/guards/load-errors';
import type { SettingsTab } from '@/core/guards/settings-tabs';
import { getSettingsTabFromHash, SETTINGS_TABS } from '@/core/guards/settings-tabs';
import { apiFetch } from '@/core/infra/api-client';
import type { Message } from '@/shared/i18n/message';
import { useMessage } from '@/shared/i18n/message';

// Mimics title row plus card so the tab content barely jumps.
const tabFallback = () => (
	<div className="grid gap-2.5" aria-hidden>
		{[0, 1, 2].map((i) => (
			<div key={i} className="grid gap-1">
				<Skeleton className="h-3 w-24" />
				<Skeleton className="h-32 w-full rounded-xl" />
			</div>
		))}
	</div>
);

// Each tab is its own chunk: importing all four statically would put every one in this route's
// first-load bundle. ssr:false because the page is a client component behind a resolved local
// identity; there is no server render of these panels to preserve. All chunks are prefetched
// after mount (see below) so tab switches keep working offline.
const loadProfileTab = () => import('@/components/wg/settings/ProfileTab');
const loadNotificationSection = () => import('@/components/wg/settings/NotificationSection');
const loadAccessTab = () => import('@/components/wg/settings/AccessTab');
const loadDataTab = () => import('@/components/wg/settings/DataTab');

const ProfileTab = dynamic(() => loadProfileTab().then((m) => m.ProfileTab), {
	ssr: false,
	loading: tabFallback,
});
const NotificationSection = dynamic(
	() => loadNotificationSection().then((m) => m.NotificationSection),
	{
		ssr: false,
		loading: tabFallback,
	},
);
const AccessTab = dynamic(() => loadAccessTab().then((m) => m.AccessTab), {
	ssr: false,
	loading: tabFallback,
});
const DataTab = dynamic(() => loadDataTab().then((m) => m.DataTab), {
	ssr: false,
	loading: tabFallback,
});

export default function SettingsPage() {
	const { wg, members, identity } = useWg();
	const t = useTranslations('settings');
	const m = useMessage();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const [exportSummary, setExportSummary] =
		useState<ReturnType<typeof buildExportSummaryFromCounts>>(buildEmptyExportSummary);
	const [exportSummaryError, setExportSummaryError] = useState<Message | null>(null);
	// The summary starts with zero counts so the CSV select has its sections; they are shown only once loaded.
	const [exportCountsLoaded, setExportCountsLoaded] = useState(false);
	// The hash is read in the mount effect below: reading it here would differ from the server render.
	const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

	// Preload tab chunks: offline, every tab switch would otherwise fail, and the import stays cached.
	useEffect(() => {
		void loadProfileTab();
		void loadNotificationSection();
		void loadAccessTab();
		void loadDataTab();
	}, []);

	// Load the export summary only once the data tab opens; afterwards it stays in state.
	const exportSummaryLoaded = useRef(false);
	useEffect(() => {
		if (activeTab !== 'data' || exportSummaryLoaded.current) return;
		let cancelled = false;
		void (async () => {
			const result = await apiFetch<{ counts: ExportSectionCounts }>(
				`/api/wg/${encodedShareCode}/export?summary=counts`,
				{ memberId: identity.memberId },
			);
			if (cancelled) return;
			if (!result.ok) {
				setExportSummaryError(
					wgLoadError({ key: 'settings.data.summaryLead' }, result.status, result.error),
				);
				return;
			}
			setExportSummary(buildExportSummaryFromCounts(result.data.counts));
			setExportCountsLoaded(true);
			setExportSummaryError(null);
			exportSummaryLoaded.current = true;
		})();
		return () => {
			cancelled = true;
		};
	}, [activeTab, encodedShareCode, identity.memberId]);

	// After a tab switch, scroll to the start of the new content, not into the middle (scroll padding keeps the bar clear).
	const previousTab = useRef(activeTab);
	useEffect(() => {
		if (previousTab.current === activeTab) return;
		previousTab.current = activeTab;
		const frame = requestAnimationFrame(() => {
			const strip = document.querySelector<HTMLElement>('[data-sticky-tabs]');
			const panel = document.querySelector<HTMLElement>('[role="tabpanel"]');
			if (!strip || !panel) return;
			if (panel.getBoundingClientRect().top < strip.getBoundingClientRect().bottom)
				panel.scrollIntoView({ block: 'start' });
		});
		return () => cancelAnimationFrame(frame);
	}, [activeTab]);

	useEffect(() => {
		const update = () => setActiveTab(getSettingsTabFromHash(window.location.hash));
		window.addEventListener('hashchange', update);
		update();
		return () => window.removeEventListener('hashchange', update);
	}, []);

	// WCAG 2.4.11: measure the sticky tab strip so the scroll-padding rule in
	// globals.css (html:has([data-sticky-tabs])) clears exactly its height,
	// including when text scaling wraps it onto a second line.
	useEffect(() => {
		const tabsList = document.querySelector<HTMLElement>('[data-sticky-tabs]');
		if (!tabsList) return;
		const setHeight = () => {
			document.documentElement.style.setProperty(
				'--settings-tabs-height',
				`${tabsList.getBoundingClientRect().height}px`,
			);
		};
		setHeight();
		const observer = new ResizeObserver(setHeight);
		observer.observe(tabsList);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			data-household-content
			className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-3 px-4 py-3"
		>
			<h1 className="font-heading min-w-0 flex-1 text-base font-semibold tracking-tight break-words text-foreground">
				{t('title')}
			</h1>
			<div className="min-w-0">
				<Tabs
					className="min-w-0"
					value={activeTab}
					onValueChange={(next) => {
						const tabId = next as SettingsTab;
						const target = SETTINGS_TABS.find((t) => t.id === tabId);
						if (target) window.history.replaceState(null, '', target.hash);
						setActiveTab(tabId);
					}}
				>
					<TabsList
						data-sticky-tabs
						className="sticky z-20 flex flex-wrap before:absolute before:-inset-x-4 before:-top-[var(--sticky-tabs-mask)] before:h-[var(--sticky-tabs-mask)] before:bg-background before:content-[''] h-auto min-w-0 max-w-full w-full gap-1 rounded-xl p-1"
						style={{
							top: 'calc(env(safe-area-inset-top, 0px) + var(--banner-stack-height, 0px) + 0.5rem)',
						}}
					>
						{SETTINGS_TABS.map((tab) => (
							<TabsTrigger
								key={tab.id}
								value={tab.id}
								id={`tab-${tab.id}`}
								className="min-w-fit flex-[1_1_auto] px-1 text-center text-xs [overflow-wrap:normal]"
							>
								{m({ key: tab.label })}
							</TabsTrigger>
						))}
					</TabsList>

					<TabsContent
						value={activeTab}
						className="mt-2 grid min-w-0 max-w-full gap-2.5 outline-none"
					>
						{activeTab === 'profile' && (
							<ProfileTab
								memberName={identity.name}
								wgName={wg.name}
								shareCode={wg.shareCode}
								memberId={identity.memberId}
							/>
						)}

						{activeTab === 'notifications' && (
							<NotificationSection code={wg.shareCode} memberId={identity.memberId} />
						)}

						{activeTab === 'access' && <AccessTab wg={wg} members={members} identity={identity} />}

						{activeTab === 'data' && (
							<DataTab
								wg={wg}
								identity={identity}
								exportSummary={exportSummary}
								exportSummaryError={exportSummaryError}
								exportCountsLoaded={exportCountsLoaded}
							/>
						)}
					</TabsContent>
				</Tabs>
			</div>
		</div>
	);
}
