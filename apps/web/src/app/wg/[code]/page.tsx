'use client';

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
import { Button, buttonVariants } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { useWg } from '@/components/wg/WgContextProvider';
import { ActivityFeed } from '@/components/wg/dashboard/ActivityFeed';
import { StartWelcome } from '@/components/wg/dashboard/StartWelcome';
import { TodayIcon } from '@/components/wg/dashboard/TodayIcon';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import type { DashboardData } from '@/core/reads/dashboard-data';
import {
	type TodayImportantItem,
	type WeekAgendaItem,
	getBerlinWeekWindow,
	getForYouItems,
	getWeekAgenda,
} from '@/core/reads/dashboard-insights';
import { getDashboardAnnouncementHref } from '@/core/reads/dashboard-links';
import { berlinDayKey } from '@/core/utils/berlin-day';
import { formatEuroCents } from '@/core/utils/money';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { type SerializedWgEvent, expandRecurrence } from '@/features/events/events';
import { cn } from '@/shared/lib/cn';
import {
	CalendarDays,
	Check,
	ChevronDown,
	ChevronRight,
	Circle,
	CircleCheck,
	Loader2,
	Megaphone,
} from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';

const PushPrimingPrompt = dynamic(
	() => import('@/shared/components/push-priming-prompt').then((m) => m.PushPrimingPrompt),
	{ ssr: false },
);

const REFRESH_INTERVAL_MS = 30_000;
const TODAY_VISIBLE = 4;

type PendingAnnouncement = DashboardData['myOpenAnnouncements'][number];

