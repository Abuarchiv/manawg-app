import { expect, test } from '@playwright/test';

const accountDeleteTestUrl = process.env.ACCOUNT_DELETE_TEST_URL?.trim() ?? '';
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
const accountDeleteDatabaseUrl = accountDeleteTestUrl ? new URL(accountDeleteTestUrl) : undefined;
if (accountDeleteDatabaseUrl) {
	const databaseUrl = accountDeleteDatabaseUrl;
	const hostname = databaseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (
		!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
		!loopbackHosts.has(hostname) ||
		!databaseUrl.port ||
		!databaseUrl.username ||
		databaseUrl.search !== '' ||
		databaseUrl.hash !== ''
	) {
		throw new Error(
			'ACCOUNT_DELETE_TEST_URL must include a loopback host and explicit port, without query or fragment overrides.',
		);
	}
	process.env.ACCOUNT_DELETE_TEST_URL = accountDeleteTestUrl;
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('PG')) Reflect.deleteProperty(process.env, key);
	}
	for (const key of [
		'POSTGRES_URL',
		'DATABASE_URL',
		'POSTGRES_URL_NON_POOLING',
		'DATABASE_URL_UNPOOLED',
	]) {
		process.env[key] = accountDeleteTestUrl;
	}
}

const deletionFixtureIds = new Set<string>();

test.beforeAll(async () => {
	if (!accountDeleteTestUrl || !accountDeleteDatabaseUrl) return;

	const { Client } = await import('pg');
	const client = new Client({ connectionString: accountDeleteTestUrl });
	const { host, port, database, user } = client.connectionParameters;
	const actualHost = String(host)
		.toLowerCase()
		.replace(/^\[|\]$/g, '');
	const expectedHost = accountDeleteDatabaseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	const expectedDatabase = decodeURIComponent(accountDeleteDatabaseUrl.pathname.slice(1));
	const expectedUser = decodeURIComponent(accountDeleteDatabaseUrl.username);
	if (
		!loopbackHosts.has(actualHost) ||
		actualHost !== expectedHost ||
		Number(port) !== Number(accountDeleteDatabaseUrl.port) ||
		database !== expectedDatabase ||
		user !== expectedUser
	) {
		throw new Error(
			'Resolved account-delete PostgreSQL connection is not the validated loopback target.',
		);
	}
});

function trackDeletionFixture(authUserId: string): void {
	deletionFixtureIds.add(authUserId);
}

test.afterEach(async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	if (!url || deletionFixtureIds.size === 0) return;
	const { Client } = await import('pg');
	const client = new Client({ connectionString: url });
	await client.connect();
	try {
		await client.query('DELETE FROM account_deletions WHERE auth_user_id = ANY($1::uuid[])', [
			[...deletionFixtureIds],
		]);
	} finally {
		deletionFixtureIds.clear();
		await client.end();
	}
});

// Runs against a throwaway Postgres with the repo migrations applied:
// ACCOUNT_DELETE_TEST_URL=postgresql://postgres@127.0.0.1:55432/manawg_test
test('account deletion hands over admin, moves out, and deletes solo WGs', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at a disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { withTransaction } = await import('../src/core/db/transaction');
	const { removeAccountFromWgs } = await import('../src/core/db/delete-account');
	const { expenses, wgMembers, wgs } = await import('../src/core/db/schema');
	const { eq, inArray } = await import('drizzle-orm');

	const user = crypto.randomUUID();
	trackDeletionFixture(user);
	const flatmate = crypto.randomUUID();
	const code = () => crypto.randomUUID().slice(0, 8).toUpperCase();

	const ids = await withTransaction(async (tx) => {
		const [shared, solo] = await tx
			.insert(wgs)
			.values([
				{ shareCode: code(), name: 'Shared' },
				{ shareCode: code(), name: 'Solo' },
			])
			.returning({ id: wgs.id });
		const [me, guest, mate] = await tx
			.insert(wgMembers)
			.values([
				{ wgId: shared.id, name: 'Me', role: 'admin', authUserId: user },
				{ wgId: shared.id, name: 'Guest', role: 'member' },
				{ wgId: shared.id, name: 'Mate', role: 'member', authUserId: flatmate },
			])
			.returning({ id: wgMembers.id });
		const [soloMe] = await tx
			.insert(wgMembers)
			.values({ wgId: solo.id, name: 'Me', role: 'admin', authUserId: user })
			.returning({ id: wgMembers.id });
		await tx.insert(expenses).values([
			{ wgId: shared.id, paidByMemberId: me.id, amountCents: 1000, description: 'Kept' },
			{ wgId: solo.id, paidByMemberId: soloMe.id, amountCents: 500, description: 'Gone' },
		]);
		return { shared: shared.id, solo: solo.id, me: me.id, guest: guest.id, mate: mate.id };
	});

	const result = await withTransaction((tx) => removeAccountFromWgs(tx, user));
	expect(result.deletedWgIds).toEqual([ids.solo]);
	expect(result.left).toEqual([
		{ wgId: ids.shared, memberId: ids.me, name: 'Me', newAdminId: ids.mate },
	]);

	await withTransaction(async (tx) => {
		const members = await tx
			.select()
			.from(wgMembers)
			.where(inArray(wgMembers.wgId, [ids.shared, ids.solo]));
		const byId = new Map(members.map((m) => [m.id, m]));
		expect(byId.get(ids.me)).toMatchObject({ authUserId: null, role: 'member' });
		expect(byId.get(ids.me)?.deactivatedAt).not.toBeNull();
		expect(byId.get(ids.mate)?.role).toBe('admin');
		expect(byId.get(ids.guest)?.role).toBe('member');
		expect(members.filter((m) => m.wgId === ids.solo)).toHaveLength(0);
		expect(await tx.select().from(wgs).where(eq(wgs.id, ids.solo))).toHaveLength(0);
		expect(await tx.select().from(expenses).where(eq(expenses.wgId, ids.shared))).toHaveLength(1);
	});

	// A retry after a failed auth-provider call finds nothing left to detach.
	expect(await withTransaction((tx) => removeAccountFromWgs(tx, user))).toEqual({
		left: [],
		deletedWgIds: [],
	});
});

