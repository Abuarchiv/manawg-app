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
	children: ReactNode;
}

export function WgContextProvider({ wg, members: initialMembers, children }: Props) {
	const [members, setMembers] = useState<Member[]>(initialMembers);
	const [isAdmin, setIsAdmin] = useState(false);
	const [identity, setStateIdentity] = useState<StoredIdentity | null>(null);
	const [hydrated, setHydrated] = useState(false);
	const [memberLoaded, setMemberLoaded] = useState(false);
	const [memberLoadError, setMemberLoadError] = useState(false);
	const syncingRef = useRef(false);
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
			} else if (res.status === 401 && res.error === 'auth_required') {
				window.location.replace(
					`/neu?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
				);
			} else if (res.status === 401 && res.error === 'not_a_member') {
				setStateIdentity(null);
			}
		} catch (err) {
			// Network blip — the paused interval/focus listener retries. Log it
			// so silently stale member lists stay diagnosable instead of
			// vanishing into an empty catch block.
			captureException(err, { action: 'refreshMembers', shareCode: encodedShareCode });
		}
	}, [encodedShareCode, identity]);

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

	useVisibilityPausedInterval(() => void sync(), identity ? 60_000 : null);

	// Sync on online/focus events in addition to the paused interval above.
	// These listeners are re-registered when `sync` changes (which happens when
	// identity or wg.shareCode change), so the cleanup always removes the
	// listeners bound to the current closure.
	useEffect(() => {
		if (!identity) return;
		void sync();
		window.addEventListener('online', sync);
		window.addEventListener('focus', sync);
		return () => {
			window.removeEventListener('online', sync);
			window.removeEventListener('focus', sync);
		};
	}, [identity, sync]);

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