function samePendingAnnouncement(
	announcement: NonNullable<DashboardData['latestAnnouncement']>,
	pending: PendingAnnouncement,
	currentMemberName: string,
): boolean {
	if (announcement.id && announcement.id === pending.id) return true;
	return (
		!announcement.id &&
		announcement.authorName === currentMemberName &&
		announcement.content === pending.content
	);
}

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function WgHomePage() {
	const { wg, identity } = useWg();
	const [todayMoreOpen, setTodayMoreOpen] = useState(false);
	const [armedChoreId, setArmedChoreId] = useState<string | null>(null);
	const [pendingChoreId, setPendingChoreId] = useState<string | null>(null);
	const [completeNotice, setCompleteNotice] = useState<string | null>(null);
	const completionRequestKeysRef = useRef(new Map<string, string>());
	const [berlinTodayKey, setBerlinTodayKey] = useState(() => berlinDayKey(new Date()));
	const [agendaNow, setAgendaNow] = useState(() => Date.now());
	const reducedMotion = useReducedMotion();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const wgBaseHref = `/wg/${encodedShareCode}`;
	const weekWindow = useMemo(
		() => getBerlinWeekWindow(Date.parse(`${berlinTodayKey}T12:00:00.000Z`)),
		[berlinTodayKey],
	);
	const dashboardRead = useCachedFetch<DashboardData>(`/api/wg/${encodedShareCode}/dashboard`, {
		memberId: identity.memberId,
		memberToken: identity.memberToken,
	});
	const eventUrl = `/api/wg/${encodedShareCode}/events?from=${encodeURIComponent(weekWindow.from.toISOString())}&to=${encodeURIComponent(weekWindow.to.toISOString())}`;
	const eventRead = useCachedFetch<{ events: SerializedWgEvent[] }>(eventUrl, {
		memberId: identity.memberId,
		memberToken: identity.memberToken,
	});
	const data = dashboardRead.data ?? null;
	const loading = dashboardRead.isLoading;
	const error = dashboardRead.error
		? getWgLoadErrorMessage('Dashboard', dashboardRead.error.status, dashboardRead.error.error)
		: null;
	const eventOccurrences = useMemo(
		() =>
			(eventRead.data?.events ?? []).flatMap((event) =>
				expandRecurrence(event, weekWindow.from, weekWindow.to),
			),
		[eventRead.data, weekWindow],
	);
	const load = useCallback(() => {
		const now = Date.now();
		setAgendaNow(now);
		const nextTodayKey = berlinDayKey(new Date(now));
		if (nextTodayKey !== berlinTodayKey) setBerlinTodayKey(nextTodayKey);
		else void eventRead.refresh();
		void dashboardRead.refresh();
	}, [berlinTodayKey, dashboardRead.refresh, eventRead.refresh]);

	// Nur eigene Putzaufgaben lassen sich direkt abhaken. Erster Tipp merkt vor,
	// zweiter bestätigt – wie im Putzplan, damit ein versehentlicher Tipp nichts bucht.
	async function completeChore(item: TodayImportantItem): Promise<void> {
		const choreId = item.entityId;
		if (!choreId || pendingChoreId) return;
		if (armedChoreId !== choreId) {
			setArmedChoreId(choreId);
			setCompleteNotice(null);
			return;
		}
		const idempotencyKey =
			completionRequestKeysRef.current.get(choreId) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setCompleteNotice('Konnte nicht sicher gespeichert werden. Erledige es im Putzplan.');
			return;
		}
		completionRequestKeysRef.current.set(choreId, idempotencyKey);
		setPendingChoreId(choreId);
		const result = await apiFetch(
			`/api/wg/${encodedShareCode}/chores/${encodeURIComponent(choreId)}/complete`,
			{
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({
					expectedNextDueAt: item.expectedNextDueAt,
					expectedAssignedMemberId: item.expectedAssignedMemberId,
				}),
			},
		);
		setPendingChoreId(null);
		setArmedChoreId(null);
		if (result.ok || result.error === 'chore_already_completed') {
			completionRequestKeysRef.current.delete(choreId);
			setCompleteNotice(`${item.title} erledigt.`);
			void load();
			return;
		}
		if (result.error === 'chore_occurrence_changed') {
			completionRequestKeysRef.current.delete(choreId);
			setCompleteNotice(
				'Termin oder Zuständigkeit haben sich geändert. Der Plan wird aktualisiert.',
			);
			void load();
			return;
		}
		if (result.status > 0 && result.status < 500 && result.status !== 429)
			completionRequestKeysRef.current.delete(choreId);
		setCompleteNotice(
			result.status === 0
				? 'Offline: Öffne den Putzplan, dort wird die Erledigung vorgemerkt.'
				: 'Erledigt konnte nicht gespeichert werden. Versuche es gleich erneut.',
		);
	}
	useVisibilityPausedInterval(() => void load(), REFRESH_INTERVAL_MS);

	const forYouItems = useMemo(
		() =>
			data
				? getForYouItems({
						shareCode: wg.shareCode,
						currentMemberId: identity.memberId,
						openShoppingCount: data.openShoppingCount,
						openShoppingTop: data.openShoppingTop,
						dueChores: data.dueChores,
						myOpenAnnouncements: data.myOpenAnnouncements,
						dueRecurringExpenses: data.dueRecurringExpenses,
						absentMembers: data.absentMembers,
						balances: data.balances,
					})
				: [],
		[data, identity.memberId, wg.shareCode],
	);
	const forYouVisible = forYouItems.slice(0, TODAY_VISIBLE);
	const forYouMore = forYouItems.slice(TODAY_VISIBLE);
	const weekAgenda = useMemo(
		() =>
			getWeekAgenda({
				shareCode: wg.shareCode,
				currentMemberId: identity.memberId,
				dueChores: data?.dueChores ?? [],
				events: eventOccurrences,
				now: agendaNow,
			}),
		[data?.dueChores, eventOccurrences, agendaNow, identity.memberId, wg.shareCode],
	);
	const overdueVisible = weekAgenda.overdue.slice(0, TODAY_VISIBLE);
	const upcomingVisible = weekAgenda.upcoming.slice(0, TODAY_VISIBLE);
	const latestAnnouncement = data?.latestAnnouncement;
	const pendingAnnouncements = data?.myOpenAnnouncements ?? [];
	const latestIsPending = Boolean(
		latestAnnouncement &&
			pendingAnnouncements.some((item) =>
				samePendingAnnouncement(latestAnnouncement, item, identity.name),
			),
	);
	const pendingHrefs = useMemo(() => new Set(forYouItems.map((item) => item.href)), [forYouItems]);
	const activityItems = useMemo(() => {
		if (!data) return [];
		return data.activity
			.filter((item) => !item.href || !pendingHrefs.has(item.href))
			.filter((item) => {
				if (!latestAnnouncement || item.kind !== 'announcement') return true;
				if (latestAnnouncement.id) {
					return item.href !== getDashboardAnnouncementHref(wg.shareCode, latestAnnouncement.id);
				}
				return (
					item.text !== latestAnnouncement.content ||
					item.memberName !== latestAnnouncement.authorName
				);
			})
			.slice(0, latestAnnouncement ? 2 : 3);
	}, [data, latestAnnouncement, pendingHrefs, wg.shareCode]);
	const isNewWg = Boolean(
		data &&
			!data.setup.hasExpense &&
			!data.setup.hasShoppingItem &&
			!data.setup.hasAnnouncement &&
			data.setup.choreCount === 0 &&
			forYouItems.length === 0,
	);

	return (
		<>
			<div
				data-home-content
				className="mx-auto grid w-full max-w-[var(--app-frame-width)] min-w-0 grid-cols-1 gap-6 px-4 py-6"
			>
				{isNewWg && (
					<div>
						<StartWelcome />
					</div>
				)}
				{error && (
					<div>
						<LoadErrorBanner
							message={data ? `${error} Die angezeigten Daten können veraltet sein.` : error}
							onRetry={() => void load()}
							busy={loading}
							retryLabel="Dashboard erneut laden"
						/>
					</div>
				)}
				{loading && data && (
					<output aria-live="polite" className="sr-only">
						Dashboard wird neu geladen
					</output>
				)}

				{!isNewWg && (
					<section aria-labelledby="today-heading" className="flex min-w-0 flex-col gap-2">
						<h2 id="today-heading" className="font-heading text-xl font-semibold">
							Für dich
						</h2>
						{completeNotice && (
							<output className="block text-sm text-muted-foreground">{completeNotice}</output>
						)}
						{data ? (
							forYouItems.length > 0 ? (
								<>
									<ul className="flex flex-col divide-y divide-border/60 rounded-xl border">
										{forYouVisible.map((item) => (
											<TodayRow
												key={`${item.kind}:${item.entityId ?? item.href}`}
												item={item}
												armed={armedChoreId === item.entityId}
												pending={pendingChoreId === item.entityId}
												onCheck={() => void completeChore(item)}
											/>
										))}
									</ul>
									{forYouMore.length > 0 && (
										<Collapsible open={todayMoreOpen} onOpenChange={setTodayMoreOpen}>
											<CollapsibleTrigger
												render={<Button variant="ghost" className="w-full justify-between" />}
											>
												<span>
													{todayMoreOpen
														? 'Weniger anzeigen'
														: `Weitere anzeigen (${forYouMore.length})`}
												</span>
												<ChevronDown data-icon="inline-end" aria-hidden />
											</CollapsibleTrigger>
											<CollapsiblePanel {...(reducedMotion ? { transition: { duration: 0 } } : {})}>
												<ul className="mt-1 flex flex-col divide-y divide-border/60 rounded-xl border">
													{forYouMore.map((item) => (
														<TodayRow
															key={`${item.kind}:${item.entityId ?? item.href}`}
															item={item}
															armed={armedChoreId === item.entityId}
															pending={pendingChoreId === item.entityId}
															onCheck={() => void completeChore(item)}
														/>
													))}
												</ul>
											</CollapsiblePanel>
										</Collapsible>
									)}
								</>
							) : (
								<p className="flex items-center gap-2 rounded-xl border p-4 text-sm text-muted-foreground">
									<Check className="size-4 shrink-0" aria-hidden />
									Alles erledigt. Gerade gibt es nichts für dich zu tun.
								</p>
							)
						) : error ? (
							<p className="text-sm text-muted-foreground">
								Deine persönlichen Aufgaben konnten nicht geladen werden.
							</p>
						) : (
							<output aria-label="Für dich wird geladen" className="flex flex-col gap-2">
								<Skeleton className="h-14 w-full" />
								<Skeleton className="h-14 w-full" />
							</output>
						)}
					</section>
				)}

				<div className="flex min-w-0 flex-col gap-6">
					<section aria-labelledby="week-heading" className="flex min-w-0 flex-col gap-3">
						<div className="flex min-w-0 flex-wrap items-center gap-3">
							<h2 id="week-heading" className="font-heading min-w-0 text-xl font-semibold">
								Diese Woche
							</h2>
							<Link
								href={`${wgBaseHref}/kalender`}
								className={cn(
									buttonVariants({ variant: 'ghost' }),
									'min-h-11 ml-auto shrink-0 px-2 text-sm after:h-[44px] after:min-w-[44px]',
								)}
							>
								Kalender <ChevronRight data-icon="inline-end" aria-hidden />
							</Link>
						</div>

						{eventRead.isLoading && !eventRead.data && (
							<output className="text-sm text-muted-foreground">Termine werden geladen…</output>
						)}
						{eventRead.error && (
							<output className="text-sm text-muted-foreground">
								{eventRead.data
									? 'Termine konnten nicht aktualisiert werden. Angezeigte Einträge können veraltet sein.'
									: data
										? 'Termine konnten nicht geladen werden. Putzplan-Aufgaben bleiben sichtbar.'
										: 'Termine konnten nicht geladen werden.'}
							</output>
						)}
						{!data && !error && (
							<output className="text-sm text-muted-foreground">
								Putzplan-Aufgaben werden geladen…
							</output>
						)}
						{!data && error && (
							<p className="text-sm text-muted-foreground">
								Putzplan-Aufgaben konnten nicht geladen werden.
							</p>
						)}

						{weekAgenda.overdue.length > 0 && (
							<div className="flex min-w-0 flex-col gap-2">
								<h3 className="text-sm font-medium text-muted-foreground">Überfällig</h3>
								<ul className="flex min-w-0 flex-col divide-y divide-border/60 rounded-xl border">
									{overdueVisible.map((item) => (
										<AgendaRow key={item.key} item={item} />
									))}
								</ul>
								{weekAgenda.overdue.length > overdueVisible.length && (
									<Link
										href={`${wgBaseHref}/putzen?filter=overdue`}
										className={cn(
											buttonVariants({ variant: 'ghost' }),
											'min-h-11 justify-start px-0',
										)}
									>
										Alle überfälligen Aufgaben ({weekAgenda.overdue.length - overdueVisible.length})
									</Link>
								)}
							</div>
						)}

						{upcomingVisible.length > 0 && (
							<div className="flex min-w-0 flex-col gap-2">
								<ul className="flex min-w-0 flex-col divide-y divide-border/60 rounded-xl border">
									{upcomingVisible.map((item) => (
										<AgendaRow key={item.key} item={item} />
									))}
								</ul>
								{weekAgenda.upcoming.length > upcomingVisible.length && (
									<Link
										href={`${wgBaseHref}/kalender`}
										className={cn(
											buttonVariants({ variant: 'ghost' }),
											'min-h-11 justify-start px-0',
										)}
									>
										Weitere Termine und Aufgaben (
										{weekAgenda.upcoming.length - upcomingVisible.length})
									</Link>
								)}
							</div>
						)}

						{data &&
							!error &&
							!eventRead.error &&
							Boolean(eventRead.data) &&
							weekAgenda.overdue.length === 0 &&
							weekAgenda.upcoming.length === 0 && (
								<p className="rounded-xl border p-4 text-sm text-muted-foreground">
									Bis Sonntag keine WG-Termine und keine Putzaufgaben der anderen.
								</p>
							)}
					</section>

					<section aria-labelledby="wg-now-heading" className="flex min-w-0 flex-col gap-3">
						{/* Immer zugeklappt starten: Neuigkeiten öffnet man bei Bedarf selbst. */}
						<Collapsible>
							<h2 id="wg-now-heading">
								<CollapsibleTrigger
									render={
										<Button
											variant="ghost"
											className="group w-full justify-between px-0 text-muted-foreground aria-expanded:bg-transparent"
										/>
									}
								>
									Neu in deiner WG
									<ChevronDown aria-hidden className="size-4 group-aria-expanded:rotate-180" />
								</CollapsibleTrigger>
							</h2>
							<CollapsiblePanel {...(reducedMotion ? { transition: { duration: 0 } } : {})}>
								<div className="flex min-w-0 flex-col gap-3">
									<Link
										href={`${wgBaseHref}/aktivitaet`}
										className={cn(
											buttonVariants({ variant: 'ghost' }),
											'min-w-0 max-w-full self-end whitespace-normal px-0 text-[12px] text-muted-foreground leading-snug',
										)}
									>
										Ganze Chronik <ChevronRight data-icon="inline-end" aria-hidden />
									</Link>
									{data ? (
										<div className="flex flex-col gap-2">
											{latestAnnouncement && !latestIsPending && (
												<Item
													variant="muted"
													render={
														<Link
															href={
																latestAnnouncement.id
																	? getDashboardAnnouncementHref(
																			wg.shareCode,
																			latestAnnouncement.id,
																		)
																	: `${wgBaseHref}/pinnwand`
															}
														/>
													}
												>
													<ItemMedia variant="icon">
														<Megaphone aria-hidden />
													</ItemMedia>
													<ItemContent className="min-w-0">
														<ItemTitle>Neu an der Pinnwand</ItemTitle>
														<ItemDescription>
															{latestAnnouncement.authorName}: {latestAnnouncement.content}
														</ItemDescription>
													</ItemContent>
												</Item>
											)}
											{activityItems.length > 0 ? (
												<ActivityFeed items={activityItems} />
											) : !latestAnnouncement || latestIsPending ? (
												<p className="text-sm text-muted-foreground">Noch keine neuen Einträge.</p>
											) : null}
										</div>
									) : error ? (
										<p className="text-sm text-muted-foreground">
											Neuigkeiten konnten noch nicht geladen werden.
										</p>
									) : (
										<div
											className="flex flex-col gap-2"
											aria-label="Neuigkeiten werden geladen"
											// biome-ignore lint/a11y/useSemanticElements: role="status" names the loading region without swapping the wrapper element to <output>.
											role="status"
										>
											<Skeleton className="h-16 w-full" />
											<Skeleton className="h-11 w-full" />
											<Skeleton className="h-11 w-full" />
										</div>
									)}
								</div>
							</CollapsiblePanel>
						</Collapsible>
					</section>
				</div>
				<div>
					<PushPrimingPrompt
						code={wg.shareCode}
						memberId={identity.memberId}
						memberToken={identity.memberToken}
					/>
				</div>
			</div>
		</>
	);
}

