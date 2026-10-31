'use client';

import { History, Search } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
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
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemGroupEntry,
	ItemTitle,
} from '@/components/ui/item';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { useText } from '@/components/wg/use-text';
import { useWg } from '@/components/wg/WgContextProvider';
import {
	type ActivityFilter,
	type ActivityKind,
	activityDayRelation,
	buildActivityInbox,
	filterActivityItems,
	groupActivityItemsByDay,
} from '@/composition/activity';
import { dayMonthOptions } from '@/core/utils/time';
import { dateTimeFormat } from '@/shared/i18n/intl';
import type { Locale } from '@/shared/i18n/locale';
import { cn } from '@/shared/lib/cn';
import { ActivityFeed } from '../_components/ActivityFeed';
import { useActivityFeed } from './use-activity-feed';

const PAGE_SIZE = 80;
const MAX_ITEMS = 320;

export default function ActivityPage() {
	const t = useTranslations('activity.page');
	const tFeed = useTranslations('activity.feed');
	const text = useText();
	const locale = useLocale() as Locale;
	const { wg, identity } = useWg();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const wgBaseHref = `/wg/${encodedShareCode}`;
	// The server returns the newest N entries; "load more" raises N (see the activity route).
	const [limit, setLimit] = useState(PAGE_SIZE);
	const {
		items,
		reminders,
		loaded,
		loading,
		error,
		reload: reloadActivity,
	} = useActivityFeed({ shareCode: wg.shareCode, memberId: identity.memberId, limit });
	const [filter, setFilter] = useState<ActivityFilter>({ kind: 'all', mineOnly: false, query: '' });

	const filteredItems = useMemo(
		() => filterActivityItems(items, filter, identity.name, identity.memberId),
		[items, filter, identity.memberId, identity.name],
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
		() => (reminders ? buildActivityInbox({ reminders }) : []),
		[reminders],
	);

	// Groups are keyed by Berlin calendar day; the label follows the reader's language.
	function dayLabel(date: string): string {
		const relation = activityDayRelation(date);
		if (relation) return t(relation);
		return dateTimeFormat(locale, {
			weekday: 'short',
			...dayMonthOptions(locale),
			timeZone: 'Europe/Berlin',
		}).format(new Date(`${date}T12:00:00.000Z`));
	}

	function setKind(kind: ActivityKind | 'all'): void {
		setFilter((current) => ({ ...current, kind }));
	}

	const hasActiveFilter =
		filter.kind !== 'all' || filter.mineOnly || filter.query.trim().length > 0;
	const canLoadMore = loaded && items.length >= limit && limit < MAX_ITEMS;

	function resetFilters(): void {
		setFilter({ kind: 'all', mineOnly: false, query: '' });
		// The button disappears with the empty state: focus the scope filter instead (does not open the keyboard).
		document.getElementById('activity-kind')?.focus({ preventScroll: true });
	}

	return (
		<div
			data-household-content
			className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-3 px-4 py-3"
		>
			<h1 className="font-heading min-w-0 flex-1 text-base font-semibold tracking-tight break-words text-foreground">
				{t('heading')}
			</h1>

			{error && (
				<LoadErrorBanner
					message={error}
					onRetry={() => reloadActivity()}
					busy={loading}
					retryLabel={t('reload')}
				/>
			)}

			{/* Filters stay above the inbox: the inbox disappears while searching, which would otherwise shift the field out from under the finger. */}
			{loaded && items.length > 0 && (
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
								placeholder={t('searchPlaceholder')}
								aria-label={t('searchLabel')}
								className="min-h-11 text-base"
							/>
						</InputGroup>
						<div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
							<label htmlFor="activity-kind" className="grid min-w-0 gap-1 text-xs font-medium">
								{t('scope')}
								<NativeSelect
									id="activity-kind"
									value={filter.kind}
									onChange={(event) => setKind(event.target.value as ActivityKind | 'all')}
									className="w-full"
								>
									<NativeSelectOption value="all">{t('kinds.all')}</NativeSelectOption>
									<NativeSelectOption value="expense">{t('kinds.expense')}</NativeSelectOption>
									<NativeSelectOption value="shopping">{t('kinds.shopping')}</NativeSelectOption>
									<NativeSelectOption value="announcement">
										{t('kinds.announcement')}
									</NativeSelectOption>
									<NativeSelectOption value="chore">{t('kinds.chore')}</NativeSelectOption>
									<NativeSelectOption value="recurring">{t('kinds.recurring')}</NativeSelectOption>
									<NativeSelectOption value="absence">{t('kinds.absence')}</NativeSelectOption>
									<NativeSelectOption value="audit">{t('kinds.audit')}</NativeSelectOption>
								</NativeSelect>
							</label>
							<label htmlFor="activity-who" className="grid min-w-0 gap-1 text-xs font-medium">
								{t('who')}
								<NativeSelect
									id="activity-who"
									value={filter.mineOnly ? 'mine' : 'all'}
									onChange={(event) => {
										const mineOnly = event.target.value === 'mine';
										setFilter((current) => ({ ...current, mineOnly }));
									}}
									className="w-full"
								>
									<NativeSelectOption value="all">{t('kinds.all')}</NativeSelectOption>
									<NativeSelectOption value="mine">{t('onlyMe')}</NativeSelectOption>
								</NativeSelect>
							</label>
						</div>
					</CardContent>
				</Card>
			)}

			{loaded && inboxItems.length > 0 && !hasActiveFilter && (
				<Card>
					<CardHeader>
						<div className="flex min-w-0 items-baseline justify-between gap-2">
							<CardTitle className="min-w-0">{t('open')}</CardTitle>
							<span className="shrink-0 text-xs text-muted-foreground">{inboxItems.length}</span>
						</div>
					</CardHeader>
					<CardContent>
						<ItemGroup aria-label={t('openLabel')}>
							{inboxItems.map((item) => (
								<ItemGroupEntry
									key={item.id}
									className="w-full min-w-0 border-b border-border last:border-b-0"
								>
									<Item
										size="sm"
										className="rounded-none border-0 px-0"
										render={<Link href={`${wgBaseHref}${item.href}`} />}
									>
										<ItemContent className="min-w-0">
											<ItemTitle
												className={cn(
													'line-clamp-none w-full min-w-0 [overflow-wrap:break-word]',
													item.priority === 'high' && 'font-semibold',
												)}
											>
												{text(item.title)}
											</ItemTitle>
											<ItemDescription className="line-clamp-2 min-w-0 [overflow-wrap:break-word]">
												{text(item.detail)}
											</ItemDescription>
										</ItemContent>
									</Item>
								</ItemGroupEntry>
							))}
						</ItemGroup>
					</CardContent>
				</Card>
			)}

			<Card className="overflow-visible border-0 bg-transparent py-0 shadow-none">
				<CardContent className="p-0">
					{loaded ? (
						<div className="space-y-3">
							{/* Always mounted so screen readers announce every change of the result count. */}
							{items.length > 0 && (
								<output
									aria-live="polite"
									className={cn(
										'block text-meta text-muted-foreground',
										(!hasActiveFilter || chronicleGroups.length === 0) && 'sr-only',
									)}
								>
									{t('visibleCount', { count: filteredItems.length })}
								</output>
							)}
							{chronicleGroups.length > 0 ? (
								chronicleGroups.map((group) => (
									<div key={group.date} className="space-y-2">
										<Marker variant="separator">
											<MarkerContent>
												<span className="font-medium">{dayLabel(group.date)}</span>
											</MarkerContent>
										</Marker>
										<ActivityFeed items={group.items} />
									</div>
								))
							) : hasActiveFilter ? (
								<Empty className="border-0 py-5">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<Search aria-hidden />
										</EmptyMedia>
										<EmptyTitle>{t('noMatch')}</EmptyTitle>
									</EmptyHeader>
									<EmptyContent>
										<Button type="button" variant="outline" size="sm" onClick={resetFilters}>
											{t('resetFilters')}
										</Button>
									</EmptyContent>
								</Empty>
							) : (
								<Empty className="border-0 py-5">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<History aria-hidden />
										</EmptyMedia>
										<EmptyTitle>{tFeed('emptyTitle')}</EmptyTitle>
										<EmptyDescription>{tFeed('emptyDescription')}</EmptyDescription>
									</EmptyHeader>
								</Empty>
							)}
							{items.length > 0 && hasActiveFilter && canLoadMore && (
								<p className="text-meta text-muted-foreground">
									{t('filteredWithin', { count: String(items.length) })}
								</p>
							)}
							{canLoadMore && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="w-full"
									disabled={loading}
									onClick={() => setLimit((current) => current + PAGE_SIZE)}
								>
									{t('loadOlder')}
								</Button>
							)}
						</div>
					) : loading ? (
						<div className="space-y-2" aria-label={t('loadingLabel')} role="status">
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
					) : error ? null : (
						<p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-meta text-muted-foreground">
							{t('notLoaded')}
						</p>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
