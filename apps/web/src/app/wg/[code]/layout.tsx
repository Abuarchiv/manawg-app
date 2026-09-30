import { AppBottomNav } from '@/components/app/AppBottomNav';
import { RouteFocusOnNavigate } from '@/components/app/RouteFocusOnNavigate';
import { WgAppHeader } from '@/components/app/WgAppHeader';
import { WG_SECTIONS } from '@/components/app/navigation';
import { ToastContainer } from '@/components/ui/Toast';
import { NavItem } from '@/components/wg/NavItem';
import { OfflineBanner } from '@/components/wg/OfflineBanner';
import { WgContextProvider } from '@/components/wg/WgContextProvider';
import { getAuthenticatedUserFromCookies } from '@/core/auth/server';
import { db, wgMembers, wgs } from '@/core/db';
import { deriveMemberToken } from '@/core/guards/member-token';
import { getE2EWgFixture, isE2EDbDownMode } from '@/core/infra/e2e-db-down';
import type { StoredIdentity } from '@/shared/lib/identity';
import { isValidShareCode, normalizeShareCode } from '@/shared/lib/share-code';
import { and, eq, isNull } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';

interface Props {
	children: ReactNode;
	params: Promise<{ code: string }>;
}

export async function generateMetadata({
	params,
}: { params: Promise<{ code: string }> }): Promise<Metadata> {
	const { code: rawCode } = await params;
	const code = normalizeShareCode(rawCode);
	if (!isValidShareCode(code)) {
		return { robots: { index: false, follow: false } };
	}
	if (isE2EDbDownMode()) {
		const fixture = getE2EWgFixture(code);
		return {
			title: fixture ? `${fixture.name} — ManaWG` : 'WG — ManaWG',
			robots: { index: false, follow: false },
		};
	}
	const user = await getAuthenticatedUserFromCookies();
	if (!user) return { title: 'WG — ManaWG', robots: { index: false, follow: false } };
	const [access] = await db
		.select({ name: wgs.name })
		.from(wgMembers)
		.innerJoin(wgs, eq(wgMembers.wgId, wgs.id))
		.where(
			and(
				eq(wgs.shareCode, code),
				eq(wgMembers.authUserId, user.id),
				isNull(wgMembers.deactivatedAt),
			),
		)
		.limit(1);
	return {
		title: access ? `${access.name} — ManaWG` : 'WG — ManaWG',
		robots: { index: false, follow: false },
	};
}

// craftsman-ignore: TS002 — Next.js App Router requires default export from layout.tsx
export default async function WgLayout({ children, params }: Props) {
	const { code: rawCode } = await params;
	const code = normalizeShareCode(rawCode);
	if (!isValidShareCode(code)) {
		notFound();
	}

	if (isE2EDbDownMode()) {
		const fixture = getE2EWgFixture(code);
		if (!fixture) notFound();
		// Fixture rosters are always fully active.
		const fixtureMembers = fixture.members.map((member) => ({ ...member, active: true }));
		return (
			<WgShell code={code} wg={fixture} members={fixtureMembers}>
				{children}
			</WgShell>
		);
	}

	const user = await getAuthenticatedUserFromCookies();
	if (!user) redirect(`/neu?next=${encodeURIComponent(`/wg/${encodeURIComponent(code)}`)}`);

	const [access] = await db
		.select({
			role: wgMembers.role,
			id: wgs.id,
			name: wgs.name,
			shareCode: wgs.shareCode,
			joiningEnabled: wgs.joiningEnabled,
			shareCodeRotatedAt: wgs.shareCodeRotatedAt,
			memberId: wgMembers.id,
			memberName: wgMembers.name,
		})
		.from(wgMembers)
		.innerJoin(wgs, eq(wgMembers.wgId, wgs.id))
		.where(
			and(
				eq(wgs.shareCode, code),
				eq(wgMembers.authUserId, user.id),
				isNull(wgMembers.deactivatedAt),
			),
		)
		.limit(1);
	if (!access) {
		redirect(`/neu?next=${encodeURIComponent(`/wg/${encodeURIComponent(code)}`)}`);
	}
	const { role, memberId, memberName, ...wg } = access;
	const memberToken = deriveMemberToken(wg.id, memberId);
	const initialIdentity: StoredIdentity = {
		memberId,
		name: memberName,
		...(memberToken ? { memberToken } : {}),
	};
	// Seed admin gating from the server; every mutation still checks authorization.
	const viewerIsAdmin = role === 'admin';

	// Load the full roster including deactivated members: history and balances
	// need every name. Choice UIs filter on `active` downstream (see
	// WgContextProvider). NULL deactivated_at means active.
	const memberRows = await db
		.select({
			id: wgMembers.id,
			name: wgMembers.name,
			color: wgMembers.color,
			paypalMerchantId: wgMembers.paypalMerchantId,
			deactivatedAt: wgMembers.deactivatedAt,
		})
		.from(wgMembers)
		.where(eq(wgMembers.wgId, wg.id));
	const members = memberRows.map(({ deactivatedAt, ...member }) => ({
		...member,
		active: deactivatedAt === null,
	}));

	return (
		<WgShell
			code={code}
			wg={wg}
			members={members}
			viewerIsAdmin={viewerIsAdmin}
			initialIdentity={initialIdentity}
		>
			{children}
		</WgShell>
	);
}