test('account deletion keeps a durable fence and revokes only the departing member credentials', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';

	const { Pool } = await import('pg');
	const { withTransaction } = await import('../src/core/db/transaction');
	const { removeAccountFromWgs } = await import('../src/core/db/delete-account');
	const { calendarSubscriptions, pushSubscriptions, wgMembers, wgs } = await import(
		'../src/core/db/schema'
	);
	const { eq } = await import('drizzle-orm');

	const user = crypto.randomUUID();
	trackDeletionFixture(user);
	const otherUser = crypto.randomUUID();
	const ids = await withTransaction(async (tx) => {
		const [wg] = await tx
			.insert(wgs)
			.values({
				shareCode: crypto.randomUUID().slice(0, 8).toUpperCase(),
				name: 'Credential fence',
			})
			.returning({ id: wgs.id });
		const [departing, other] = await tx
			.insert(wgMembers)
			.values([
				{ wgId: wg.id, name: 'Departing', role: 'admin', authUserId: user, pushOptIn: true },
				{ wgId: wg.id, name: 'Staying', role: 'member', authUserId: otherUser, pushOptIn: true },
			])
			.returning({ id: wgMembers.id });
		await tx.insert(calendarSubscriptions).values([
			{ wgId: wg.id, memberId: departing.id, tokenSeed: crypto.randomUUID() },
			{ wgId: wg.id, memberId: other.id, tokenSeed: crypto.randomUUID() },
		]);
		await tx.insert(pushSubscriptions).values([
			{
				memberId: departing.id,
				endpoint: `https://push.example/${crypto.randomUUID()}`,
				p256dh: 'test-key',
				authKey: 'test-key',
			},
			{
				memberId: other.id,
				endpoint: `https://push.example/${crypto.randomUUID()}`,
				p256dh: 'test-key',
				authKey: 'test-key',
			},
		]);
		return { wgId: wg.id, departingId: departing.id, otherId: other.id };
	});

	await withTransaction((tx) => removeAccountFromWgs(tx, user));

	const pool = new Pool({ connectionString: url });
	try {
		const { rows: deletions } = await pool.query(
			' SELECT auth_user_id, requested_at, completed_at FROM account_deletions WHERE auth_user_id = $1',
			[user],
		);
		expect(deletions).toHaveLength(1);
		expect(deletions[0]).toMatchObject({ auth_user_id: user, completed_at: null });
		expect(deletions[0].requested_at).toBeTruthy();

		const { rows: calendars } = await pool.query(
			' SELECT member_id FROM calendar_subscriptions WHERE wg_id = $1 ORDER BY member_id',
			[ids.wgId],
		);
		expect(calendars.map((row) => row.member_id)).toEqual([ids.otherId]);
		const { rows: pushes } = await pool.query(
			' SELECT member_id FROM push_subscriptions WHERE member_id IN ($1, $2) ORDER BY member_id',
			[ids.departingId, ids.otherId],
		);
		expect(pushes.map((row) => row.member_id)).toEqual([ids.otherId]);
	} finally {
		await pool.end();
	}

	await withTransaction(async (tx) => {
		const members = await tx
			.select({
				id: wgMembers.id,
				authUserId: wgMembers.authUserId,
				pushOptIn: wgMembers.pushOptIn,
			})
			.from(wgMembers)
			.where(eq(wgMembers.wgId, ids.wgId));
		expect(members.find((member) => member.id === ids.departingId)).toMatchObject({
			authUserId: null,
			pushOptIn: false,
		});
		expect(members.find((member) => member.id === ids.otherId)?.authUserId).toBe(otherUser);
	});
});

