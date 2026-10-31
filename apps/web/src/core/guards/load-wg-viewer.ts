import 'server-only';

import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { cache } from 'react';
import { getAuthenticatedUserFromCookies } from '@/core/auth/server';
import { db, wgMembers, wgs } from '@/core/db';

/**
 * Session user plus the share code's WG, for server components.
 * `access` is null unless the user is an active member of that WG, so a page
 * that answers `notFound()` on a null `access` reveals nothing about codes the
 * visitor does not belong to. Memoized per request: the session check is a
 * network call to Supabase Auth.
 *
 * `code` must already be normalized and validated.
 */
export const loadWgViewer = cache(async (code: string) => {
	const user = await getAuthenticatedUserFromCookies();
	if (!user) return null;
	const [access] = await db
		.select({
			id: wgs.id,
			name: wgs.name,
			shareCode: wgs.shareCode,
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
	return { user, access: access ?? null };
});

/** One roster entry as the WG shell shows it; deactivated members stay for history and balances. */
interface RosterRow {
	id: string;
	name: string;
	color: string | null;
	active: boolean;
	isAdmin: boolean;
	hasAccount: boolean;
}

/**
 * What the WG layout needs on top of `loadWgViewer`: whether a viewer without access has moved
 * out of the WG, and (with access) the full roster and the viewer's admin flag. The moved-out
 * lookup runs only when access is null. Memoized per request.
 */
export const loadWgShell = cache(async (code: string) => {
	const viewer = await loadWgViewer(code);
	if (!viewer) return null;
	const { user, access } = viewer;
	if (!access) {
		const [movedOut] = await db
			.select({ id: wgMembers.id })
			.from(wgMembers)
			.innerJoin(wgs, eq(wgMembers.wgId, wgs.id))
			.where(
				and(
					eq(wgs.shareCode, code),
					eq(wgMembers.authUserId, user.id),
					isNotNull(wgMembers.deactivatedAt),
				),
			)
			.limit(1);
		return { user, access, movedOut: Boolean(movedOut), members: [], initialIsAdmin: false };
	}

	// The full roster including deactivated members: history and balances need every name.
	// NULL deactivated_at means active.
	const rows = await db
		.select({
			id: wgMembers.id,
			name: wgMembers.name,
			color: wgMembers.color,
			role: wgMembers.role,
			authUserId: wgMembers.authUserId,
			deactivatedAt: wgMembers.deactivatedAt,
		})
		.from(wgMembers)
		.where(eq(wgMembers.wgId, access.id))
		// The roster order feeds every member list; without it a row update reshuffles them.
		.orderBy(asc(wgMembers.createdAt), asc(wgMembers.id));
	// Same rule as isWgAdmin: the first active admin row.
	const initialIsAdmin =
		rows.find((row) => row.role === 'admin' && row.deactivatedAt === null)?.id === access.memberId;
	const members: RosterRow[] = rows.map(({ deactivatedAt, role, authUserId, ...member }) => ({
		...member,
		active: deactivatedAt === null,
		isAdmin: role === 'admin' && deactivatedAt === null,
		hasAccount: authUserId !== null,
	}));
	return { user, access, movedOut: false, members, initialIsAdmin };
});
