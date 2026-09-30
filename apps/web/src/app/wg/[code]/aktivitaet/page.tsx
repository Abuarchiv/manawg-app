'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { BackLink } from '@/components/wg/BackLink';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { useWg } from '@/components/wg/WgContextProvider';
import { ActivityFeed } from '@/components/wg/dashboard/ActivityFeed';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import {
	type ActivityFilter,
	type ActivityItem,
	type ActivityKind,
	type ActivityReminder,
	type ActivityScope,
	buildActivityInbox,
	filterActivityByScope,
	filterActivityItems,
	groupActivityItemsByDay,
} from '@/core/reads/activity';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { AlertTriangle, History, Search } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface ActivityResponse {
	items: ActivityItem[];
	reminders: ActivityReminder[];
}

function formatVisibleActivityCount(count: number): string {
	if (count === 0) return 'Keine sichtbaren Chronik-Einträge.';
	if (count === 1) return '1 Chronik-Eintrag sichtbar.';
	return `${count} Chronik-Einträge sichtbar.`;
}

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function AktivitaetPage() {
	const { wg, identity } = useWg();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const wgBaseHref = `/wg/${encodedShareCode}`;
	const {
		data: cachedActivity,
		error: activityError,
		isLoading: activityLoading,
		refresh: refreshActivity,
	} = useCachedFetch<ActivityResponse>(`/api/wg/${encodedShareCode}/activity`, {
		memberId: identity.memberId,
	});
	const [data, setData] = useState<ActivityResponse | null>(cachedActivity ?? null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(activityLoading);
	const [filter, setFilter] = useState<ActivityFilter>({ kind: 'all', mineOnly: false, query: '' });
	const [scope, setScope] = useState<ActivityScope>('all');
	const requestIdRef = useRef(0);

	const load = useCallback(async (): Promise<void> => {
		const requestId = requestIdRef.current + 1;
		requestIdRef.current = requestId;
		setLoading(true);
		try {
			const res = await refreshActivity();
			if (requestId !== requestIdRef.current) return;
			if (res.ok) {
				setData(res.data);
				setError(null);
			} else {
				setError(getWgLoadErrorMessage('Aktivität', res.status, res.error));
			}
		} finally {
			if (requestId === requestIdRef.current) setLoading(false);
		}
	}, [refreshActivity]);

	useEffect(() => {
		void load();
	}, [load]);
	useVisibilityPausedInterval(() => void load(), 30_000);

	useEffect(() => {
		if (cachedActivity) {
			setData(cachedActivity);
			setError(null);
			setLoading(false);
		} else if (activityError) {
			setError(getWgLoadErrorMessage('Aktivität', activityError.status, activityError.error));
			setLoading(false);
		}
	}, [activityError, cachedActivity]);

	const filteredItems = useMemo(
		() =>
			filterActivityByScope(
				filterActivityItems(data?.items ?? [], filter, identity.name, identity.memberId),
				scope,
				identity.name,
				identity.memberId,
			),
		[data?.items, filter, identity.memberId, identity.name, scope],
	);
	const chronicleGroups = useMemo(
		() =>
			groupActivityItemsByDay(
				filteredItems.map((item) =>
					item.href ? { ...item, href: `${wgBaseHref}${item.href}` } : item,
				),
			),
		[filteredItems, wgBaseHref],
	);
	const inboxItems = useMemo(
		() =>
			data
				? buildActivityInbox({
						reminders: data.reminders,
						items: data.items,
						currentMemberName: identity.name,
						currentMemberId: identity.memberId,
					})
				: [],
		[data, identity.memberId, identity.name],
	);
	const openInboxCount = inboxItems.filter((item) => item.priority === 'high').length;
	const inboxCountLabel =
		openInboxCount > 0 ? `${openInboxCount} offen` : `${inboxItems.length} für dich`;

	function setKind(kind: ActivityKind | 'all'): void {
		setFilter((current) => ({ ...current, kind }));
	}

	const hasActiveFilter =
		scope !== 'all' || filter.kind !== 'all' || filter.mineOnly || filter.query.trim().length > 0;

	function resetFilters(): void {
		setScope('all');
		setFilter({ kind: 'all', mineOnly: false, query: '' });
	}

	return (
		<div className="mx-auto min-w-0 w-full max-w-3xl space-y-4 bg-background px-4 py-4 pb-[env(safe-area-inset-bottom)]">
			<header className="flex items-start gap-2">
				<BackLink href={wgBaseHref} label="Dashboard" />
				<div className="min-w-0 flex-1">
					<h1 className="font-heading text-lg font-semibold tracking-tight text-foreground">
						Aktivität
					</h1>
					<p className="mt-0.5 text-[12px] text-muted-foreground">
						Verlauf, Erinnerungen und offene Klärungen.
					</p>
				</div>
			</header>

			{error && (
				<LoadErrorBanner
					message={error}
					onRetry={() => void load()}
					busy={loading}
					retryLabel="Aktivität erneut laden"
				/>
			)}

			{data && inboxItems.length > 0 && (
				<Card>
					<CardHeader>
						<div className="flex min-w-0 items-center justify-between gap-2">
							<CardTitle className="flex min-w-0 items-center gap-2">
								<AlertTriangle className="h-4 w-4" aria-hidden />
								Inbox
							</CardTitle>
							<Badge variant="secondary" className="shrink-0">
								{inboxCountLabel}
							</Badge>
						</div>
					</CardHeader>
					<CardContent>
						{inboxItems.length > 0 ? (
							<ItemGroup aria-label="Offene Klärungen">
								{inboxItems.map((item) => (
									<Item
										key={item.id}
										size="sm"
										className="rounded-none border-b border-border last:border-0"
										render={<Link href={`${wgBaseHref}${item.href}`} />}
									>
										<ItemContent className="min-w-0">
											<ItemTitle className="min-w-0 w-full">
												<span className="flex items-center justify-between gap-2">
													<span className="line-clamp-1">{item.title}</span>
													{item.priority === 'high' && (
														<Badge variant="destructive" className="shrink-0">
															Wichtig
														</Badge>
													)}
												</span>
											</ItemTitle>
											<ItemDescription className="min-w-0 line-clamp-1">
												{item.detail}
											</ItemDescription>
										</ItemContent>
									</Item>
								))}
							</ItemGroup>
						) : (
							<p className="py-1 text-[12px] text-muted-foreground">Keine offenen Klärungen.</p>
						)}
					</CardContent>
				</Card>
			)}

			<Card className="overflow-visible border-0 bg-transparent py-0 shadow-none">
				<CardContent className="space-y-3 p-0">
					<InputGroup>
						<InputGroupAddon align="inline-start">
							<Search className="h-4 w-4" aria-hidden />
						</InputGroupAddon>
						<InputGroupInput
							type="search"
							value={filter.query}
							onChange={(event) => {
								const query = event.currentTarget.value;
								setFilter((current) => ({ ...current, query }));
							}}
							placeholder="Aktivität durchsuchen"
							aria-label="Aktivität durchsuchen"
							className="min-h-11 text-base"
						/>
					</InputGroup>
					<div className="grid grid-cols-2 gap-2">
						<label htmlFor="activity-scope" className="grid min-w-0 gap-1 text-xs font-medium">
							Umfang
							<NativeSelect
								id="activity-scope"
								value={scope}
								onChange={(event) => setScope(event.target.value as ActivityScope)}
								className="w-full [&_select]:min-h-10"
							>
								<NativeSelectOption value="all">Alle</NativeSelectOption>
								<NativeSelectOption value="system">System</NativeSelectOption>
								<NativeSelectOption value="mine">Von mir</NativeSelectOption>
								<NativeSelectOption value="changes">Änderungen</NativeSelectOption>
								<NativeSelectOption value="done">Erledigungen</NativeSelectOption>
							</NativeSelect>
						</label>
						<label htmlFor="activity-kind" className="grid min-w-0 gap-1 text-xs font-medium">
							Bereich
							<NativeSelect
								id="activity-kind"
								value={filter.kind}
								onChange={(event) => setKind(event.target.value as ActivityKind | 'all')}
								className="w-full [&_select]:min-h-10"
							>
								<NativeSelectOption value="all">Alle</NativeSelectOption>
								<NativeSelectOption value="expense">Ausgaben</NativeSelectOption>
								<NativeSelectOption value="shopping">Einkauf</NativeSelectOption>
								<NativeSelectOption value="announcement">Pinnwand</NativeSelectOption>
								<NativeSelectOption value="chore">Putzen</NativeSelectOption>
								<NativeSelectOption value="recurring">Fixkosten</NativeSelectOption>
								<NativeSelectOption value="absence">Abwesenheiten</NativeSelectOption>
								<NativeSelectOption value="audit">Audit</NativeSelectOption>
							</NativeSelect>
						</label>
					</div>
				</CardContent>
			</Card>

			<Card className="overflow-visible border-0 bg-transparent py-0 shadow-none">
				<CardContent className="p-0">
					{data ? (
						chronicleGroups.length > 0 ? (
							<div className="space-y-5">
								<output aria-live="polite" className="block text-[12px] text-muted-foreground">
									{formatVisibleActivityCount(filteredItems.length)}
								</output>
								{chronicleGroups.map((group) => (
									<div key={group.date} className="space-y-2">
										<Marker variant="separator">
											<MarkerContent>
												<span className="font-medium">
													{group.label} · {group.items.length}
												</span>
											</MarkerContent>
										</Marker>
										{/* Eine umrandete Liste pro Tag statt einer Karte pro Eintrag. */}
										<div className="rounded-xl border px-3">
											<ActivityFeed items={group.items} />
										</div>
									</div>
								))}
							</div>
						) : hasActiveFilter ? (
							<Empty className="gap-3 border-0 px-0 py-5">
								<EmptyHeader>
									<EmptyTitle>Keine Aktivität für diesen Filter.</EmptyTitle>
									<EmptyDescription>
										<output aria-live="polite">
											{formatVisibleActivityCount(filteredItems.length)}
										</output>
									</EmptyDescription>
								</EmptyHeader>
								<EmptyContent>
									<Button type="button" variant="outline" size="sm" onClick={resetFilters}>
										Filter zurücksetzen
									</Button>
								</EmptyContent>
							</Empty>
						) : (
							<Empty className="gap-3 border-0 px-0 py-5">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<History aria-hidden />
									</EmptyMedia>
									<EmptyTitle>Noch keine Aktivität.</EmptyTitle>
									<EmptyDescription>Neue Einträge und Änderungen erscheinen hier.</EmptyDescription>
								</EmptyHeader>
							</Empty>
						)
					) : loading ? (
						// biome-ignore lint/a11y/useSemanticElements: role="status" names the loading region without swapping the wrapper element to <output>.
						<div className="space-y-2" aria-label="Aktivität lädt" role="status">
							<div className="flex justify-center py-2">
								<Spinner className="motion-reduce:animate-none" aria-hidden />
							</div>
							{[0, 1, 2].map((index) => (
								<div key={index} className="flex items-start gap-3 py-2">
									<Skeleton className="size-8 shrink-0 rounded-full" />
									<div className="flex-1 space-y-2">
										<Skeleton className="h-4 w-3/4" />
										<Skeleton className="h-3 w-1/2" />
									</div>
								</div>
							))}
						</div>
					) : (
						<p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
							Keine Aktivität geladen. Versuche es erneut.
						</p>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