test('account deletion fence is private to anonymous and authenticated Data API roles', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	const { Client } = await import('pg');
	const client = new Client({ connectionString: url });
	await client.connect();
	try {
		const { rows: roles } = await client.query(
			"SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')",
		);
		if (roles.length !== 2)
			test.skip(true, 'Requires anon and authenticated roles in disposable database.');
		const { rows } = await client.query(`
			SELECT c.relrowsecurity AS rls,
				has_table_privilege('anon', 'public.account_deletions', 'SELECT') AS anon_select,
				has_table_privilege('anon', 'public.account_deletions', 'INSERT') AS anon_insert,
				has_table_privilege('anon', 'public.account_deletions', 'UPDATE') AS anon_update,
				has_table_privilege('anon', 'public.account_deletions', 'DELETE') AS anon_delete,
				has_table_privilege('authenticated', 'public.account_deletions', 'SELECT') AS authenticated_select,
				has_table_privilege('authenticated', 'public.account_deletions', 'INSERT') AS authenticated_insert,
				has_table_privilege('authenticated', 'public.account_deletions', 'UPDATE') AS authenticated_update,
				has_table_privilege('authenticated', 'public.account_deletions', 'DELETE') AS authenticated_delete
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relname = 'account_deletions'
		`);
		expect(rows).toEqual([
			{
				rls: true,
				anon_select: false,
				anon_insert: false,
				anon_update: false,
				anon_delete: false,
				authenticated_select: false,
				authenticated_insert: false,
				authenticated_update: false,
				authenticated_delete: false,
			},
		]);
	} finally {
		await client.end();
	}
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((ready) => {
		resolve = ready;
	});
	return { promise, resolve };
}

async function waitForBlockedQuery(client: import('pg').Client, applicationName: string) {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const { rows } = await client.query(
			' SELECT cardinality(pg_blocking_pids(pid)) > 0 AS blocked FROM pg_stat_activity WHERE application_name = $1',
			[applicationName],
		);
		if (rows[0]?.blocked) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
}

test('a fresh deletion status read waits for the account fence transaction', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { Client } = await import('pg');
	const { accountDeletions } = await import('../src/core/db/schema');
	const { lockAccount, readAccountDeletionStatusWithFreshConnection } = await import(
		'../src/core/db/account-deletion'
	);
	const { withTransaction } = await import('../src/core/db/transaction');
	const { sql } = await import('drizzle-orm');
	const authUserId = crypto.randomUUID();
	trackDeletionFixture(authUserId);
	const observer = new Client({ connectionString: url });
	await observer.connect();
	const deletionReady = deferred();
	const releaseDeletion = deferred();
	const deletion = withTransaction(async (tx) => {
		await tx.execute(
			sql`select set_config('application_name', ${`fence-${crypto.randomUUID()}`}, true)`,
		);
		await lockAccount(tx, authUserId);
		await tx.insert(accountDeletions).values({ authUserId });
		deletionReady.resolve();
		await releaseDeletion.promise;
	});
	let status: Awaited<ReturnType<typeof readAccountDeletionStatusWithFreshConnection>> | undefined;
	let statusError: unknown;
	let statusRead: Promise<void> | undefined;
	let statusReadBlocked = false;
	try {
		await deletionReady.promise;
		statusRead = readAccountDeletionStatusWithFreshConnection(authUserId).then(
			(value) => {
				status = value;
			},
			(error: unknown) => {
				statusError = error;
			},
		);
		statusReadBlocked = await waitForBlockedQuery(observer, 'manawg-account-deletion-status-check');
	} finally {
		releaseDeletion.resolve();
		try {
			await deletion;
			await statusRead;
		} finally {
			await observer.end();
		}
	}
	expect(statusReadBlocked).toBe(true);
	expect(statusError).toBeUndefined();
	expect(status).toEqual({ completedAt: null });
});

test('a committed deletion fence blocks a stale authenticated membership acquisition', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { Client } = await import('pg');
	const { accountDeletions } = await import('../src/core/db/schema');
	const { assertAccountCanAcquireMembership, lockAccount } = await import(
		'../src/core/db/account-deletion'
	);
	const { withTransaction } = await import('../src/core/db/transaction');
	const { sql } = await import('drizzle-orm');
	const user = crypto.randomUUID();
	trackDeletionFixture(user);
	const deletionApp = `delete-${crypto.randomUUID()}`;
	const acquireApp = `acquire-${crypto.randomUUID()}`;
	const observer = new Client({ connectionString: url });
	await observer.connect();
	const deletionReady = deferred();
	const releaseDeletion = deferred();
	const deletion = withTransaction(async (tx) => {
		await tx.execute(sql`select set_config('application_name', ${deletionApp}, true)`);
		await lockAccount(tx, user);
		await tx.insert(accountDeletions).values({ authUserId: user });
		deletionReady.resolve();
		await releaseDeletion.promise;
	});
	let acquisition: Promise<{ allowed: true } | { allowed: false; error: unknown }> | undefined;
	try {
		await deletionReady.promise;
		const acquisitionStarted = deferred();
		acquisition = withTransaction(async (tx) => {
			await tx.execute(sql`select set_config('application_name', ${acquireApp}, true)`);
			acquisitionStarted.resolve();
			await assertAccountCanAcquireMembership(tx, user);
		}).then(
			() => ({ allowed: true as const }),
			(error: unknown) => ({ allowed: false as const, error }),
		);
		await acquisitionStarted.promise;
		expect(await waitForBlockedQuery(observer, acquireApp)).toBe(true);
	} finally {
		releaseDeletion.resolve();
		try {
			await deletion;
		} finally {
			await observer.end();
		}
	}
	expect(acquisition).toBeDefined();
	if (!acquisition) return;
	expect(await acquisition).toMatchObject({
		allowed: false,
		error: { name: 'TransactionAbort', code: 'account_deletion_pending' },
	});
});

