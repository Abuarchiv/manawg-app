'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import type { SessionMember } from '@/core/auth/local-account';
import {
	subscribeOnline,
	subscribeVisibility,
	useOnlineStatus,
} from '@/core/hooks/use-online-status';
import { cn } from '@/shared/lib/cn';
import { useMembersPolling, useMembersRefresh } from './use-members-refresh';
import { useMembershipLost } from './use-membership-lost';
import { useOfflineAutoSync, useSyncOnFocusAndOnline } from './use-offline-auto-sync';
import { useSessionMember } from './use-session-member';
import { initWgSessionState, type WgAuthRef, wgSessionReducer } from './wg-session-state';

export interface WgSummary {
	id: string;
	name: string;
	shareCode: string;
}

export interface Member {
	id: string;
	name: string;
	color?: string | null;
	// false when the member has moved out ("Auszug"). The context always holds
	// the full roster so history and balances keep resolving names; choice UIs
	// (identity picker, dropdowns, chore rotation) filter to active members.
	active: boolean;
	// Optional: E2E fixtures and older responses omit them.
	isAdmin?: boolean;
	// false when the account behind the member is gone (e.g. deleted account).
	hasAccount?: boolean;
}

interface WgContextValue {
	wg: WgSummary;
	members: Member[];
	identity: SessionMember;
	refreshMembers: () => Promise<void>;
	// Whether the caller is the WG admin — UI gating only (deactivate/
	// reactivate buttons, chat admin-delete). Every mutation re-checks
	// server-side, so this being stale/spoofed can't grant real access.
	isAdmin: boolean;
	/** The account session is confirmed; background work that needs it (tab warmup) waits for it. */
	accountReady: boolean;
}

const WgContext = createContext<WgContextValue | null>(null);

interface Props {
	wg: WgSummary;
	members: Member[];
	initialIdentity?: SessionMember | undefined;
	/** Server-verified admin flag; only meaningful together with initialIdentity.authUserId. */
	initialIsAdmin?: boolean | undefined;
	children: ReactNode;
}

