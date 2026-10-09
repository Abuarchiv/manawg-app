'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import type { StoredIdentity } from '@/core/auth/identity';
import {
	subscribeOnline,
	subscribeVisibility,
	useOnlineStatus,
} from '@/core/hooks/use-online-status';
import { cn } from '@/shared/lib/cn';
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import type { ReactNode } from 'react';
import { useMembersPolling, useMembersRefresh } from './use-members-refresh';
import { useMembershipLost } from './use-membership-lost';
import { useOfflineAutoSync, useSyncOnFocusAndOnline } from './use-offline-auto-sync';
import { useSessionMember } from './use-session-member';

export interface WgSummary {
	id: string;
	name: string;
	shareCode: string;
	joiningEnabled: boolean;
	shareCodeRotatedAt?: string | Date | null;
}

export interface Member {
	id: string;
	name: string;
	color?: string | null;
	paypalMerchantId?: string | null;
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
	identity: StoredIdentity;
	refreshMembers: (memberId?: string) => Promise<void>;
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
	initialIdentity?: StoredIdentity | undefined;
	/** Server-verified admin flag; only meaningful together with initialIdentity.authUserId. */
	initialIsAdmin?: boolean | undefined;
	/**
	 * The WG is served without any Supabase session; the identity comes from
	 * the locally stored member (database-free test builds only).
	 */
	sessionless?: boolean | undefined;
	children: ReactNode;
}

export function WgContextProvider({
	wg,
	members: initialMembers,
	initialIdentity,
	initialIsAdmin,
	sessionless = false,
	children,
}: Props) {
	// The WG layout resolved the Supabase session and membership on the server
	// (authUserId is only set there). Start ready instead of waiting for
	// getSession -> /api/wg/[code]; the auth listener still revalidates in the
	// background and clears everything on sign-out.
	const serverVerified = Boolean(initialIdentity?.authUserId);
	const [members, setMembers] = useState<Member[]>(initialMembers);
	const [isAdmin, setIsAdmin] = useState(serverVerified && initialIsAdmin === true);
	const [identity, setStateIdentity] = useState<StoredIdentity | null>(initialIdentity ?? null);
	const [accountReady, setAccountReady] = useState(serverVerified);
	const [memberLoaded, setMemberLoaded] = useState(serverVerified);
	const syncAbortRef = useRef<AbortController | null>(null);
	const authUserIdRef = useRef<string | null>(initialIdentity?.authUserId ?? null);
	const authGenerationRef = useRef(0);
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const identitySetters = { setStateIdentity, setIsAdmin, setAccountReady, setMemberLoaded };

	const { hydrated, memberLoadError, loadSessionMember } = useSessionMember({
		wg,
		initialIdentity,
		sessionless,
		encodedShareCode,
		authGenerationRef,
		authUserIdRef,
		syncAbortRef,
		...identitySetters,
	});

	useMembershipLost({
		wgId: wg.id,
		encodedShareCode,
		authGenerationRef,
		syncAbortRef,
		...identitySetters,
	});

	const refreshMembers = useMembersRefresh({
		wgId: wg.id,
		encodedShareCode,
		identity,
		accountReady,
		serverVerified,
		authGenerationRef,
		authUserIdRef,
		loadSessionMember,
		setMembers,
		setIsAdmin,
		setStateIdentity,
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
		syncAbortRef,
	});
	useMembersPolling(refreshMembers, Boolean(identity && accountReady));
	useSyncOnFocusAndOnline(sync, identity, accountReady);

	// Retry in place: the alert stays mounted while the request runs (keepCurrentContext keeps the
	// skeleton away), so the button can show its busy state instead of the page flashing.
	const [retrying, setRetrying] = useState(false);
	const retryingRef = useRef(false);
	const retryMemberLoad = useCallback(async () => {
		const userId = authUserIdRef.current;
		if (!userId) {
			window.location.reload();
			return;
		}
		if (retryingRef.current) return;
		retryingRef.current = true;
		setRetrying(true);
		try {
			await loadSessionMember(userId, authGenerationRef.current, true);
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
						aria-label="Wird geladen"
						// biome-ignore lint/a11y/useSemanticElements: role="status" names the loading region without swapping the wrapper element to <output>.
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

	const backToWgs = (
		<a
			href={`/neu?next=${encodeURIComponent(`/wg/${wg.shareCode}`)}`}
			className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'mt-3 w-full')}
		>
			Zurück zu deinen WGs
		</a>
	);

	// No WG header or bottom nav around these two screens, so the status bar inset is theirs.
	const standaloneMain =
		'mx-auto max-w-md px-6 pb-6 pt-[calc(env(safe-area-inset-top,0px)+1.5rem)] focus:outline-none';

	if (memberLoadError || retrying) {
		return (
			<main id="main" tabIndex={-1} className={standaloneMain}>
				<Alert variant="destructive">
					<AlertTitle>WG nicht geladen</AlertTitle>
					<AlertDescription className="text-current">
						{online
							? 'Deine WG konnte nicht geladen werden. Bitte versuche es erneut.'
							: 'Du bist offline. Sobald die Verbindung zurück ist, lädt deine WG von selbst.'}
					</AlertDescription>
					<Button
						type="button"
						variant="outline"
						size="lg"
						className="mt-3 w-full aria-disabled:opacity-50"
						aria-disabled={retrying}
						onClick={() => void retryMemberLoad()}
					>
						{retrying && <Spinner data-icon="inline-start" aria-hidden />}
						{retrying ? 'Lädt…' : 'Erneut versuchen'}
					</Button>
					{backToWgs}
				</Alert>
			</main>
		);
	}

	if (!identity) {
		return (
			<main id="main" tabIndex={-1} className={standaloneMain}>
				<Alert variant="destructive">
					<AlertTitle>Kein Zugriff</AlertTitle>
					<AlertDescription className="text-current">
						Du bist in dieser WG nicht (mehr) Mitglied, z. B. weil du ausgezogen bist oder entfernt
						wurdest.
					</AlertDescription>
					{backToWgs}
				</Alert>
			</main>
		);
	}

	return <WgContext.Provider value={value}>{children}</WgContext.Provider>;
}

export function useWg(): WgContextValue {
	const ctx = useContext(WgContext);
	if (!ctx) {
		throw new Error('useWg must be used inside <WgContextProvider> with a chosen identity');
	}
	return ctx;
}