test('deletion includes a membership whose join transaction commits first', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { Client } = await import('pg');
	const { removeAccountFromWgs } = await import('../src/core/db/delete-account');
	const { assertAccountCanAcquireMembership } = await import('../src/core/db/account-deletion');
	const { withTransaction } = await import('../src/core/db/transaction');
	const { eq, sql } = await import('drizzle-orm');
	const { wgMembers, wgs } = await import('../src/core/db/schema');
	const user = crypto.randomUUID();
	trackDeletionFixture(user);
	const otherUser = crypto.randomUUID();
	const [wg, other] = await withTransaction(async (tx) => {
		const [created] = await tx
			.insert(wgs)
			.values({ shareCode: crypto.randomUUID().slice(0, 8).toUpperCase(), name: 'Join race' })
			.returning({ id: wgs.id });
		const [member] = await tx
			.insert(wgMembers)
			.values({ wgId: created.id, name: 'Staying', role: 'admin', authUserId: otherUser })
			.returning({ id: wgMembers.id });
		return [created, member];
	});
	const joinApp = `join-${crypto.randomUUID()}`;
	const deleteApp = `delete-${crypto.randomUUID()}`;
	const observer = new Client({ connectionString: url });
	await observer.connect();
	const joinReady = deferred();
	const releaseJoin = deferred();
	let joinerId = '';
	const join = withTransaction(async (tx) => {
		await tx.execute(sql`select set_config('application_name', ${joinApp}, true)`);
		await assertAccountCanAcquireMembership(tx, user);
		await tx.select({ id: wgs.id }).from(wgs).where(eq(wgs.id, wg.id)).for('update');
		const [joiner] = await tx
			.insert(wgMembers)
			.values({ wgId: wg.id, name: 'Joined first', role: 'member', authUserId: user })
			.returning({ id: wgMembers.id });
		joinerId = joiner.id;
		joinReady.resolve();
		await releaseJoin.promise;
	});
	let deletion: Promise<{ left: Array<{ memberId: string }>; deletedWgIds: string[] }> | undefined;
	try {
		await joinReady.promise;
		const deletionStarted = deferred();
		deletion = withTransaction(async (tx) => {
			await tx.execute(sql`select set_config('application_name', ${deleteApp}, true)`);
			deletionStarted.resolve();
			return removeAccountFromWgs(tx, user);
		});
		await deletionStarted.promise;
		expect(await waitForBlockedQuery(observer, deleteApp)).toBe(true);
	} finally {
		releaseJoin.resolve();
		try {
			await join;
		} finally {
			await observer.end();
		}
	}
	const result = await deletion;
	expect(result?.left).toHaveLength(1);
	expect(result?.deletedWgIds).toHaveLength(0);
	await withTransaction(async (tx) => {
		const members = await tx.select().from(wgMembers).where(eq(wgMembers.wgId, wg.id));
		expect(members.find((member) => member.id === joinerId)).toMatchObject({
			authUserId: null,
			role: 'member',
		});
		expect(members.find((member) => member.id === other.id)?.authUserId).toBe(otherUser);
	});
});

test('an unrelated account joining a solo WG before deletion becomes the successor admin', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { Client } = await import('pg');
	const { removeAccountFromWgs } = await import('../src/core/db/delete-account');
	const { assertAccountCanAcquireMembership } = await import('../src/core/db/account-deletion');
	const { withTransaction } = await import('../src/core/db/transaction');
	const { eq, sql } = await import('drizzle-orm');
	const { wgMembers, wgs } = await import('../src/core/db/schema');
	const deletingUser = crypto.randomUUID();
	trackDeletionFixture(deletingUser);
	const joiningUser = crypto.randomUUID();
	const [wg, departing] = await withTransaction(async (tx) => {
		const [created] = await tx
			.insert(wgs)
			.values({ shareCode: crypto.randomUUID().slice(0, 8).toUpperCase(), name: 'Solo WG race' })
			.returning({ id: wgs.id });
		const [member] = await tx
			.insert(wgMembers)
			.values({
				wgId: created.id,
				name: 'Departing admin',
				role: 'admin',
				authUserId: deletingUser,
			})
			.returning({ id: wgMembers.id });
		return [created, member] as const;
	});
	const joinApp = `join-${crypto.randomUUID()}`;
	const deleteApp = `delete-${crypto.randomUUID()}`;
	const observer = new Client({ connectionString: url });
	await observer.connect();
	const joinReady = deferred();
	const releaseJoin = deferred();
	let joinedId = '';
	const join = withTransaction(async (tx) => {
		await tx.execute(sql`select set_config('application_name', ${joinApp}, true)`);
		await assertAccountCanAcquireMembership(tx, joiningUser);
		await tx.select({ id: wgs.id }).from(wgs).where(eq(wgs.id, wg.id)).for('update');
		const [joined] = await tx
			.insert(wgMembers)
			.values({ wgId: wg.id, name: 'Joining account', role: 'member', authUserId: joiningUser })
			.returning({ id: wgMembers.id });
		joinedId = joined.id;
		joinReady.resolve();
		await releaseJoin.promise;
	});
	let deletion:
		| Promise<{
				left: Array<{ memberId: string; newAdminId: string | null }>;
				deletedWgIds: string[];
		  }>
		| undefined;
	let deletionBlockedOnJoin = false;
	try {
		await joinReady.promise;
		const deletionStarted = deferred();
		deletion = withTransaction(async (tx) => {
			await tx.execute(sql`select set_config('application_name', ${deleteApp}, true)`);
			deletionStarted.resolve();
			return removeAccountFromWgs(tx, deletingUser);
		});
		await deletionStarted.promise;
		deletionBlockedOnJoin = await waitForBlockedQuery(observer, deleteApp);
	} finally {
		releaseJoin.resolve();
		try {
			await join;
		} finally {
			await observer.end();
		}
	}
	expect(deletionBlockedOnJoin).toBe(true);
	expect(deletion).toBeDefined();
	if (!deletion) return;
	const result = await deletion;
	expect(result.left).toHaveLength(1);
	expect(result.left[0]).toMatchObject({ memberId: departing.id, newAdminId: joinedId });
	expect(result.deletedWgIds).toHaveLength(0);
	await withTransaction(async (tx) => {
		const members = await tx.select().from(wgMembers).where(eq(wgMembers.wgId, wg.id));
		expect(members.find((member) => member.id === departing.id)?.deactivatedAt).toBeInstanceOf(
			Date,
		);
		expect(members.find((member) => member.id === departing.id)?.authUserId).toBeNull();
		expect(members.find((member) => member.id === joinedId)).toMatchObject({
			authUserId: joiningUser,
			role: 'admin',
			deactivatedAt: null,
		});
	});
});