function WgShell({
	code,
	wg,
	members,
	initialIdentity,
	viewerIsAdmin,
	children,
}: {
	code: string;
	wg: {
		id: string;
		name: string;
		shareCode: string;
		joiningEnabled: boolean;
		shareCodeRotatedAt?: string | Date | null;
	};
	members: Array<{
		id: string;
		name: string;
		color?: string | null;
		paypalMerchantId?: string | null;
		active: boolean;
	}>;
	viewerIsAdmin?: boolean;
	initialIdentity?: StoredIdentity;
	children: ReactNode;
}) {
	const wgBaseHref = `/wg/${encodeURIComponent(code)}`;

	return (
		<WgContextProvider
			key={wg.id}
			wg={wg}
			members={members}
			initialIdentity={initialIdentity}
			viewerIsAdmin={viewerIsAdmin}
		>
			<div
				className="group/wg-shell min-h-svh bg-background"
				style={{
					paddingTop: 'env(safe-area-inset-top, 0px)',
					paddingBottom: 'calc(var(--app-nav-height, 5rem) + 0.5rem)',
				}}
			>
				<OfflineBanner />
				<RouteFocusOnNavigate />
				<WgAppHeader />
				{/* WCAG 1.3.1 / 2.4.1 — single <main> landmark.
				    tabIndex={-1} lets the skip-link target receive programmatic focus. */}
				<main id="main" tabIndex={-1} className="focus:outline-none">
					{children}
				</main>
			</div>
			<AppBottomNav
				aria-label="WG Hauptnavigation"
				data-app-chrome
				className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full min-w-0 max-w-[var(--app-nav-width)] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
			>
				<div className="glass-bar rounded-[18px]">
					<ul className="flex flex-wrap gap-1 p-1 [&>li]:min-w-fit [&>li]:flex-1">
						<NavItem
							href={wgBaseHref}
							label="Start"
							iconKey="home"
							activePrefixes={[`${wgBaseHref}/aktivitaet`]}
						/>
						{WG_SECTIONS.map((section) => (
							<NavItem
								key={section.label}
								href={`${wgBaseHref}/${section.pages[0].slug}`}
								label={section.label}
								iconKey={section.iconKey}
								activePrefixes={[...section.pages.map((page) => page.slug), ...section.related].map(
									(slug) => `${wgBaseHref}/${slug}`,
								)}
							/>
						))}
						{/* Vier Ziele nach Candidate A: Start, Haushalt (Einkauf/Vorräte/
					    Putzen/Kalender), Finanzen (Ausgaben/Fixkosten/Mahnungen/Import),
					    Austausch (Pinnwand/Chat). Alle bisherigen Deep Links lösen
					    weiter auf; Aktivität/Einstellungen bleiben über
					    Header- und Start-Verlinkungen erreichbar. */}
					</ul>
				</div>
			</AppBottomNav>
			{/* Last in the DOM so Tab reaches a toast's dismiss button right after
			    whatever the user just did, instead of jumping back to the page top. */}
			<ToastContainer />
		</WgContextProvider>
	);
}
