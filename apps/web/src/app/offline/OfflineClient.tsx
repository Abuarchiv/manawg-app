'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { hasSupabaseEnv } from '@/core/auth/env';
import { readOfflineQueue, syncOfflineActions } from '@/core/offline/offline-client';
import {
	formatManualOfflineSyncResult,
	getOfflineSyncFailureMessage,
} from '@/core/offline/offline-copy';
import {
	type OfflineAction,
	getOfflineActionRisk,
	getOfflineActionSummary,
} from '@/core/offline/offline-queue';
import { parseTimestamp } from '@/core/utils/time';
import { type KnownWg, getKnownWgs } from '@/shared/lib/identity';
import { ArrowRight, CloudOff, RefreshCw, RotateCw, Wifi } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

function moduleLabel(action: OfflineAction): string {
	return getOfflineActionSummary(action).title;
}

export function formatOfflineAge(iso: string, now = Date.now()): string {
	const timestamp = parseTimestamp(iso);
	if (timestamp === null) return 'Zeitpunkt unklar';
	const ageMs = now - timestamp;
	if (ageMs < 0) return 'Zeitpunkt in der Zukunft';
	if (ageMs < 60_000) return 'gerade eben';
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 60) return `vor ${minutes} Min.`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `vor ${hours} Std.`;
	return `vor ${Math.floor(hours / 24)} Tagen`;
}