export function WgContextProvider({
	wg,
	members: initialMembers,
	initialIdentity,
	initialIsAdmin,
	children,
}: Props) {
	const t = useTranslations('shell.wgProvider');
	// The WG layout resolved the Supabase session and membership on the server
	// (authUserId is only set there). Start ready instead of waiting for
	// the /api/wg/[code] lookup; it still revalidates in the background and
	// clears everything once the session ends.
	const serverVerified = Boolean(initialIdentity?.authUserId);
	const [members, setMembers] = useState<Member[]>(initialMembers);
	const [session, dispatch] = useReducer(wgSessionReducer, undefined, () =>
		initWgSessionState(initialIdentity, initialIsAdmin),
	);
	const { identity, isAdmin, accountReady, memberLoaded, memberLoadError, sessionEnded } = session;
	const auth = useRef<WgAuthRef>({
		userId: initialIdentity?.authUserId ?? null,
		generation: 0,
		syncAbort: null,
	});
	const encodedShareCode = encodeURIComponent(wg.shareCode);

	const { hydrated, loadSessionMember } = useSessionMember({
		wg,
		initialIdentity,
		auth,
		dispatch,
	});

	useMembershipLost({ wgId: wg.id, encodedShareCode, auth, dispatch });

	const refreshMembers = useMembersRefresh({
		encodedShareCode,
		identity,
		accountReady,
		serverVerified,
		auth,
		setMembers,
		dispatch,
	});

	const value = useMemo<WgContextValue | null>(() => {
		if (!identity) return null;
		// The roster is the source of truth for names, so a rename shows up in the identity too.
		const rosterName = members.find((m) => m.id === identity.memberId)?.name;
		const current =
			rosterName && rosterName !== identity.name ? { ...identity, name: rosterName } : identity;
		return { wg, members, identity: current, refreshMembers, isAdmin, accountReady };
	}, [wg, members, identity, refreshMembers, isAdmin, accountReady]);

	// Hook order is effect order: the sync interval, the members poll, then the
	// online/focus sync listeners, so shared visibility/online events fire them in that order.
	const sync = useOfflineAutoSync({
		shareCode: wg.shareCode,
		identity,
		accountReady,
		auth,
	});
	useMembersPolling(refreshMembers, Boolean(identity && accountReady));
	useSyncOnFocusAndOnline(sync, identity, accountReady);

	// Retry in place: the alert stays mounted while the request runs (keepCurrentContext keeps the
	// skeleton away), so the button can show its busy state instead of the page flashing.
	const [retrying, setRetrying] = useState(false);
	const retryingRef = useRef(false);
	const retryMemberLoad = useCallback(async () => {
		const userId = auth.current.userId;
		if (!userId) {
			window.location.reload();
			return;
		}
		if (retryingRef.current) return;
		retryingRef.current = true;
		setRetrying(true);
		try {
			await loadSessionMember(userId, auth.current.generation, true);
		} finally {
			retryingRef.current = false;
			setRetrying(false);
		}
	}, [loadSessionMember]);
	const online = useOnlineStatus();

	// The error heals itself once the connection is back or the app returns to the foreground.
	useEffect(() => {
		if (!memberLoadError) return;
		const offOnline = subscribeOnline(() => void retryMemberLoad());
		const offVisible = subscribeVisibility((visible) => {
			if (visible) void retryMemberLoad();
		});
		return () => {
			offOnline();
			offVisible();
		};
	}, [memberLoadError, retryMemberLoad]);

	// A server-verified session already carries the identity, so the shell and page render
	// in the SSR HTML; only the localStorage path has to wait for the mount effect.
	if (!memberLoaded || (!hydrated && !serverVerified)) {
		// Static skeleton shell instead of null: the SSR/first-paint output keeps
		// the document structure (<main> landmark, app background) while the
		// client hydrates. Fully static markup — no dynamic
		// values — so hydration cannot mismatch.
		return (
			<div className="min-h-svh bg-background" aria-busy="true">
				<main id="main" tabIndex={-1} className="focus:outline-none">
					<div
						className="mx-auto w-full max-w-[var(--app-frame-width)] px-4 pt-6"
						aria-label={t('loading')}
						role="status"
					>
						<Skeleton className="h-7 w-40 max-w-full" />
						<Skeleton className="mt-4 h-24 rounded-xl" />
						<Skeleton className="mt-4 h-24 rounded-xl" />
					</div>
				</main>
			</div>
		);
	}

	const backToWgs = <ShellLink href="/login">{t('backToWgs')}</ShellLink>;

	if (memberLoadError || retrying) {
		return (
			<ShellAlert
				title={t('notLoaded')}
				description={online ? t('loadFailed') : t('offlineWaiting')}
			>
				<Button
					type="button"
					variant="outline"
					size="lg"
					className="mt-3 w-full aria-disabled:opacity-50"
					aria-disabled={retrying}
					onClick={() => void retryMemberLoad()}
				>
					{retrying && <Spinner data-icon="inline-start" aria-hidden />}
					{retrying ? t('retrying') : t('retry')}
				</Button>
				{backToWgs}
			</ShellAlert>
		);
	}

	if (sessionEnded && !identity) {
		const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
		return (
			<ShellAlert title={t('sessionEnded')} description={t('sessionEndedBody')}>
				<ShellLink href={`/login?next=${next}`}>{t('signIn')}</ShellLink>
			</ShellAlert>
		);
	}

	if (!identity) {
		return (
			<ShellAlert title={t('noAccess')} description={t('noAccessBody')}>
				{backToWgs}
			</ShellAlert>
		);
	}

	return (
		<WgContext.Provider
			key={JSON.stringify([identity.authUserId ?? null, identity.memberId])}
			value={value}
		>
			{children}
		</WgContext.Provider>
	);
}

// No WG header or bottom nav around the shell alerts, so the status bar inset is theirs.
const STANDALONE_MAIN =
	'mx-auto max-w-md px-6 pb-6 pt-[calc(env(safe-area-inset-top,0px)+1.5rem)] focus:outline-none';

/** Full-page alert shown instead of the app when the WG shell cannot render its content. */
function ShellAlert({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<main id="main" tabIndex={-1} className={STANDALONE_MAIN}>
			<Alert variant="destructive">
				<AlertTitle>{title}</AlertTitle>
				<AlertDescription className="text-current">{description}</AlertDescription>
				{children}
			</Alert>
		</main>
	);
}

function ShellLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			href={href}
			className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'mt-3 w-full')}
		>
			{children}
		</a>
	);
}

export function useWg(): WgContextValue {
	const ctx = useContext(WgContext);
	if (!ctx) {
		throw new Error('useWg must be used inside <WgContextProvider> with a chosen identity');
	}
	return ctx;
}