test('admin deletion chooses a fallback after its pending successor moves out', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { Client } = await import('pg');
	const { lockActiveAccountMember } = await import('../src/core/db/account-deletion');
	const { removeAccountFromWgs } = await import('../src/core/db/delete-account');
	const { withTransaction } = await import('../src/core/db/transaction');
	const { eq, sql } = await import('drizzle-orm');
	const { wgMembers, wgs } = await import('../src/core/db/schema');
	const deletingUser = crypto.randomUUID();
	trackDeletionFixture(deletingUser);
	const leavingUser = crypto.randomUUID();
	const fallbackUser = crypto.randomUUID();
	const [wg, departing, pendingSuccessor, fallback] = await withTransaction(async (tx) => {
		const [created] = await tx
			.insert(wgs)
			.values({
				shareCode: crypto.randomUUID().slice(0, 8).toUpperCase(),
				name: 'Successor exit race',
			})
			.returning({ id: wgs.id });
		const [admin, successor, remaining] = await tx
			.insert(wgMembers)
			.values([
				{ wgId: created.id, name: 'Departing admin', role: 'admin', authUserId: deletingUser },
				{
					wgId: created.id,
					name: 'Pending successor',
					role: 'member',
					authUserId: leavingUser,
					createdAt: new Date('2025-01-01T00:00:00.000Z'),
				},
				{
					wgId: created.id,
					name: 'Fallback successor',
					role: 'member',
					authUserId: fallbackUser,
					createdAt: new Date('2025-01-02T00:00:00.000Z'),
				},
			])
			.returning({ id: wgMembers.id });
		return [created, admin, successor, remaining] as const;
	});
	const leaveApp = `leave-${crypto.randomUUID()}`;
	const deleteApp = `delete-${crypto.randomUUID()}`;
	const observer = new Client({ connectionString: url });
	await observer.connect();
	const leaveReady = deferred();
	const releaseLeave = deferred();
	const leave = withTransaction(async (tx) => {
		await tx.execute(sql`select set_config('application_name', ${leaveApp}, true)`);
		const actor = await lockActiveAccountMember(tx, wg.id, pendingSuccessor.id, leavingUser);
		expect(actor).not.toBeNull();
		const [member] = await tx
			.select({ id: wgMembers.id, deactivatedAt: wgMembers.deactivatedAt })
			.from(wgMembers)
			.where(eq(wgMembers.id, pendingSuccessor.id))
			.for('update');
		expect(member?.deactivatedAt).toBeNull();
		await tx
			.update(wgMembers)
			.set({ deactivatedAt: new Date() })
			.where(eq(wgMembers.id, pendingSuccessor.id));
		leaveReady.resolve();
		await releaseLeave.promise;
	});
	let deletion:
		| Promise<{
				left: Array<{ memberId: string; newAdminId: string | null }>;
				deletedWgIds: string[];
		  }>
		| undefined;
	let deletionBlockedOnLeave = false;
	try {
		await leaveReady.promise;
		const deletionStarted = deferred();
		deletion = withTransaction(async (tx) => {
			await tx.execute(sql`select set_config('application_name', ${deleteApp}, true)`);
			deletionStarted.resolve();
			return removeAccountFromWgs(tx, deletingUser);
		});
		await deletionStarted.promise;
		deletionBlockedOnLeave = await waitForBlockedQuery(observer, deleteApp);
	} finally {
		releaseLeave.resolve();
		try {
			await leave;
		} finally {
			await observer.end();
		}
	}
	expect(deletionBlockedOnLeave).toBe(true);
	expect(deletion).toBeDefined();
	if (!deletion) return;
	const result = await deletion;
	expect(result.left).toHaveLength(1);
	expect(result.left[0]).toMatchObject({ memberId: departing.id, newAdminId: fallback.id });
	expect(result.deletedWgIds).toHaveLength(0);
	await withTransaction(async (tx) => {
		const members = await tx.select().from(wgMembers).where(eq(wgMembers.wgId, wg.id));
		expect(members.find((member) => member.id === departing.id)).toMatchObject({
			authUserId: null,
			deactivatedAt: expect.any(Date),
		});
		expect(members.find((member) => member.id === pendingSuccessor.id)).toMatchObject({
			authUserId: leavingUser,
			role: 'member',
			deactivatedAt: expect.any(Date),
		});
		expect(members.find((member) => member.id === fallback.id)).toMatchObject({
			authUserId: fallbackUser,
			role: 'admin',
			deactivatedAt: null,
		});
	});
});