function countByShareCode(items: OfflineAction[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(item.shareCode, (counts.get(item.shareCode) ?? 0) + 1);
	return counts;
}

function formatQueuedActionCount(count: number): string {
	if (count === 0) return 'Keine wartenden Aktionen.';
	if (count === 1) return '1 Aktion wartet.';
	return `${count} Aktionen warten.`;
}

function formatWgQueuedActionCount(count: number): string {
	if (count === 0) return 'Keine wartenden Aktionen';
	if (count === 1) return '1 Aktion wartet';
	return `${count} Aktionen warten`;
}

function wgHref(code: string, suffix = ''): string {
	return `/wg/${encodeURIComponent(code)}${suffix}`;
}

type AccountMembership = { code: string; memberId: string };
type OfflineStatus =
	| 'checking'
	| 'browser-offline'
	| 'server-unreachable'
	| 'unauthenticated'
	| 'ready';

async function getAccountMemberships(): Promise<AccountMembership[] | null> {
	const res = await fetch('/api/wg/mine', { cache: 'no-store' });
	if (res.status === 401) return null;
	if (!res.ok) throw new Error('account_wgs_failed');
	const data: unknown = await res.json();
	if (!data || typeof data !== 'object' || !Array.isArray((data as { wgs?: unknown }).wgs)) {
		throw new Error('account_wgs_invalid');
	}
	return (data as { wgs: unknown[] }).wgs.filter(
		(wg): wg is AccountMembership =>
			typeof wg === 'object' &&
			wg !== null &&
			typeof (wg as AccountMembership).code === 'string' &&
			typeof (wg as AccountMembership).memberId === 'string',
	);
}

export function OfflineClient() {
	const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
	const [knownWgs, setKnownWgs] = useState<KnownWg[]>([]);
	const [queue, setQueue] = useState<OfflineAction[]>([]);
	const [syncing, setSyncing] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [status, setStatus] = useState<OfflineStatus>('checking');
	const syncingRef = useRef(false);
	const refreshGenerationRef = useRef(0);
	const authObserverReadyRef = useRef(false);
	const authObserverBootstrapInFlightRef = useRef(false);
	const startAuthObserverRef = useRef<() => void>(() => {});

	const refresh = useCallback(async (): Promise<OfflineAction[]> => {
		const generation = ++refreshGenerationRef.current;
		const browserOffline = typeof navigator !== 'undefined' && !navigator.onLine;
		setOnline(!browserOffline);
		setMessage(null);
		setKnownWgs([]);
		setQueue([]);
		setStatus('checking');
		if (browserOffline) {
			setStatus('browser-offline');
			return [];
		}
		if (!authObserverReadyRef.current) {
			startAuthObserverRef.current();
			return [];
		}
		try {
			const memberships = await getAccountMemberships();
			if (generation !== refreshGenerationRef.current) return [];
			if (!memberships) {
				setKnownWgs([]);
				setQueue([]);
				setStatus('unauthenticated');
				return [];
			}
			const memberKeys = new Set(memberships.map(({ code, memberId }) => `${code}:${memberId}`));
			const memberCodes = new Set(memberships.map(({ code }) => code));
			const nextQueue = readOfflineQueue().filter((action) =>
				memberKeys.has(`${action.shareCode}:${action.memberId}`),
			);
			setKnownWgs(getKnownWgs().filter((wg) => memberCodes.has(wg.code)));
			setQueue(nextQueue);
			setStatus('ready');
			return nextQueue;
		} catch {
			if (generation !== refreshGenerationRef.current) return [];
			setStatus('server-unreachable');
			return [];
		}
	}, []);

	useEffect(() => {
		const refreshOnEvent = () => void refresh();
		window.addEventListener('online', refreshOnEvent);
		window.addEventListener('offline', refreshOnEvent);
		window.addEventListener('focus', refreshOnEvent);
		window.addEventListener('manawg:offline-queue', refreshOnEvent);
		let cancelled = false;
		let authSubscription: { unsubscribe: () => void } | undefined;
		const startAuthObserver = () => {
			if (cancelled || authObserverReadyRef.current || authObserverBootstrapInFlightRef.current) {
				return;
			}
			authObserverBootstrapInFlightRef.current = true;
			if (!hasSupabaseEnv()) {
				authObserverReadyRef.current = true;
				authObserverBootstrapInFlightRef.current = false;
				void refresh();
				return;
			}
			void import('@/core/auth/client')
				.then(({ createSupabaseBrowserClient }) => {
					if (cancelled) return;
					try {
						const { data } = createSupabaseBrowserClient().auth.onAuthStateChange((event) => {
							if (cancelled) return;
							if (event !== 'INITIAL_SESSION' && event !== 'SIGNED_IN' && event !== 'SIGNED_OUT') {
								return;
							}
							authObserverReadyRef.current = true;
							authObserverBootstrapInFlightRef.current = false;
							if (event !== 'INITIAL_SESSION') {
								refreshGenerationRef.current += 1;
								setKnownWgs([]);
								setQueue([]);
								setMessage(null);
								setStatus('checking');
							}
							void refresh();
						});
						authSubscription = data.subscription;
					} catch {
						authObserverBootstrapInFlightRef.current = false;
						setStatus('server-unreachable');
					}
				})
				.catch(() => {
					if (!cancelled) {
						authObserverBootstrapInFlightRef.current = false;
						setStatus('server-unreachable');
					}
				});
		};
		startAuthObserverRef.current = startAuthObserver;
		startAuthObserver();
		return () => {
			cancelled = true;
			authObserverReadyRef.current = false;
			authObserverBootstrapInFlightRef.current = false;
			startAuthObserverRef.current = () => {};
			refreshGenerationRef.current += 1;
			window.removeEventListener('online', refreshOnEvent);
			window.removeEventListener('offline', refreshOnEvent);
			window.removeEventListener('focus', refreshOnEvent);
			window.removeEventListener('manawg:offline-queue', refreshOnEvent);
			authSubscription?.unsubscribe();
		};
	}, [refresh]);

	const queueCounts = useMemo(() => countByShareCode(queue), [queue]);
	const recentQueue = queue.slice(0, 4);
	const hiddenQueueCount = Math.max(0, queue.length - recentQueue.length);
	const primaryWg =
		knownWgs.find((wg) => (queueCounts.get(wg.code) ?? 0) > 0) ?? knownWgs[0] ?? null;
	const statusLabel =
		status === 'checking'
			? 'Wird geprüft …'
			: status === 'browser-offline'
				? 'Offline-Modus'
				: status === 'server-unreachable'
					? 'Server nicht erreichbar'
					: status === 'unauthenticated'
						? 'Anmeldung nötig'
						: 'Wieder online';
	const statusHeading =
		status === 'checking'
			? 'Verbindung wird geprüft …'
			: status === 'browser-offline'
				? 'Du bist gerade offline.'
				: status === 'server-unreachable'
					? 'Server gerade nicht erreichbar.'
					: status === 'unauthenticated'
						? 'Melde dich an, um Offline-Aktionen zu sehen.'
						: online
							? 'Du bist wieder verbunden.'
							: 'Du bist gerade offline.';
	const statusDescription =
		status === 'checking'
			? 'Einen Moment, wir prüfen deine Verbindung und dein Konto.'
			: status === 'browser-offline'
				? 'Deine lokalen Aktionen bleiben gespeichert. Details erscheinen, sobald die Verbindung dein Konto bestätigen kann.'
				: status === 'server-unreachable'
					? 'Der Server antwortet gerade nicht. Deine Aktionen bleiben gespeichert; Details erscheinen nach der Konto-Prüfung.'
					: status === 'unauthenticated'
						? 'Offline-Aktionen und gemerkte WGs hängen an deinem Konto.'
						: 'ManaWG speichert vorbereitete Aktionen auf diesem Gerät. Sobald das Netz zurück ist, kannst du sie synchronisieren und in deine WG zurückspringen.';
	const queueDescription =
		status === 'checking' || status === 'browser-offline' || status === 'server-unreachable'
			? 'Wartende Aktionen werden nach der Konto-Prüfung angezeigt.'
			: status === 'unauthenticated'
				? 'Melde dich an, um Offline-Aktionen zu prüfen.'
				: formatQueuedActionCount(queue.length);

	async function syncNow() {
		if (syncingRef.current || queue.length === 0) return;
		syncingRef.current = true;
		setSyncing(true);
		setMessage(null);
		try {
			const memberships = await getAccountMemberships();
			if (!memberships) {
				setKnownWgs([]);
				setQueue([]);
				setStatus('unauthenticated');
				setMessage('Melde dich an, bevor du Offline-Aktionen synchronisierst.');
				return;
			}
			const queuedMemberships = memberships.filter(({ code, memberId }) =>
				queue.some((action) => action.shareCode === code && action.memberId === memberId),
			);
			if (queuedMemberships.length === 0) {
				setMessage('Für diese Aktionen fehlt die passende Konto-WG. Sie bleiben gespeichert.');
				return;
			}
			let synced = 0;
			for (const { code, memberId } of queuedMemberships) {
				synced += await syncOfflineActions(code, { force: true, memberId });
			}
			const nextQueue = await refresh();
			setMessage(formatManualOfflineSyncResult(synced, nextQueue.length, { offlineLabel: false }));
		} catch {
			await refresh();
			setMessage(getOfflineSyncFailureMessage());
		} finally {
			syncingRef.current = false;
			setSyncing(false);
		}
	}

	return (
		<main
			id="main"
			tabIndex={-1}
			className="min-h-svh bg-background px-4 pt-[max(1.5rem,env(safe-area-inset-top,0px))] pb-6 text-foreground focus:outline-none"
		>
			<div className="mx-auto flex min-h-[calc(100svh-3rem)] w-full max-w-md flex-col justify-center gap-5 pb-[env(safe-area-inset-bottom)]">
				<header className="flex flex-col gap-3" aria-labelledby="offline-heading">
					<div className="flex items-center justify-between gap-3">
						<div className="flex min-w-0 items-center gap-2">
							<span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
								{online ? (
									<Wifi className="h-5 w-5 text-primary" aria-hidden />
								) : (
									<CloudOff className="h-5 w-5 text-muted-foreground" aria-hidden />
								)}
							</span>
							<Badge
								variant={status === 'ready' || status === 'checking' ? 'secondary' : 'outline'}
							>
								{statusLabel}
							</Badge>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void refresh()}
							aria-label="Offline-Status erneut prüfen"
							className="shrink-0"
						>
							<RotateCw data-icon="inline-start" aria-hidden />
							Prüfen
						</Button>
					</div>
					<h1
						id="offline-heading"
						className="font-heading text-[20px] leading-[26px] font-semibold tracking-tight"
						aria-live="polite"
					>
						{statusHeading}
					</h1>
					<p className="text-sm text-muted-foreground">{statusDescription}</p>
					{queue.length > 0 && (
						<Button
							type="button"
							onClick={syncNow}
							disabled={syncing || queue.length === 0}
							aria-label={
								syncing
									? 'Offline-Aktionen werden synchronisiert'
									: 'Offline-Aktionen jetzt synchronisieren'
							}
							size="lg"
							className="w-full"
						>
							{syncing ? (
								<Spinner className="motion-reduce:animate-none" aria-hidden />
							) : (
								<RefreshCw data-icon="inline-start" aria-hidden />
							)}
							Jetzt synchronisieren
						</Button>
					)}
					{message && (
						<Alert>
							<AlertTitle>Synchronisation</AlertTitle>
							<AlertDescription>
								<output aria-live="polite">{message}</output>
							</AlertDescription>
						</Alert>
					)}
				</header>

				<section
					aria-labelledby="offline-queue-heading"
					className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
				>
					<div className="flex items-start justify-between gap-3">
						<div>
							<h2
								id="offline-queue-heading"
								className="font-heading text-base leading-5 font-semibold"
							>
								Warteschlange
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">{queueDescription}</p>
						</div>
					</div>
					{recentQueue.length > 0 && (
						<ItemGroup className="gap-2" aria-label="Wartende Offline-Aktionen">
							{recentQueue.map((item) => {
								const summary = getOfflineActionSummary(item);
								const risk = getOfflineActionRisk(item);
								return (
									<Item key={item.id} variant="outline">
										<ItemContent>
											<ItemTitle>{summary.title}</ItemTitle>
											<ItemDescription className="truncate">{summary.detail}</ItemDescription>
											{item.lastError && (
												<p className="mt-1 text-xs text-destructive">{item.lastError}</p>
											)}
											{risk && (
												<p className="mt-1 text-xs text-muted-foreground">
													{risk.title}: {risk.detail}
												</p>
											)}
										</ItemContent>
										<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
											{formatOfflineAge(item.createdAt)}
										</span>
									</Item>
								);
							})}
						</ItemGroup>
					)}
					{hiddenQueueCount > 0 && (
						<>
							<Separator />
							<p className="text-sm text-muted-foreground">
								+{hiddenQueueCount} weitere Aktion
								{hiddenQueueCount === 1 ? '' : 'en'} in der Warteschlange.{' '}
								{primaryWg ? (
									<Button
										variant="link"
										size="lg"
										render={<Link href={wgHref(primaryWg.code, '/einstellungen#daten')} />}
										nativeButton={false}
										className="px-0"
									>
										Alle Aktionen prüfen
									</Button>
								) : (
									'Alle Aktionen prüfen'
								)}{' '}
								öffnet die vollständige Liste.
							</p>
						</>
					)}
				</section>

				<section
					aria-labelledby="known-wgs-heading"
					className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
				>
					<div>
						<h2 id="known-wgs-heading" className="font-heading text-base leading-5 font-semibold">
							Zurück in deine WG
						</h2>
					</div>
					<div className="space-y-2">
						{knownWgs.length === 0 ? (
							<p className="text-sm leading-relaxed text-muted-foreground">
								{status === 'checking' ||
								status === 'browser-offline' ||
								status === 'server-unreachable'
									? 'Gespeicherte WGs werden angezeigt, sobald dein Konto bestätigt ist.'
									: 'Noch keine WG auf diesem Gerät gemerkt. Sobald du wieder online bist, kannst du mit deinem Code erneut beitreten.'}
							</p>
						) : (
							<ItemGroup aria-label="Bekannte WGs">
								{knownWgs.slice(0, 3).map((wg) => (
									<Item
										key={wg.code}
										variant="outline"
										render={<Link href={wgHref(wg.code)} aria-label={`${wg.name} öffnen`} />}
									>
										<ItemContent>
											<ItemTitle>{wg.name}</ItemTitle>
											<ItemDescription>
												{formatWgQueuedActionCount(queueCounts.get(wg.code) ?? 0)}
											</ItemDescription>
										</ItemContent>
										<ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
									</Item>
								))}
							</ItemGroup>
						)}

						<div className="grid grid-cols-1 gap-2 pt-2">
							{primaryWg && (
								<Button
									variant="outline"
									size="lg"
									render={<Link href={wgHref(primaryWg.code, '/einstellungen#daten')} />}
									nativeButton={false}
									className="w-full"
								>
									Aktionen prüfen
								</Button>
							)}
							<Button
								variant={status === 'unauthenticated' ? 'default' : 'outline'}
								size="lg"
								render={<Link href="/neu" />}
								nativeButton={false}
								className="w-full"
							>
								{status === 'unauthenticated' ? 'Anmelden' : 'Code eingeben'}
							</Button>
						</div>
					</div>
				</section>

				<p className="text-center text-xs leading-relaxed text-muted-foreground">
					{queue.length > 0
						? `${Array.from(new Set(queue.map(moduleLabel))).join(', ')} bleibt lokal gespeichert.`
						: 'Du kannst diese Seite schließen. Sobald du online bist, lädt ManaWG wieder normal.'}
				</p>
			</div>
		</main>
	);
}
