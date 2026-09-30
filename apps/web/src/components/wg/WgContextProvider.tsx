'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/core/infra/api-client';
import { captureException } from '@/core/infra/observability';
import { countOfflineActions, syncOfflineActions } from '@/core/offline/offline-client';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { cn } from '@/shared/lib/cn';
import { type StoredIdentity, getIdentity, rememberWg } from '@/shared/lib/identity';
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
}

const WgContext = createContext<WgContextValue | null>(null);

interface Props {
	wg: WgSummary;
	members: Member[];
	/** Server-seeded admin flag; the client refresh keeps it up to date. */
	viewerIsAdmin?: boolean | undefined;
	children: ReactNode;
}

/** Backoff for a failed members refresh: 5s, 10s, 20s, 40s … capped at 60s. */
const MEMBER_RETRY_BASE_MS = 5_000;
const MEMBER_RETRY_MAX_MS = 60_000;
// One 429/deploy blip must not blank the WG; repeated failures must not stay
// silent — after this many attempts the existing error screen takes over.
const MEMBER_RETRY_ATTEMPTS_BEFORE_ERROR = 3;

export function WgContextProvider({ wg, members: initialMembers, viewerIsAdmin, children }: Props) {
	const [members, setMembers] = useState<Member[]>(initialMembers);
	const [isAdmin, setIsAdmin] = useState(viewerIsAdmin ?? false);
	const [identity, setStateIdentity] = useState<StoredIdentity | null>(null);
	const [hydrated, setHydrated] = useState(false);
	const [memberLoaded, setMemberLoaded] = useState(false);
	const [memberLoadError, setMemberLoadError] = useState(false);
	// Consecutive failures of the members/admin refresh: `failed` keeps the
	// backoff timer armed, `attempts` picks the next step. A success resets it.
	const [membersRetry, setMembersRetry] = useState({ failed: false, attempts: 0 });
	const syncingRef = useRef(false);
	// True after the last members refresh succeeded; the focus/visibility
	// listeners use it to retry only while the roster or the admin flag is
	// still missing instead of adding an API call to every focus.
	const membersRefreshedRef = useRef(false);
	const encodedShareCode = encodeURIComponent(wg.shareCode);

	useEffect(() => {
		const storedIdentity = getIdentity(wg.id);
		// The database-free Playwright fixture has no Supabase session by design.
		// It only exists in CI and keeps its old local identity setup working.
		if (
			process.env.NEXT_PUBLIC_DB_DOWN === 'true' &&
			process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE === 'true' &&
			storedIdentity
		) {
			setStateIdentity(storedIdentity);
		}
		setHydrated(true);
		rememberWg({ code: wg.shareCode, name: wg.name, lastVisitedAt: Date.now() });
	}, [wg.id, wg.shareCode, wg.name]);

	useEffect(() => {
		let cancelled = false;
		const loadSessionMember = async () => {
			setMemberLoaded(false);
			setMemberLoadError(false);
			const res = await apiFetch<{
				currentMember?: { memberId: string; name: string; memberToken?: string };
			}>(`/api/wg/${encodedShareCode}`);
			if (cancelled) return;
			if (!res.ok) {
				setMemberLoadError(true);
			} else {
				const member = res.data.currentMember;
				if (member) {
					setStateIdentity({
						memberId: member.memberId,
						name: member.name,
						...(member.memberToken ? { memberToken: member.memberToken } : {}),
					});
				}
			}
			setMemberLoaded(true);
		};
		if (hydrated) void loadSessionMember();
		return () => {
			cancelled = true;
		};
	}, [hydrated, encodedShareCode]);

	const scheduleMembersRetry = useCallback(() => {
		membersRefreshedRef.current = false;
		// A new failure object re-arms the backoff timer below (new dependency
		// identity), and a rising attempt count picks the longer delay.
		setMembersRetry((current) => ({ failed: true, attempts: current.attempts + 1 }));
	}, []);

	const refreshMembers = useCallback(async () => {
		if (!identity) return;
		try {
			const res = await apiFetch<{
				members: Array<Member & { active?: boolean }>;
				viewerIsAdmin?: boolean;
			}>(`/api/wg/${encodedShareCode}/members`, {
				memberId: identity.memberId,
				memberToken: identity.memberToken,
			});
			// Normalize defensively: an omitted flag (e.g. E2E fixtures) means active.
			if (res.ok) {
				setMembers(res.data.members.map((m) => ({ ...m, active: m.active !== false })));
				setIsAdmin(res.data.viewerIsAdmin === true);
				membersRefreshedRef.current = true;
				setMembersRetry({ failed: false, attempts: 0 });
				setMemberLoadError(false);
			} else if (res.status === 401 && res.error === 'auth_required') {
				window.location.replace(
					`/neu?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
				);
			} else if (res.status === 401 && res.error === 'not_a_member') {
				setStateIdentity(null);
			} else {
				// 429/500/503/network: retry with backoff instead of leaving
				// `isAdmin` (and the roster) stuck at its initial value.
				scheduleMembersRetry();
			}
		} catch (err) {
			// apiFetch swallows network errors internally, so this only fires for
			// unexpected failures — log it and retry like any other non-auth one.
			captureException(err, { action: 'refreshMembers', shareCode: encodedShareCode });
			scheduleMembersRetry();
		}
	}, [encodedShareCode, identity, scheduleMembersRetry]);

	// Surface persistent refresh failures through the existing error screen —
	// but only after a few attempts, so a single 429/deploy blip does not
	// blank the WG. A later success clears it again (see refreshMembers).
	useEffect(() => {
		if (membersRetry.attempts >= MEMBER_RETRY_ATTEMPTS_BEFORE_ERROR) {
			setMemberLoadError(true);
		}
	}, [membersRetry.attempts]);

	// Backoff retry while a refresh keeps failing: every failure stores a new
	// `membersRetry`, which rebuilds this timer with the next, longer delay.
	// A successful attempt resets the state and cancels the pending timer.
	useEffect(() => {
		if (!identity || !membersRetry.failed) return;
		const exponent = Math.min(Math.max(membersRetry.attempts - 1, 0), 5);
		const delay = Math.min(MEMBER_RETRY_MAX_MS, MEMBER_RETRY_BASE_MS * 2 ** exponent);
		const timer = window.setTimeout(() => {
			void refreshMembers();
		}, delay);
		return () => window.clearTimeout(timer);
	}, [identity, membersRetry, refreshMembers]);

	const value = useMemo<WgContextValue | null>(() => {
		if (!identity) return null;
		return { wg, members, identity, refreshMembers, isAdmin };
	}, [wg, members, identity, refreshMembers, isAdmin]);

	useEffect(() => {
		if (!identity) return;
		void refreshMembers();
	}, [identity, refreshMembers]);

	const sync = useCallback(async () => {
		if (
			!identity ||
			syncingRef.current ||
			countOfflineActions(wg.shareCode, { memberId: identity.memberId }) === 0
		) {
			return;
		}
		syncingRef.current = true;
		try {
			await syncOfflineActions(wg.shareCode, { memberId: identity.memberId });
		} catch {
			// Automatic sync retries on the next app event or interval.
		} finally {
			syncingRef.current = false;
		}
	}, [identity, wg.shareCode]);

	// The interval doubles as the members/admin retry while a refresh has not
	// succeeded yet — a failed fetch then heals on the same cadence as the
	// offline queue instead of waiting for a hard reload.
	useVisibilityPausedInterval(
		() => {
			if (!membersRefreshedRef.current) void refreshMembers();
			void sync();
		},
		identity ? 60_000 : null,
	);

	// Sync on online/focus events in addition to the paused interval above.
	// These listeners are re-registered when `refreshMembers`/`sync` change
	// (which happens when identity or wg.shareCode change), so the cleanup
	// always removes the listeners bound to the current closure.
	useEffect(() => {
		if (!identity) return;
		void sync();
		const onAppEvent = () => {
			if (!membersRefreshedRef.current) void refreshMembers();
			void sync();
		};
		window.addEventListener('online', onAppEvent);
		window.addEventListener('focus', onAppEvent);
		return () => {
			window.removeEventListener('online', onAppEvent);
			window.removeEventListener('focus', onAppEvent);
		};
	}, [identity, refreshMembers, sync]);

	if (!hydrated || !memberLoaded) {
		// Static skeleton shell instead of null: the SSR/first-paint output keeps
		// the document structure (<main> landmark, app background) while the
		// identity is read from localStorage. Fully static markup — no dynamic
		// values — so hydration cannot mismatch.
		return (
			<div className="min-h-svh bg-background" aria-busy="true">
				<main id="main" tabIndex={-1} className="focus:outline-none">
					<div
						className="mx-auto w-full max-w-3xl px-4 pt-6"
						aria-label="Wird geladen"
						// biome-ignore lint/a11y/useSemanticElements: role="status" names the loading region without swapping the wrapper element to <output>.
						role="status"
					>
						<Skeleton className="h-7 w-40" />
						<Skeleton className="mt-4 h-24 rounded-xl" />
						<Skeleton className="mt-4 h-24 rounded-xl" />
					</div>
				</main>
			</div>
		);
	}

	if (memberLoadError) {
		return (
			<main id="main" tabIndex={-1} className="mx-auto max-w-md p-6">
				<Alert variant="destructive">
					<AlertDescription className="text-current">
						Deine WG konnte nicht geladen werden. Bitte versuche es erneut.
					</AlertDescription>
					<Button
						type="button"
						variant="outline"
						size="lg"
						className="mt-3"
						onClick={() => window.location.reload()}
					>
						Erneut versuchen
					</Button>
				</Alert>
			</main>
		);
	}

	if (!identity) {
		return (
			<main id="main" tabIndex={-1} className="mx-auto max-w-md p-6">
				<Alert variant="destructive">
					<AlertDescription className="text-current">
						Deine Mitgliedschaft konnte nicht bestätigt werden.
					</AlertDescription>
					<a
						href={`/neu?next=${encodeURIComponent(`/wg/${wg.shareCode}`)}`}
						className={cn(buttonVariants({ variant: 'link', size: 'lg' }), 'mt-2 px-0')}
					>
						Zurück zu deinen WGs
					</a>
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
