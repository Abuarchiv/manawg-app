'use client';

import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWg } from '@/components/wg/WgContextProvider';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { readResponseErrorCode } from '@/core/guards/settings-errors';
import { SETTINGS_TABS, getSettingsTabFromHash } from '@/core/guards/settings-tabs';
import type { SettingsTab } from '@/core/guards/settings-tabs';
import { type WgExport, buildEmptyExportSummary, buildExportSummary } from '@/core/reads/export';
import { cn } from '@/shared/lib/cn';
import { memberAuthHeader } from '@/shared/lib/identity';
import { ArrowLeft } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * Only one tab is ever mounted, but statically importing all four put every
 * one of them in this route's first-load bundle — it was the heaviest route in
 * the app at 63.6 kB against a 55 kB budget, ~10 kB clear of the next page.
 * Loading each on demand means a visitor pays for the tab they opened.
 *
 * ssr:false because this page is already a client component behind a resolved
 * local identity; there is no server render of these panels to preserve.
 */
const tabFallback = () => <Skeleton className="h-40 w-full" />;

const ProfileTab = dynamic(
	() => import('@/components/wg/einstellungen/ProfileTab').then((m) => m.ProfileTab),
	{ ssr: false, loading: tabFallback },
);
const NotificationSection = dynamic(
	() =>
		import('@/components/wg/einstellungen/NotificationSection').then((m) => m.NotificationSection),
	{ ssr: false, loading: tabFallback },
);
const AccessTab = dynamic(
	() => import('@/components/wg/einstellungen/AccessTab').then((m) => m.AccessTab),
	{ ssr: false, loading: tabFallback },
);
const DataTab = dynamic(
	() => import('@/components/wg/einstellungen/DataTab').then((m) => m.DataTab),
	{ ssr: false, loading: tabFallback },
);

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function EinstellungenPage() {
	const { wg, members, identity } = useWg();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const wgBaseHref = `/wg/${encodedShareCode}`;
	const [exportSummary, setExportSummary] =
		useState<ReturnType<typeof buildExportSummary>>(buildEmptyExportSummary);
	const [exportSummaryError, setExportSummaryError] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<SettingsTab>(() =>
		typeof window === 'undefined' ? 'profile' : getSettingsTabFromHash(window.location.hash),
	);

	// Load the export summary eagerly on mount, independent of the active tab, so
	// the Daten tab shows section counts the instant it is opened. Kept in the
	// page (always mounted) rather than DataTab (conditionally rendered) so the
	// fetch fires on first paint regardless of which tab is active.
	useEffect(() => {
		let cancelled = false;
		async function loadExportSummary(): Promise<void> {
			try {
				const response = await fetch(`/api/wg/${encodedShareCode}/export`, {
					headers: memberAuthHeader(identity.memberId),
				});
				if (cancelled) return;
				if (!response.ok) {
					setExportSummaryError(
						getWgLoadErrorMessage(
							'Export-Zusammenfassung',
							response.status,
							await readResponseErrorCode(response),
						),
					);
					return;
				}
				setExportSummary(buildExportSummary((await response.json()) as WgExport));
				setExportSummaryError(null);
			} catch {
				if (!cancelled) {
					setExportSummaryError(
						getWgLoadErrorMessage('Export-Zusammenfassung', 0, 'Netzwerkfehler'),
					);
				}
			}
		}
		void loadExportSummary();
		return () => {
			cancelled = true;
		};
	}, [encodedShareCode, identity.memberId]);

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
		<div className="mx-auto min-w-0 w-full max-w-3xl px-[16px] pb-[env(safe-area-inset-bottom,0px)]">
			<div className="min-w-0 py-4">
				<header className="mb-4 flex items-center gap-2">
					<Link
						href={wgBaseHref}
						aria-label="Zurück zum Dashboard"
						className={cn(buttonVariants({ variant: 'ghost', size: 'icon-lg' }), 'shrink-0')}
					>
						<ArrowLeft aria-hidden />
						<span className="sr-only">Zurück zum Dashboard</span>
					</Link>
					<h1 className="font-heading min-w-0 flex-1 text-lg font-semibold tracking-tight break-words text-foreground">
						Einstellungen
					</h1>
				</header>

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
						className="sticky z-10 grid h-auto min-w-0 max-w-full w-full grid-cols-[repeat(auto-fit,minmax(min(100%,4rem),1fr))] gap-1 rounded-xl p-1"
						style={{
							top: 'calc(env(safe-area-inset-top, 0px) + var(--offline-banner-height, 0px) + 0.5rem)',
						}}
					>
						{SETTINGS_TABS.map((tab) => (
							<TabsTrigger
								key={tab.id}
								value={tab.id}
								id={`tab-${tab.id}`}
								className="w-full min-w-0 whitespace-normal px-1 text-center text-xs"
							>
								{tab.id === 'notifications' ? 'Hinweise' : tab.label}
							</TabsTrigger>
						))}
					</TabsList>

					<TabsContent
						value={activeTab}
						className="mt-4 grid min-w-0 max-w-full gap-4 outline-none"
					>
						{activeTab === 'profile' && (
							<ProfileTab
								memberName={identity.name}
								wgName={wg.name}
								shareCode={wg.shareCode}
								memberId={identity.memberId}
								memberToken={identity.memberToken}
							/>
						)}

						{activeTab === 'notifications' && (
							<NotificationSection
								code={wg.shareCode}
								memberId={identity.memberId}
								memberToken={identity.memberToken}
							/>
						)}

						{activeTab === 'access' && <AccessTab wg={wg} members={members} identity={identity} />}

						{activeTab === 'data' && (
							<DataTab
								wg={wg}
								identity={identity}
								exportSummary={exportSummary}
								exportSummaryError={exportSummaryError}
							/>
						)}

						<div className="text-muted-foreground pt-2 text-center text-xs">
							<p>
								ManaWG · WG-Code <span className="font-mono">{wg.shareCode}</span>
							</p>
						</div>
					</TabsContent>
				</Tabs>
			</div>
		</div>
	);
}