test('a calendar writer waiting behind account cleanup cannot restore its credential', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { Client } = await import('pg');
	const { lockActiveAccountMember } = await import('../src/core/db/account-deletion');
	const { removeAccountFromWgs } = await import('../src/core/db/delete-account');
	const { withTransaction } = await import('../src/core/db/transaction');
	const { calendarSubscriptions, wgMembers, wgs } = await import('../src/core/db/schema');
	const { eq, sql } = await import('drizzle-orm');
	const user = crypto.randomUUID();
	trackDeletionFixture(user);
	const otherUser = crypto.randomUUID();
	const ids = await withTransaction(async (tx) => {
		const [wg] = await tx
			.insert(wgs)
			.values({ shareCode: crypto.randomUUID().slice(0, 8).toUpperCase(), name: 'Feed race' })
			.returning({ id: wgs.id });
		const [departing] = await tx
			.insert(wgMembers)
			.values([
				{ wgId: wg.id, name: 'Leaving', role: 'admin', authUserId: user },
				{ wgId: wg.id, name: 'Staying', role: 'member', authUserId: otherUser },
			])
			.returning({ id: wgMembers.id });
		await tx.insert(calendarSubscriptions).values({
			wgId: wg.id,
			memberId: departing.id,
			tokenSeed: crypto.randomUUID(),
		});
		return { wgId: wg.id, departingId: departing.id };
	});
	const deleteApp = `delete-${crypto.randomUUID()}`;
	const calendarApp = `calendar-${crypto.randomUUID()}`;
	const observer = new Client({ connectionString: url });
	await observer.connect();
	const deletionReady = deferred();
	const releaseDeletion = deferred();
	const deletion = withTransaction(async (tx) => {
		await tx.execute(sql`select set_config('application_name', ${deleteApp}, true)`);
		await removeAccountFromWgs(tx, user);
		deletionReady.resolve();
		await releaseDeletion.promise;
	});
	let calendarMutation: Promise<boolean> | undefined;
	try {
		await deletionReady.promise;
		const mutationStarted = deferred();
		calendarMutation = withTransaction(async (tx) => {
			await tx.execute(sql`select set_config('application_name', ${calendarApp}, true)`);
			mutationStarted.resolve();
			const member = await lockActiveAccountMember(tx, ids.wgId, ids.departingId, user);
			if (!member) return false;
			await tx.insert(calendarSubscriptions).values({
				wgId: ids.wgId,
				memberId: member.id,
				tokenSeed: crypto.randomUUID(),
			});
			return true;
		});
		await mutationStarted.promise;
		expect(await waitForBlockedQuery(observer, calendarApp)).toBe(true);
	} finally {
		releaseDeletion.resolve();
		try {
			await deletion;
		} finally {
			await observer.end();
		}
	}
	expect(await calendarMutation).toBe(false);
	await withTransaction(async (tx) => {
		expect(
			await tx
				.select({ id: calendarSubscriptions.id })
				.from(calendarSubscriptions)
				.where(eq(calendarSubscriptions.memberId, ids.departingId)),
		).toHaveLength(0);
	});
});

