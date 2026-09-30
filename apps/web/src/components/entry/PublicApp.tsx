'use client';

import { AppBottomNav } from '@/components/app/AppBottomNav';
import { RouteFocusOnNavigate } from '@/components/app/RouteFocusOnNavigate';
import { WG_SECTIONS } from '@/components/app/navigation';
import { LegalLinks } from '@/components/entry/LegalLinks';
import {
	PublicModulePreview,
	PublicModulePreviews,
	type PublicPreviewModule,
} from '@/components/entry/PublicModulePreview';
import { WgWelcome } from '@/components/entry/WgWelcome';
import { ErrorBox } from '@/components/neu/ErrorBox';
import { AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { NavItem } from '@/components/wg/NavItem';
import { SubNav } from '@/components/wg/SubNav';
import { AccountDeleteSection } from '@/components/wg/einstellungen/AccountDeleteSection';
import { LogoMark } from '@/shared/components/ui/LogoMark';
import { cn } from '@/shared/lib/cn';
import { isValidShareCode, normalizeShareCode } from '@/shared/lib/share-code';
import {
	CalendarDays,
	Clock3,
	ListChecks,
	Megaphone,
	MessageCircle,
	Package,
	Receipt,
	Settings,
	Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

interface AccountWg {
	id: string;
	code: string;
	name: string;
}

type PublicModule = PublicPreviewModule;

const PRIMARY_MODULES: PublicModule[] = [
	{
		slug: 'ausgaben',
		title: 'Ausgaben',
		description: 'Gemeinsame Kosten im Blick.',
		Icon: Receipt,
	},
	{
		slug: 'einkauf',
		title: 'Einkäufe',
		description: 'Die nächste Einkaufsliste.',
		Icon: ListChecks,
	},
	{ slug: 'pinnwand', title: 'Pinnwand', description: 'Infos für alle.', Icon: Megaphone },
	{ slug: 'putzen', title: 'Putzplan', description: 'Aufgaben fair verteilen.', Icon: Sparkles },
];

const OTHER_MODULES: PublicModule[] = [
	{ slug: 'fixkosten', title: 'Fixkosten', description: 'Regelmäßige Kosten.', Icon: Receipt },
	{
		slug: 'mahnungen',
		title: 'Erinnerungen',
		description: 'Offene Beträge nachhalten.',
		Icon: Receipt,
	},
	{ slug: 'vorraete', title: 'Vorräte', description: 'Was noch da ist.', Icon: Package },
	{ slug: 'kalender', title: 'Kalender', description: 'Gemeinsame Termine.', Icon: CalendarDays },
	{
		slug: 'aktivitaet',
		title: 'Aktivität',
		description: 'Was zuletzt passiert ist.',
		Icon: Clock3,
	},
	{ slug: 'chat', title: 'Chat', description: 'Kurz etwas klären.', Icon: MessageCircle },
	{
		slug: 'einstellungen',
		title: 'Einstellungen',
		description: 'Die WG verwalten.',
		Icon: Settings,
	},
];

const PUBLIC_MODULES = [...PRIMARY_MODULES, ...OTHER_MODULES];

function isAccountWg(value: unknown): value is AccountWg {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const id = Reflect.get(value, 'id');
	const code = Reflect.get(value, 'code');
	const name = Reflect.get(value, 'name');
	return (
		typeof id === 'string' &&
		id.length > 0 &&
		typeof code === 'string' &&
		isValidShareCode(normalizeShareCode(code)) &&
		typeof name === 'string' &&
		name.trim().length > 0
	);
}

function parseMemberships(value: unknown): AccountWg[] | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const wgs = Reflect.get(value, 'wgs');
	if (!Array.isArray(wgs) || !wgs.every(isAccountWg)) return null;
	return wgs.map((wg) => ({ ...wg, code: normalizeShareCode(wg.code), name: wg.name.trim() }));
}

function moduleFor(slug: string | undefined): PublicModule | null {
	return PUBLIC_MODULES.find((item) => item.slug === slug) ?? null;
}

function withInvitation(path: string, code: string): string {
	return `${path}?code=${encodeURIComponent(code)}`;
}

export function PublicApp(props: { activeModule?: string }) {
	return (
		<Suspense
			fallback={
				<div className="flex min-h-svh flex-col gap-4 bg-background p-4" aria-busy="true">
					<Skeleton className="h-12 w-full" />
					<Skeleton className="h-48 w-full" />
				</div>
			}
		>
			<PublicAppContent {...props} />
		</Suspense>
	);
}

function PublicAppContent({ activeModule }: { activeModule?: string }) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const accountDeletionPending = searchParams.get('accountDeletion') === 'pending';
	const [memberships, setMemberships] = useState<AccountWg[]>([]);
	const [membershipState, setMembershipState] = useState<
		'loading' | 'signed-out' | 'authenticated-empty' | 'member-list' | 'error'
	>('loading');
	const [retryNonce, setRetryNonce] = useState(0);
	const module = moduleFor(activeModule);
	const inviteCode = useMemo(() => {
		const code = normalizeShareCode(searchParams.get('code') ?? '');
		return isValidShareCode(code) ? code : '';
	}, [searchParams]);
	const publicHref = (path: string): string =>
		inviteCode ? withInvitation(path, inviteCode) : path;
	const singleWg =
		membershipState === 'member-list' && memberships.length === 1 ? memberships[0] : null;
	const accountAction =
		membershipState === 'member-list'
			? {
					href: singleWg ? `/wg/${encodeURIComponent(singleWg.code)}` : '/',
					label: singleWg ? 'WG öffnen' : 'Deine WGs',
				}
			: membershipState === 'authenticated-empty'
				? inviteCode
					? { href: publicHref('/neu'), label: 'Dieser WG beitreten' }
					: { href: '/neu?action=create', label: 'WG erstellen' }
				: { href: publicHref('/neu'), label: 'Anmelden' };

	// biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce deliberately reruns the lookup without affecting its request shape.
	useEffect(() => {
		const controller = new AbortController();
		setMembershipState('loading');
		fetch('/api/wg/mine', { cache: 'no-store', signal: controller.signal })
			.then(async (response) => {
				if (response.status === 401) {
					setMemberships([]);
					setMembershipState('signed-out');
					return;
				}
				if (!response.ok) throw new Error('membership_lookup_failed');
				const parsed = parseMemberships(await response.json());
				if (!parsed) throw new Error('membership_response_invalid');
				setMemberships(parsed);
				setMembershipState(parsed.length === 0 ? 'authenticated-empty' : 'member-list');
			})
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === 'AbortError') return;
				setMembershipState('error');
			});
		return () => controller.abort();
	}, [retryNonce]);

	useEffect(() => {
		if (module || inviteCode || membershipState !== 'member-list' || memberships.length !== 1)
			return;
		const membership = memberships[0];
		if (!membership) return;
		router.replace(`/wg/${encodeURIComponent(membership.code)}`);
	}, [inviteCode, memberships, membershipState, module, router]);

	const section = WG_SECTIONS.find(
		(item) =>
			item.pages.some(
				(page) =>
					page.slug === activeModule || (page.slug === 'abos' && activeModule === 'fixkosten'),
			) || item.related.some((slug) => slug === activeModule),
	);
	const discoveryHref = (slug: string) =>
		publicHref(`/entdecken/${slug === 'abos' ? 'fixkosten' : slug}`);

	return (
		<div
			className="min-h-svh bg-background"
			style={{
				paddingTop: 'env(safe-area-inset-top, 0px)',
				paddingBottom: 'calc(var(--app-nav-height, 5rem) + 0.5rem)',
			}}
		>
			<RouteFocusOnNavigate />
			<main
				id="main"
				tabIndex={-1}
				className="flex w-full min-w-0 flex-col gap-6 px-4 py-5 focus:outline-none"
			>
				{accountDeletionPending && (
					<output
						aria-live="polite"
						className="block w-full min-w-0 rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-card-foreground"
					>
						<AlertDescription>
							ManaWG hat deine Zugänge zu allen WGs entfernt. Die Löschung beim Anmeldedienst steht
							noch aus und wird automatisch erneut versucht.
						</AlertDescription>
					</output>
				)}
				<div className="flex min-w-0 flex-col gap-6">
					<header className="flex flex-col gap-3">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<Link
								href={publicHref('/')}
								className="flex min-h-11 items-center gap-2"
								aria-label="ManaWG Startseite"
							>
								<LogoMark size={24} tile={false} aria-hidden />
								<span className="font-heading text-xl font-semibold tracking-[-0.03em]">
									ManaWG
								</span>
							</Link>
							<Link
								href={accountAction.href}
								className={cn(
									buttonVariants({ variant: 'link' }),
									'ml-auto px-0 text-muted-foreground',
								)}
							>
								{accountAction.label}
							</Link>
						</div>
						<div className="flex flex-col gap-1">
							<h1 className="font-heading text-[22px] leading-7 font-semibold tracking-tight">
								{module?.title ?? 'Euer WG-Alltag. Gemeinsam geregelt.'}
							</h1>
							<p className="text-sm text-muted-foreground">
								{module?.description ?? 'Einkäufe planen, Kosten teilen und Aufgaben verteilen.'}
							</p>
						</div>
					</header>
					{section && (
						<SubNav
							label={`${section.label} – entdecken`}
							items={section.pages.map((page) => ({
								href: discoveryHref(page.slug),
								label: page.label,
								icon: page.icon,
							}))}
						/>
					)}
					{inviteCode ? (
						<WgWelcome variant="invitation" code={inviteCode} compact />
					) : (
						<WgWelcome variant="create" compact />
					)}
					{module ? (
						<PublicModulePreview module={module} homeHref={publicHref('/')} />
					) : (
						<PublicModulePreviews modules={PRIMARY_MODULES} />
					)}
					{membershipState === 'loading' && (
						<output aria-live="polite" aria-label="Deine WGs werden geprüft" className="block">
							<Skeleton className="h-11 w-full" />
						</output>
					)}
					{membershipState === 'error' && (
						<div className="flex flex-col gap-2">
							<ErrorBox>Deine WGs konnten gerade nicht geladen werden.</ErrorBox>
							<Button
								type="button"
								variant="outline"
								onClick={() => setRetryNonce((value) => value + 1)}
							>
								Erneut prüfen
							</Button>
						</div>
					)}
					{/* Signed-in users without a WG never reach WG settings, so offer deletion here. */}
					{membershipState === 'authenticated-empty' && <AccountDeleteSection />}
					{membershipState === 'member-list' && memberships.length > 1 && !inviteCode && (
						<Card>
							<CardHeader>
								<CardTitle>
									<h2>Deine WGs</h2>
								</CardTitle>
								<CardDescription>Wo möchtest du weitermachen?</CardDescription>
							</CardHeader>
							<CardContent>
								<ItemGroup>
									{memberships.map((membership) => (
										<Item
											key={membership.id}
											variant="outline"
											render={<Link href={`/wg/${encodeURIComponent(membership.code)}`} />}
										>
											<ItemContent className="min-w-0">
												<ItemTitle className="line-clamp-none break-words">
													{membership.name}
												</ItemTitle>
												<ItemDescription>WG öffnen</ItemDescription>
											</ItemContent>
										</Item>
									))}
								</ItemGroup>
							</CardContent>
						</Card>
					)}
				</div>
				<LegalLinks />
			</main>
			<AppBottomNav
				aria-label="Öffentliche Hauptnavigation"
				data-app-chrome
				className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full min-w-0 max-w-[var(--app-nav-width)] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
			>
				<div className="rounded-[20px] border border-border bg-background text-foreground">
					<ul className="flex flex-wrap gap-1 p-1 [&>li]:min-w-fit [&>li]:flex-1">
						<NavItem
							href={publicHref('/')}
							label="Start"
							iconKey="home"
							activePrefixes={[discoveryHref('aktivitaet')]}
						/>
						{WG_SECTIONS.map((item) => (
							<NavItem
								key={item.label}
								href={discoveryHref(item.pages[0].slug)}
								label={item.label}
								iconKey={item.iconKey}
								activePrefixes={[...item.pages.map((page) => page.slug), ...item.related].map(
									discoveryHref,
								)}
							/>
						))}
					</ul>
				</div>
			</AppBottomNav>
		</div>
	);
}