function TodayRow({
	item,
	armed,
	pending,
	onCheck,
}: {
	item: TodayImportantItem;
	armed: boolean;
	pending: boolean;
	onCheck: () => void;
}) {
	const checkable = item.kind === 'chore' && item.isPersonal && Boolean(item.entityId);
	const debtAmount =
		item.kind === 'debt' && item.amountCents !== undefined
			? formatEuroCents(item.amountCents, item.currency, { signed: true })
			: undefined;
	return (
		<li className="flex min-w-0 items-center gap-1 pr-1">
			{checkable ? (
				<Button
					variant="ghost"
					size="icon"
					className="ml-1 size-9 shrink-0"
					aria-label={armed ? `Bestätigen: ${item.title} erledigt` : `Abhaken: ${item.title}`}
					aria-pressed={armed}
					disabled={pending}
					onClick={onCheck}
				>
					{pending ? (
						<Loader2 className="animate-spin" aria-hidden />
					) : armed ? (
						<CircleCheck aria-hidden />
					) : (
						<Circle className="text-muted-foreground" aria-hidden />
					)}
				</Button>
			) : (
				<span className="ml-1 flex size-9 shrink-0 items-center justify-center">
					<TodayIcon kind={item.kind} />
				</span>
			)}
			<Link
				href={item.href}
				className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-lg py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-[14px] font-medium leading-snug break-words">{item.title}</span>
					<span
						className={cn(
							'text-[12px] text-muted-foreground',
							item.kind === 'recurring' && 'tabular-nums',
						)}
					>
						{pending ? (
							'Wird gespeichert …'
						) : armed ? (
							'Nochmal tippen zum Bestätigen'
						) : debtAmount !== undefined ? (
							<>
								{item.detail} ·{' '}
								<span className="font-mono font-medium tabular-nums">{debtAmount}</span>
							</>
						) : (
							item.detail
						)}
					</span>
				</span>
				<ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			</Link>
		</li>
	);
}

const AGENDA_DAY_FORMATTER = new Intl.DateTimeFormat('de-DE', {
	weekday: 'short',
	day: 'numeric',
	month: 'short',
	timeZone: 'Europe/Berlin',
});

function formatAgendaDay(dayKey: string): string {
	return AGENDA_DAY_FORMATTER.format(new Date(`${dayKey}T12:00:00.000Z`));
}

function AgendaRow({ item }: { item: WeekAgendaItem }) {
	return (
		<li className="flex min-w-0 items-center gap-2 px-3">
			<span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground">
				{item.kind === 'event' ? (
					<CalendarDays className="size-4" aria-hidden />
				) : (
					<Check className="size-4" aria-hidden />
				)}
			</span>
			<Link
				href={item.href}
				className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-lg py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-[14px] font-medium leading-snug break-words">{item.title}</span>
					<span className="text-[12px] text-muted-foreground">
						{formatAgendaDay(item.dayKey)} · {item.detail}
					</span>
				</span>
				<ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			</Link>
		</li>
	);
}