test('concurrent account deletions across two shared WGs retain each remaining member and balance', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { withTransaction } = await import('../src/core/db/transaction');
	const { removeAccountFromWgs } = await import('../src/core/db/delete-account');
	const { expenses, wgMembers, wgs } = await import('../src/core/db/schema');
	const { eq, inArray } = await import('drizzle-orm');
	const userA = crypto.randomUUID();
	const userB = crypto.randomUUID();
	trackDeletionFixture(userA);
	trackDeletionFixture(userB);
	const code = () => crypto.randomUUID().slice(0, 8).toUpperCase();
	const fixture = await withTransaction(async (tx) => {
		const [wgA, wgB] = await tx
			.insert(wgs)
			.values([
				{ shareCode: code(), name: 'Shared A' },
				{ shareCode: code(), name: 'Shared B' },
			])
			.returning({ id: wgs.id });
		const createdMembers = await tx
			.insert(wgMembers)
			.values([
				{ wgId: wgA.id, name: 'A', role: 'admin', authUserId: userA },
				{ wgId: wgA.id, name: 'B', role: 'member', authUserId: userB },
				{ wgId: wgA.id, name: 'Other A', role: 'member', authUserId: crypto.randomUUID() },
				{ wgId: wgB.id, name: 'A', role: 'member', authUserId: userA },
				{ wgId: wgB.id, name: 'B', role: 'admin', authUserId: userB },
				{ wgId: wgB.id, name: 'Other B', role: 'member', authUserId: crypto.randomUUID() },
			])
			.returning({ id: wgMembers.id, name: wgMembers.name });
		const other1 = createdMembers.find((member) => member.name === 'Other A');
		const other2 = createdMembers.find((member) => member.name === 'Other B');
		if (!other1 || !other2) throw new Error('shared WG members missing');
		await tx.insert(expenses).values([
			{ wgId: wgA.id, paidByMemberId: other1.id, amountCents: 1299, description: 'Kept A' },
			{ wgId: wgB.id, paidByMemberId: other2.id, amountCents: 2599, description: 'Kept B' },
		]);
		return { wgIds: [wgA.id, wgB.id], otherIds: [other1.id, other2.id] };
	});

	const [resultA, resultB] = await Promise.all([
		withTransaction((tx) => removeAccountFromWgs(tx, userA)),
		withTransaction((tx) => removeAccountFromWgs(tx, userB)),
	]);
	expect(resultA.deletedWgIds).toEqual([]);
	expect(resultB.deletedWgIds).toEqual([]);
	await withTransaction(async (tx) => {
		const members = await tx
			.select({
				id: wgMembers.id,
				wgId: wgMembers.wgId,
				role: wgMembers.role,
				authUserId: wgMembers.authUserId,
				deactivatedAt: wgMembers.deactivatedAt,
			})
			.from(wgMembers)
			.where(inArray(wgMembers.wgId, fixture.wgIds));
		for (let index = 0; index < fixture.wgIds.length; index += 1) {
			const wgId = fixture.wgIds[index];
			const otherId = fixture.otherIds[index];
			const roster = members.filter((member) => member.wgId === wgId);
			expect(roster).toHaveLength(3);
			const activeRoster = roster.filter((member) => member.deactivatedAt === null);
			expect(activeRoster).toHaveLength(1);
			expect(activeRoster[0]?.id).toBe(otherId);
			expect(activeRoster[0]?.role).toBe('admin');
			expect(activeRoster[0]?.authUserId).toBeTruthy();
			expect(roster.filter((member) => member.role === 'admin')).toHaveLength(1);
		}
		const keptExpenses = await tx
			.select()
			.from(expenses)
			.where(inArray(expenses.wgId, fixture.wgIds));
		expect(keptExpenses.map((expense) => expense.amountCents).sort()).toEqual([1299, 2599]);
		for (const wgId of fixture.wgIds) {
			expect(await tx.select().from(wgs).where(eq(wgs.id, wgId))).toHaveLength(1);
		}
	});
});

test('a failed local deletion transaction leaves no fence, cleanup, audit, or Auth attempt', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { withTransaction } = await import('../src/core/db/transaction');
	const { removeAccountFromWgs } = await import('../src/core/db/delete-account');
	const { tryCompleteAccountDeletion } = await import('../src/core/db/account-deletion');
	const {
		accountDeletions,
		auditEvents,
		calendarSubscriptions,
		pushSubscriptions,
		wgMembers,
		wgs,
	} = await import('../src/core/db/schema');
	const { and, eq } = await import('drizzle-orm');
	const user = crypto.randomUUID();
	trackDeletionFixture(user);
	const otherUser = crypto.randomUUID();
	const ids = await withTransaction(async (tx) => {
		const [wg] = await tx
			.insert(wgs)
			.values({ shareCode: crypto.randomUUID().slice(0, 8).toUpperCase(), name: 'Rollback' })
			.returning({ id: wgs.id });
		const [departing, staying] = await tx
			.insert(wgMembers)
			.values([
				{ wgId: wg.id, name: 'Departing', role: 'admin', authUserId: user, pushOptIn: true },
				{ wgId: wg.id, name: 'Staying', role: 'member', authUserId: otherUser },
			])
			.returning({ id: wgMembers.id });
		await tx.insert(calendarSubscriptions).values({
			wgId: wg.id,
			memberId: departing.id,
			tokenSeed: crypto.randomUUID(),
		});
		await tx.insert(pushSubscriptions).values({
			memberId: departing.id,
			endpoint: `https://push.example/${crypto.randomUUID()}`,
			p256dh: 'test-key',
			authKey: 'test-key',
		});
		return { wgId: wg.id, memberId: departing.id, stayingId: staying.id };
	});

	await expect(
		withTransaction(async (tx) => {
			const removed = await removeAccountFromWgs(tx, user);
			for (const { wgId, memberId, name, newAdminId } of removed.left) {
				await tx.insert(auditEvents).values({
					wgId,
					memberId,
					eventType: 'member.account_deletion_requested',
					entityType: 'member',
					entityId: memberId,
					summary: `${name} hat die Kontolöschung angefragt und ist ausgezogen.`,
					metadataJson: JSON.stringify({ name, newAdminId }),
				});
			}
			throw new Error('injected rollback');
		}),
	).rejects.toThrow('injected rollback');

	let authCalled = false;
	expect(
		await tryCompleteAccountDeletion(user, async () => {
			authCalled = true;
			return true;
		}),
	).toBe(false);
	expect(authCalled).toBe(false);
	await withTransaction(async (tx) => {
		expect(
			await tx
				.select({ authUserId: accountDeletions.authUserId })
				.from(accountDeletions)
				.where(eq(accountDeletions.authUserId, user)),
		).toHaveLength(0);
		expect(
			await tx
				.select({
					id: wgMembers.id,
					authUserId: wgMembers.authUserId,
					deactivatedAt: wgMembers.deactivatedAt,
				})
				.from(wgMembers)
				.where(eq(wgMembers.id, ids.memberId)),
		).toMatchObject([{ authUserId: user, deactivatedAt: null }]);
		expect(
			await tx
				.select({ id: calendarSubscriptions.id })
				.from(calendarSubscriptions)
				.where(eq(calendarSubscriptions.memberId, ids.memberId)),
		).toHaveLength(1);
		expect(
			await tx
				.select({ id: pushSubscriptions.id })
				.from(pushSubscriptions)
				.where(eq(pushSubscriptions.memberId, ids.memberId)),
		).toHaveLength(1);
		expect(
			await tx
				.select({ id: auditEvents.id })
				.from(auditEvents)
				.where(
					and(
						eq(auditEvents.wgId, ids.wgId),
						eq(auditEvents.eventType, 'member.account_deletion_requested'),
					),
				),
		).toHaveLength(0);
		expect(await tx.select().from(wgMembers).where(eq(wgMembers.id, ids.stayingId))).toHaveLength(
			1,
		);
	});
});

test('Auth success is not marked complete when the completion write fails, and retries resume', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { Pool } = await import('pg');
	const { accountDeletions } = await import('../src/core/db/schema');
	const { withTransaction } = await import('../src/core/db/transaction');
	const { tryCompleteAccountDeletion } = await import('../src/core/db/account-deletion');
	const { eq } = await import('drizzle-orm');
	const user = crypto.randomUUID();
	trackDeletionFixture(user);
	const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
	const functionName = `manawg_test_fail_completion_${suffix}`;
	const triggerName = `manawg_test_fail_completion_${suffix}`;
	const pool = new Pool({ connectionString: url });
	await withTransaction((tx) => tx.insert(accountDeletions).values({ authUserId: user }));
	try {
		await pool.query(`
			CREATE FUNCTION public."${functionName}"() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN
					RAISE EXCEPTION 'injected completion recording failure';
				END IF;
				RETURN NEW;
			END
			$$
		`);
		await pool.query(
			`CREATE TRIGGER "${triggerName}" BEFORE UPDATE OF completed_at ON public.account_deletions FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`,
		);
		let authCalls = 0;
		expect(
			await tryCompleteAccountDeletion(user, async () => {
				authCalls += 1;
				return true;
			}),
		).toBe(false);
		expect(authCalls).toBe(1);
		const [stillPending] = await withTransaction((tx) =>
			tx
				.select({
					lastAttemptAt: accountDeletions.lastAttemptAt,
					completedAt: accountDeletions.completedAt,
				})
				.from(accountDeletions)
				.where(eq(accountDeletions.authUserId, user))
				.limit(1),
		);
		expect(stillPending?.lastAttemptAt).toBeInstanceOf(Date);
		expect(stillPending?.completedAt).toBeNull();
	} finally {
		await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON public.account_deletions`);
		await pool.query(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
	}

	expect(await tryCompleteAccountDeletion(user, async () => false)).toBe(false);
	expect(await tryCompleteAccountDeletion(user, async () => true)).toBe(true);
	let repeatedAuthCall = false;
	expect(
		await tryCompleteAccountDeletion(user, async () => {
			repeatedAuthCall = true;
			return false;
		}),
	).toBe(true);
	expect(repeatedAuthCall).toBe(false);
	await pool.end();
});

test('maintenance retries unattempted and least-recently-attempted deletions first', async () => {
	const url = process.env.ACCOUNT_DELETE_TEST_URL;
	test.skip(!url, 'Requires ACCOUNT_DELETE_TEST_URL pointing at disposable database.');
	process.env.POSTGRES_URL = url;
	process.env.DATABASE_MIGRATION_URL = 'placeholder';
	const { accountDeletions } = await import('../src/core/db/schema');
	const { withTransaction } = await import('../src/core/db/transaction');
	const { retryPendingAccountDeletions } = await import('../src/core/db/account-deletion');
	const oldest = new Date(Date.now() - 3_600_000);
	const attemptedUsers = Array.from({ length: 5 }, () => crypto.randomUUID());
	const newUsers = Array.from({ length: 2 }, () => crypto.randomUUID());
	for (const user of [...attemptedUsers, ...newUsers]) trackDeletionFixture(user);
	await withTransaction((tx) =>
		tx.insert(accountDeletions).values([
			...attemptedUsers.map((authUserId, index) => ({
				authUserId,
				requestedAt: new Date(oldest.getTime() + index * 1000),
				lastAttemptAt: oldest,
			})),
			...newUsers.map((authUserId, index) => ({
				authUserId,
				requestedAt: new Date(Date.now() + index * 1000),
			})),
		]),
	);

	const firstBatch: string[] = [];
	const first = await retryPendingAccountDeletions(async (authUserId) => {
		firstBatch.push(authUserId);
		return false;
	});
	expect(first).toMatchObject({ attempted: 5, completed: 0, pending: 7 });
	expect([...firstBatch].sort()).toEqual([...newUsers, ...attemptedUsers.slice(0, 3)].sort());

	const secondBatch: string[] = [];
	const second = await retryPendingAccountDeletions(async (authUserId) => {
		secondBatch.push(authUserId);
		return false;
	});
	expect(second).toMatchObject({ attempted: 5, completed: 0, pending: 7 });
	expect(attemptedUsers.slice(3).every((user) => secondBatch.includes(user))).toBe(true);
});
