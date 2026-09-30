import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const connectionString = process.env.PRIVATE_IMAGE_TEST_DATABASE_URL;
const wgId = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';

function loadTypeScript(file, overrides = {}) {
	const source = transpileModule(readFileSync(file, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

function imageUrl(id = objectId, targetWgId = wgId) {
	const key = `manawg/${targetWgId}/expense/${id}.jpg`;
	return { key, url: `https://old-preview.example/api/upload/read?key=${encodeURIComponent(key)}` };
}

test(
	'private image deletion preserves shared references and serializes attachment against last removal',
	{ skip: !connectionString },
	async () => {
		const parsed = new URL(connectionString);
		const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
		assert.ok(
			(parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
				loopbackHosts.has(parsed.hostname) &&
				parsed.port !== '' &&
				!parsed.search &&
				!parsed.hash,
			'test database must be a query-free loopback URL',
		);

		const { Client, Pool } = requireFromWeb('pg');
		const { drizzle } = requireFromWeb('drizzle-orm/node-postgres');
		const { and, eq } = requireFromWeb('drizzle-orm');
		const schemaName = `private_image_test_${process.pid}_${Date.now()}`;
		const setup = new Client({ connectionString });
		assert.ok(
			loopbackHosts.has(setup.connectionParameters.host),
			'pg driver target must remain on loopback',
		);
		assert.equal(Number(setup.connectionParameters.port), Number(parsed.port));
		await setup.connect();
		await setup.query(`CREATE SCHEMA ${schemaName}`);
		await setup.query(`CREATE TABLE ${schemaName}.expenses (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			wg_id uuid,
			paid_by_member_id uuid,
			amount_cents integer DEFAULT 100,
			currency text DEFAULT 'EUR',
			description text DEFAULT 'Test',
			image_url text,
			recurring_expense_id uuid,
			recurring_due_at timestamptz,
			import_id uuid,
			import_duplicate_key text,
			occurred_at timestamptz DEFAULT now(),
			created_at timestamptz DEFAULT now(),
			updated_at timestamptz DEFAULT now()
		)`);
		await setup.query(`CREATE TABLE ${schemaName}.expense_splits (
			id uuid DEFAULT gen_random_uuid(),
			expense_id uuid,
			debtor_member_id uuid,
			amount_cents integer,
			settled_at timestamptz
		)`);
		await setup.query(`CREATE TABLE ${schemaName}.wgs (id uuid PRIMARY KEY)`);
		await setup.query(`CREATE TABLE ${schemaName}.account_deletions (
			auth_user_id uuid PRIMARY KEY,
			requested_at timestamptz DEFAULT now(),
			completed_at timestamptz,
			last_attempt_at timestamptz
		)`);
		await setup.query(`CREATE TABLE ${schemaName}.wg_members (
			id uuid PRIMARY KEY,
			wg_id uuid,
			auth_user_id uuid,
			name text,
			role text,
			deactivated_at timestamptz,
			created_at timestamptz DEFAULT now(),
			paypal_merchant_id text,
			push_opt_in boolean DEFAULT false
		)`);
		await setup.query(
			`CREATE TABLE ${schemaName}.expense_payments (id uuid, wg_id uuid, from_member_id uuid, status text)`,
		);
		await setup.query(`CREATE TABLE ${schemaName}.shopping_items (wg_id uuid)`);
		await setup.query(`CREATE TABLE ${schemaName}.chores (wg_id uuid)`);
		await setup.query(`CREATE TABLE ${schemaName}.recurring_expenses (wg_id uuid)`);
		await setup.query(`CREATE TABLE ${schemaName}.announcements (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			wg_id uuid,
			author_member_id uuid,
			content text,
			image_url text
		)`);
		await setup.query(`CREATE TABLE ${schemaName}.wg_chat_messages (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			wg_id uuid,
			sender_member_id uuid,
			kind text,
			body text,
			image_url text,
			system_kind text,
			system_payload jsonb,
			reply_to_message_id uuid,
			edited_at timestamptz,
			deleted_at timestamptz,
			created_at timestamptz DEFAULT now()
		)`);
		await setup.query(`CREATE TABLE ${schemaName}.private_image_deletions (
			object_key text PRIMARY KEY,
			requested_at timestamptz NOT NULL DEFAULT now(),
			last_attempt_at timestamptz,
			storage_deleted_at timestamptz
		)`);
		await setup.query(`CREATE TABLE ${schemaName}.idempotency_responses (
			scope text NOT NULL,
			key text NOT NULL,
			response_body jsonb NOT NULL,
			expires_at timestamptz NOT NULL,
			created_at timestamptz DEFAULT now(),
			PRIMARY KEY (scope, key)
		)`);

		const pool = new Pool({
			connectionString,
			max: 5,
			application_name: 'manawg_private_image_test',
			options: `-c search_path=${schemaName},public`,
		});
		const schema = loadTypeScript(path.join(process.cwd(), 'src/core/db/schema.ts'));
		const db = drizzle(pool, { schema });
		const transaction = loadTypeScript(path.join(process.cwd(), 'src/core/db/transaction.ts'), {
			'./connection': { resolveTransactionConnectionString: () => connectionString },
			'./schema': schema,
			'./transaction-abort': loadTypeScript(
				path.join(process.cwd(), 'src/core/db/transaction-abort.ts'),
			),
		});
		transaction.withTransaction = (operation) => db.transaction(operation);
		const validator = loadTypeScript(path.join(process.cwd(), 'src/core/validators/image-url.ts'));
		const helper = loadTypeScript(
			path.join(process.cwd(), 'src/core/db/private-image-deletions.ts'),
			{
				'server-only': {},
				'@/core/db': { db },
				'@/core/db/schema': schema,
				'@/core/db/transaction': transaction,
				'@/core/validators/image-url': validator,
			},
		);
		const { announcements, expenses, wgChatMessages } = schema;

		try {
			const insertReference = (table, url, deletedAt = null) => {
				if (table === 'wg_chat_messages') {
					return setup.query(
						`INSERT INTO ${schemaName}.${table} (wg_id, image_url, deleted_at) VALUES ($1, $2, $3)`,
						[wgId, url, deletedAt],
					);
				}
				return setup.query(
					`INSERT INTO ${schemaName}.${table} (wg_id, image_url) VALUES ($1, $2)`,
					[wgId, url],
				);
			};
			const rollbackImage = imageUrl('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
			await insertReference('expenses', rollbackImage.url);
			await assert.rejects(
				db.transaction(async (tx) => {
					await transaction.lockExpensePayments(tx, wgId);
					await tx
						.delete(expenses)
						.where(and(eq(expenses.wgId, wgId), eq(expenses.imageUrl, rollbackImage.url)));
					await helper.revokePrivateImageIfUnreferenced(tx, wgId, rollbackImage.url);
					throw new Error('injected_failure_after_private_image_revocation');
				}),
				(error) => error.message === 'injected_failure_after_private_image_revocation',
			);
			assert.equal(await helper.isPrivateImageKeyRevoked(rollbackImage.key), false);
			const rollbackReference = await setup.query(
				`SELECT id FROM ${schemaName}.expenses WHERE wg_id = $1 AND image_url = $2`,
				[wgId, rollbackImage.url],
			);
			assert.equal(
				rollbackReference.rowCount,
				1,
				'the expense reference rolls back with its deletion',
			);
			const rollbackTombstone = await setup.query(
				`SELECT object_key FROM ${schemaName}.private_image_deletions WHERE object_key = $1`,
				[rollbackImage.key],
			);
			assert.equal(
				rollbackTombstone.rowCount,
				0,
				'the tombstone insert rolls back with the mutation',
			);

			const sharedAnnouncement = imageUrl('33333333-3333-4333-8333-333333333333');
			await insertReference('expenses', sharedAnnouncement.url);
			await insertReference('announcements', sharedAnnouncement.url);
			assert.deepEqual(
				[...(await helper.findLivePrivateImageReferenceKeys([sharedAnnouncement.key]))],
				[sharedAnnouncement.key],
			);
			await db.transaction(async (tx) => {
				await transaction.lockExpensePayments(tx, wgId);
				await tx
					.delete(expenses)
					.where(and(eq(expenses.wgId, wgId), eq(expenses.imageUrl, sharedAnnouncement.url)));
				await helper.revokePrivateImageIfUnreferenced(tx, wgId, sharedAnnouncement.url);
			});
			assert.equal(await helper.isPrivateImageKeyRevoked(sharedAnnouncement.key), false);
			await db.transaction(async (tx) => {
				await transaction.lockExpensePayments(tx, wgId);
				await tx
					.delete(announcements)
					.where(
						and(eq(announcements.wgId, wgId), eq(announcements.imageUrl, sharedAnnouncement.url)),
					);
				await helper.revokePrivateImageIfUnreferenced(tx, wgId, sharedAnnouncement.url);
			});
			assert.equal(await helper.isPrivateImageKeyRevoked(sharedAnnouncement.key), true);
			await assert.rejects(
				db.transaction((tx) =>
					helper.assertPrivateImageCanBeAttached(tx, wgId, sharedAnnouncement.url),
				),
				(error) => error.code === 'image_removed',
			);

			const sharedChat = imageUrl('44444444-4444-4444-8444-444444444444');
			await insertReference('expenses', sharedChat.url);
			await insertReference('wg_chat_messages', sharedChat.url);
			await db.transaction(async (tx) => {
				await transaction.lockExpensePayments(tx, wgId);
				await tx
					.delete(expenses)
					.where(and(eq(expenses.wgId, wgId), eq(expenses.imageUrl, sharedChat.url)));
				await helper.revokePrivateImageIfUnreferenced(tx, wgId, sharedChat.url);
			});
			assert.equal(await helper.isPrivateImageKeyRevoked(sharedChat.key), false);
			await db.transaction(async (tx) => {
				await transaction.lockExpensePayments(tx, wgId);
				await tx
					.update(wgChatMessages)
					.set({ deletedAt: new Date() })
					.where(eq(wgChatMessages.imageUrl, sharedChat.url));
				await helper.revokePrivateImageIfUnreferenced(tx, wgId, sharedChat.url);
			});
			assert.equal(await helper.isPrivateImageKeyRevoked(sharedChat.key), true);

			const raced = imageUrl('55555555-5555-4555-8555-555555555555');
			await insertReference('expenses', raced.url);
			let releaseDeletion;
			let deletionChanged;
			const waitForRelease = new Promise((resolve) => {
				releaseDeletion = resolve;
			});
			const changed = new Promise((resolve) => {
				deletionChanged = resolve;
			});
			const deleting = db.transaction(async (tx) => {
				await transaction.lockExpensePayments(tx, wgId);
				await tx
					.delete(expenses)
					.where(and(eq(expenses.wgId, wgId), eq(expenses.imageUrl, raced.url)));
				await helper.revokePrivateImageIfUnreferenced(tx, wgId, raced.url);
				deletionChanged();
				await waitForRelease;
			});
			let attaching;
			try {
				const deletionReachedGate = await Promise.race([
					changed.then(() => true),
					deleting.then(() => false),
				]);
				assert.equal(deletionReachedGate, true, 'deletion transaction reaches its held-lock gate');
				let attachmentStarted;
				const startingAttachment = new Promise((resolve) => {
					attachmentStarted = resolve;
				});
				attaching = db.transaction(async (tx) => {
					attachmentStarted();
					await transaction.lockExpensePayments(tx, wgId);
					await helper.assertPrivateImageCanBeAttached(tx, wgId, raced.url);
					await tx.execute(
						requireFromWeb('drizzle-orm')
							.sql`INSERT INTO expenses (wg_id, image_url) VALUES (${wgId}, ${raced.url})`,
					);
				});
				const attachmentReachedLock = await Promise.race([
					startingAttachment.then(() => true),
					attaching.then(() => false),
				]);
				assert.equal(
					attachmentReachedLock,
					true,
					'attachment attempts its WG lock while deletion is open',
				);
				releaseDeletion();
				await deleting;
				await assert.rejects(attaching, (error) => error.code === 'image_removed');
				assert.equal(await helper.isPrivateImageKeyRevoked(raced.key), true);
			} finally {
				releaseDeletion();
				await Promise.allSettled([deleting, ...(attaching ? [attaching] : [])]);
			}

			const attachFirst = imageUrl('77777777-7777-4777-8777-777777777777');
			const original = await setup.query(
				`INSERT INTO ${schemaName}.expenses (wg_id, image_url) VALUES ($1, $2) RETURNING id`,
				[wgId, attachFirst.url],
			);
			let releaseAttachment;
			let attachmentHeld;
			let deletionStarted;
			const waitForAttachmentRelease = new Promise((resolve) => {
				releaseAttachment = resolve;
			});
			const attachmentReady = new Promise((resolve) => {
				attachmentHeld = resolve;
			});
			const deletionReady = new Promise((resolve) => {
				deletionStarted = resolve;
			});
			const attachingFirst = db.transaction(async (tx) => {
				await transaction.lockExpensePayments(tx, wgId);
				await helper.assertPrivateImageCanBeAttached(tx, wgId, attachFirst.url);
				await tx.execute(
					requireFromWeb('drizzle-orm')
						.sql`INSERT INTO expenses (wg_id, image_url) VALUES (${wgId}, ${attachFirst.url})`,
				);
				attachmentHeld();
				await waitForAttachmentRelease;
			});
			let deletingAfterAttach;
			try {
				const attachmentReachedGate = await Promise.race([
					attachmentReady.then(() => true),
					attachingFirst.then(() => false),
				]);
				assert.equal(
					attachmentReachedGate,
					true,
					'attachment transaction reaches its held-lock gate',
				);
				deletingAfterAttach = db.transaction(async (tx) => {
					deletionStarted();
					await transaction.lockExpensePayments(tx, wgId);
					await tx.delete(expenses).where(eq(expenses.id, original.rows[0].id));
					await helper.revokePrivateImageIfUnreferenced(tx, wgId, attachFirst.url);
				});
				await deletionReady;
				let lockObserved = false;
				for (let attempt = 0; attempt < 30; attempt++) {
					const waiting = await setup.query(
						"SELECT 1 FROM pg_stat_activity WHERE application_name = 'manawg_private_image_test' AND wait_event_type = 'Lock' LIMIT 1",
					);
					if (waiting.rowCount) {
						lockObserved = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(lockObserved, true, 'last-reference deletion waits for the attachment lock');
				releaseAttachment();
				await Promise.all([attachingFirst, deletingAfterAttach]);
				assert.equal(await helper.isPrivateImageKeyRevoked(attachFirst.key), false);
			} finally {
				releaseAttachment();
				await Promise.allSettled([
					attachingFirst,
					...(deletingAfterAttach ? [deletingAfterAttach] : []),
				]);
			}

			const draft = imageUrl('66666666-6666-4666-8666-666666666666');
			await db.transaction((tx) => helper.assertPrivateImageCanBeAttached(tx, wgId, draft.url));

			const deletedChat = imageUrl('88888888-8888-4888-8888-888888888888');
			await insertReference('wg_chat_messages', deletedChat.url, new Date());
			await db.transaction(async (tx) => {
				await transaction.lockExpensePayments(tx, wgId);
				await helper.recordWgImageDeletions(tx, wgId);
			});
			assert.equal(await helper.isPrivateImageKeyRevoked(deletedChat.key), true);

			const cleanupNow = new Date();
			const dueKeys = Array.from(
				{ length: 51 },
				(_, index) =>
					`manawg/${wgId}/expense/99999999-9999-4999-9999-${index.toString(16).padStart(12, '0')}.jpg`,
			);
			const values = dueKeys.flatMap((objectKey, index) => [
				objectKey,
				new Date(cleanupNow.getTime() - 2 * 60 * 60 * 1000 - 6 * 60 * 1000 - index),
			]);
			const placeholders = dueKeys
				.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
				.join(', ');
			await setup.query(
				`INSERT INTO ${schemaName}.private_image_deletions (object_key, requested_at) VALUES ${placeholders}`,
				values,
			);
			const tooEarlyKey = imageUrl('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').key;
			await setup.query(
				`INSERT INTO ${schemaName}.private_image_deletions (object_key, requested_at) VALUES ($1, $2)`,
				[tooEarlyKey, new Date(cleanupNow.getTime() - 2 * 60 * 60 * 1000 - 4 * 60 * 1000)],
			);
			const pendingBefore = await helper.countPendingPrivateImageDeletions();
			const firstBatch = await helper.claimPrivateImageCleanupBatch(cleanupNow);
			assert.equal(firstBatch.length, 50);
			assert.equal(firstBatch.includes(tooEarlyKey), false);
			const attemptState = await setup.query(
				`SELECT count(*) FILTER (WHERE last_attempt_at IS NULL)::int AS unattempted FROM ${schemaName}.private_image_deletions WHERE object_key = ANY($1::text[])`,
				[dueKeys],
			);
			assert.equal(attemptState.rows[0].unattempted, 1);
			const secondBatch = await helper.claimPrivateImageCleanupBatch(cleanupNow);
			assert.equal(secondBatch.length, 50);
			assert.equal(
				secondBatch[0],
				dueKeys[0],
				'never-attempted work stays ahead of recent retries',
			);
			await helper.markPrivateImageStorageDeleted([...firstBatch, ...secondBatch], cleanupNow);
			assert.equal(await helper.countPendingPrivateImageDeletions(), pendingBefore - 51);
			const beforeRecheck = await helper.claimPrivateImageCleanupBatch(
				new Date(cleanupNow.getTime() + 24 * 60 * 60 * 1000 - 1),
			);
			assert.equal(
				beforeRecheck.some((key) => dueKeys.includes(key)),
				false,
			);
			const recheck = await helper.claimPrivateImageCleanupBatch(
				new Date(cleanupNow.getTime() + 24 * 60 * 60 * 1000),
			);
			assert.equal(recheck.length, 50);
			assert.equal(
				recheck.every((key) => dueKeys.includes(key)),
				true,
			);

			const cascadeImage = imageUrl('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
			await setup.query(`INSERT INTO ${schemaName}.wgs (id) VALUES ($1)`, [wgId]);
			await insertReference('expenses', cascadeImage.url);
			const deleteWg = loadTypeScript(path.join(process.cwd(), 'src/core/db/delete-wg.ts'), {
				'./schema': schema,
				'./transaction': transaction,
				'./private-image-deletions': helper,
			});
			let releaseCascade;
			let cascadeApplied;
			let routeLockStarted;
			const waitForCascadeRelease = new Promise((resolve) => {
				releaseCascade = resolve;
			});
			const cascadeReady = new Promise((resolve) => {
				cascadeApplied = resolve;
			});
			const routeLockReady = new Promise((resolve) => {
				routeLockStarted = resolve;
			});
			const originalLock = transaction.lockExpensePayments;
			let observeRouteLock = false;
			transaction.lockExpensePayments = (tx, currentWgId) => {
				if (observeRouteLock) {
					observeRouteLock = false;
					routeLockStarted();
				}
				return originalLock(tx, currentWgId);
			};
			const deletingWg = db.transaction(async (tx) => {
				assert.equal(await deleteWg.deleteWgCascade(tx, wgId), true);
				cascadeApplied();
				await waitForCascadeRelease;
			});
			let post;
			try {
				const cascadeReachedGate = await Promise.race([
					cascadeReady.then(() => true),
					deletingWg.then(() => false),
				]);
				assert.equal(
					cascadeReachedGate,
					true,
					'WG deletion transaction reaches its held-lock gate',
				);

				const z = requireFromWeb('zod').z;
				const responseJson = (error, status) => Response.json({ error }, { status });
				const route = loadTypeScript(
					path.join(process.cwd(), 'src/app/api/wg/[code]/chat/messages/route.ts'),
					{
						'@/core/audit': { recordAuditEvent: async () => undefined },
						'@/core/db': {
							db,
							idempotencyResponses: schema.idempotencyResponses,
							wgChatMentions: schema.wgChatMentions,
							wgChatMessages: schema.wgChatMessages,
							wgChatReactions: schema.wgChatReactions,
							wgMembers: schema.wgMembers,
						},
						'@/core/db/private-image-deletions': helper,
						'@/core/db/transaction': transaction,
						'@/core/errors': {
							badRequest: (error) => responseJson(error, 400),
							conflict: (error, code) =>
								Response.json({ error, ...(code ? { code } : {}) }, { status: 409 }),
							payloadTooLarge: () => responseJson('payload_too_large', 413),
						},
						'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
						'@/core/guards/idempotency': { claimReplaySlotWithRetry: async () => ({ won: true }) },
						'@/core/guards/require-wg-member': {
							requireWgMember: async () => ({
								ok: true,
								wg: { id: wgId, name: 'Test WG', shareCode: 'MTE8PZAT' },
								member: { memberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Member' },
							}),
						},
						'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
						'@/core/http/read-json': {
							readJsonBody: async (request) => ({ ok: true, body: await request.json() }),
						},
						'@/core/idempotency': {
							RESPONSE_REPLAY_TTL_SECONDS: 604_800,
							getCachedResponse: async () => null,
							readIdempotencyKey: () => null,
						},
						'@/core/infra/env': { readListLimit: (_env, _key, fallback) => fallback },
						'@/core/infra/observability': { logApiError: () => undefined },
						'@/core/notifications/notification-dispatch': {
							dispatchNotificationSafely: async () => ({ warning: null }),
						},
						'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }) },
						'@/core/validators/image-url': {
							imageUrlSchema: z.string().nullable().optional(),
							isAllowedImageUrlForWg: () => true,
						},
						'@/features/chat/chat-pure': {
							CHAT_REFRESH_BATCH_SIZE: 100,
							filterPersistedMentionIds: (ids) => ids,
							previewBody: (body) => body,
							sanitizeMessageBody: (body) => body,
						},
						'@/features/chat/chat-unread-query': {},
						'next/server': {
							NextResponse: { json: (body, init) => Response.json(body, init) },
						},
					},
				);
				observeRouteLock = true;
				post = route.POST(
					new Request('https://app.example/api/wg/MTE8PZAT/chat/messages', {
						method: 'POST',
						body: JSON.stringify({ body: 'Race attachment', imageUrl: cascadeImage.url }),
					}),
					{ code: 'MTE8PZAT' },
				);
				const attemptedLock = await Promise.race([
					routeLockReady.then(() => true),
					post.then(() => false),
				]);
				assert.equal(attemptedLock, true, 'writer enters its WG transaction before completing');
				let blockedOnWgLock = false;
				for (let attempt = 0; attempt < 30; attempt++) {
					const waiting = await setup.query(
						"SELECT 1 FROM pg_stat_activity WHERE application_name = 'manawg_private_image_test' AND wait_event_type = 'Lock' LIMIT 1",
					);
					if (waiting.rowCount) {
						blockedOnWgLock = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(
					blockedOnWgLock,
					true,
					'chat writer waits for whole-WG deletion under the same lock',
				);
				releaseCascade();
				await deletingWg;
				const postResponse = await post;
				assert.equal(postResponse.status, 409);
				assert.deepEqual(await postResponse.json(), {
					error: 'image_removed',
					code: 'image_removed',
				});
				assert.equal(await helper.isPrivateImageKeyRevoked(cascadeImage.key), true);
				const remainingImages = await setup.query(
					`SELECT count(*)::int AS count FROM ${schemaName}.wg_chat_messages WHERE wg_id = $1 AND image_url = $2`,
					[wgId, cascadeImage.url],
				);
				assert.equal(remainingImages.rows[0].count, 0);
			} finally {
				releaseCascade();
				await deletingWg.catch(() => undefined);
				if (post) await post.catch(() => undefined);
			}

			const accountWgId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
			const accountUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
			const accountMemberId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
			const accountImage = imageUrl('cccccccc-cccc-4ccc-8ccc-cccccccccccc', accountWgId);
			await setup.query(`INSERT INTO ${schemaName}.wgs (id) VALUES ($1)`, [accountWgId]);
			await setup.query(
				`INSERT INTO ${schemaName}.wg_members (id, wg_id, auth_user_id, name, role) VALUES ($1, $2, $3, 'Last Member', 'admin')`,
				[accountMemberId, accountWgId, accountUserId],
			);
			await setup.query(`INSERT INTO ${schemaName}.expenses (wg_id, image_url) VALUES ($1, $2)`, [
				accountWgId,
				accountImage.url,
			]);
			const accountDeletion = loadTypeScript(
				path.join(process.cwd(), 'src/core/db/account-deletion.ts'),
				{
					'./schema': schema,
					'./transaction': transaction,
					'./transaction-abort': loadTypeScript(
						path.join(process.cwd(), 'src/core/db/transaction-abort.ts'),
					),
				},
			);
			const deleteAccount = loadTypeScript(
				path.join(process.cwd(), 'src/core/db/delete-account.ts'),
				{
					'./account-deletion': accountDeletion,
					'./delete-wg': deleteWg,
					'./schema': schema,
					'./transaction': transaction,
				},
			);
			const removal = await db.transaction((tx) =>
				deleteAccount.removeAccountFromWgs(tx, accountUserId),
			);
			assert.deepEqual(removal.deletedWgIds, [accountWgId]);
			assert.equal(await helper.isPrivateImageKeyRevoked(accountImage.key), true);

			const routeWgId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
			const routeMemberId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
			await setup.query(`INSERT INTO ${schemaName}.wgs (id) VALUES ($1)`, [routeWgId]);
			const patchImage = imageUrl('12121212-1212-4212-8212-121212121212', routeWgId);
			const deleteImage = imageUrl('13131313-1313-4313-8313-131313131313', routeWgId);
			const patchExpense = await setup.query(
				`INSERT INTO ${schemaName}.expenses (wg_id, paid_by_member_id, image_url) VALUES ($1, $2, $3) RETURNING id`,
				[routeWgId, routeMemberId, patchImage.url],
			);
			const deleteExpense = await setup.query(
				`INSERT INTO ${schemaName}.expenses (wg_id, paid_by_member_id, image_url) VALUES ($1, $2, $3) RETURNING id`,
				[routeWgId, routeMemberId, deleteImage.url],
			);
			const z = requireFromWeb('zod').z;
			const expenseRoute = loadTypeScript(
				path.join(process.cwd(), 'src/app/api/wg/[code]/expenses/[id]/route.ts'),
				{
					'@/core/audit': { recordAuditEvent: async () => undefined },
					'@/core/db': {
						db,
						expenseSplits: schema.expenseSplits,
						expenses,
						wgMembers: schema.wgMembers,
					},
					'@/core/db/private-image-deletions': helper,
					'@/core/db/transaction': transaction,
					'@/core/errors': {
						badRequest: (error) => responseJson(error, 400),
						conflict: (error, code) =>
							Response.json({ error, ...(code ? { code } : {}) }, { status: 409 }),
						forbidden: (error) => responseJson(error, 403),
						notFound: (error) => responseJson(error, 404),
						requireVerifiedMember: () => null,
						serverError: (error) => responseJson(error, 500),
						tooMany: () => responseJson('too_many', 429),
					},
					'@/core/guards/admin': {},
					'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
					'@/core/guards/require-wg-member': {
						requireWgMember: async () => ({
							ok: true,
							wg: { id: routeWgId },
							member: { memberId: routeMemberId, name: 'Member' },
						}),
					},
					'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
					'@/core/infra/observability': { logApiError: () => undefined },
					'@/core/rate-limit': {
						checkRateLimit: async () => ({ success: true }),
						wgWriteLimiter: {},
					},
					'@/core/validators/currency': { currencySchema: z.string() },
					'@/core/validators/image-url': {
						imageUrlSchema: z.string().nullable().optional(),
						isAllowedImageUrlForWg: () => true,
					},
					'@/features/expenses/expense-constants': {
						AMOUNT_MAX_CENTS: 100_000_000,
						AMOUNT_MIN_CENTS: 1,
					},
					'@/features/expenses/expense-payments': {
						hasCapturingExpensePayment: async () => false,
						withExpensePaymentLock: async (currentWgId, operation) =>
							db.transaction(async (tx) => {
								await transaction.lockExpensePayments(tx, currentWgId);
								return operation(tx);
							}),
					},
					'@/features/expenses/split-math': {
						settledAtForOwnShare: () => null,
						splitValidationErrorCode: (reason) => reason,
						validateSplits: () => ({ ok: true }),
					},
					'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
				},
			);
			const patchResponse = await expenseRoute.PATCH(
				new Request('https://app.example', {
					method: 'PATCH',
					body: JSON.stringify({ imageUrl: null }),
				}),
				{ code: 'MTE8PZAT', id: patchExpense.rows[0].id },
			);
			assert.equal(patchResponse.status, 200);
			assert.equal(await helper.isPrivateImageKeyRevoked(patchImage.key), true);
			const deleteResponse = await expenseRoute.DELETE(
				new Request('https://app.example', { method: 'DELETE' }),
				{ code: 'MTE8PZAT', id: deleteExpense.rows[0].id },
			);
			assert.equal(deleteResponse.status, 200);
			assert.equal(await helper.isPrivateImageKeyRevoked(deleteImage.key), true);

			const chatImage = imageUrl('14141414-1414-4414-8414-141414141414', routeWgId);
			const chatMessageId = '15151515-1515-4515-8515-151515151515';
			await setup.query(
				`INSERT INTO ${schemaName}.wg_chat_messages (id, wg_id, sender_member_id, kind, body, image_url) VALUES ($1, $2, $3, 'image', null, $4)`,
				[chatMessageId, routeWgId, routeMemberId, chatImage.url],
			);
			const chatDeleteRoute = loadTypeScript(
				path.join(process.cwd(), 'src/app/api/wg/[code]/chat/messages/[id]/route.ts'),
				{
					'@/core/audit': { recordAuditEvent: async () => undefined },
					'@/core/db': { db, wgChatMessages: schema.wgChatMessages },
					'@/core/db/private-image-deletions': helper,
					'@/core/db/transaction': transaction,
					'@/core/errors': {
						badRequest: (error) => responseJson(error, 400),
						forbidden: (error) => responseJson(error, 403),
						notFound: (error) => responseJson(error, 404),
						requireVerifiedMember: () => null,
						tooMany: () => responseJson('too_many', 429),
					},
					'@/core/guards/admin': { requireOwnerOrAdmin: async () => null },
					'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
					'@/core/guards/require-wg-member': {
						requireWgMember: async () => ({
							ok: true,
							wg: { id: routeWgId },
							member: { memberId: routeMemberId, name: 'Member', verified: true },
						}),
					},
					'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
					'@/core/rate-limit': {
						checkRateLimit: async () => ({ success: true }),
						wgWriteLimiter: {},
					},
					'@/features/chat/chat-pure': {
						canEditMessage: () => true,
						sanitizeMessageBody: (body) => body,
					},
					'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
				},
			);
			const chatDeleteResponse = await chatDeleteRoute.DELETE(
				new Request('https://app.example', { method: 'DELETE' }),
				{ code: 'MTE8PZAT', id: chatMessageId },
			);
			assert.equal(chatDeleteResponse.status, 200);
			assert.equal(await helper.isPrivateImageKeyRevoked(chatImage.key), true);

			const announcementImage = imageUrl('16161616-1616-4616-8616-161616161616', routeWgId);
			const announcementId = '17171717-1717-4717-8717-171717171717';
			await setup.query(
				`INSERT INTO ${schemaName}.announcements (id, wg_id, author_member_id, content, image_url) VALUES ($1, $2, $3, 'Announcement', $4)`,
				[announcementId, routeWgId, routeMemberId, announcementImage.url],
			);
			const announcementDeleteRoute = loadTypeScript(
				path.join(process.cwd(), 'src/app/api/wg/[code]/announcements/[id]/route.ts'),
				{
					'@/core/audit': { recordAuditEvent: async () => undefined },
					'@/core/db': {
						announcementReactions: schema.announcementReactions,
						announcements: schema.announcements,
						db,
					},
					'@/core/db/private-image-deletions': helper,
					'@/core/db/transaction': transaction,
					'@/core/errors': {
						badRequest: (error) => responseJson(error, 400),
						forbidden: (error) => responseJson(error, 403),
						notFound: (error) => responseJson(error, 404),
						tooMany: () => responseJson('too_many', 429),
					},
					'@/core/guards/admin': {
						isVerifiedWgAdmin: async () => true,
						requireOwnerOrAdmin: async () => null,
					},
					'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
					'@/core/guards/require-wg-member': {
						requireWgMember: async () => ({
							ok: true,
							wg: { id: routeWgId },
							member: { memberId: routeMemberId, name: 'Member', verified: true },
						}),
					},
					'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
					'@/core/notifications/notification-dispatch': {
						dispatchNotificationSafely: async () => ({ warning: null }),
					},
					'@/core/rate-limit': {
						checkRateLimit: async () => ({ success: true }),
						wgWriteLimiter: {},
					},
					'@/features/pinnwand/announcement-workflow': {
						ANNOUNCEMENT_KINDS: ['info', 'question', 'problem', 'request', 'decision'],
					},
					'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
				},
			);
			const announcementDeleteResponse = await announcementDeleteRoute.DELETE(
				new Request('https://app.example', { method: 'DELETE' }),
				{ code: 'MTE8PZAT', id: announcementId },
			);
			assert.equal(announcementDeleteResponse.status, 200);
			assert.equal(await helper.isPrivateImageKeyRevoked(announcementImage.key), true);

			const replayKey = 'announcement-lock-order';
			const replayScope = `announcement:${accountWgId}:member`;
			await setup.query(
				`INSERT INTO ${schemaName}.idempotency_responses (scope, key, response_body, expires_at) VALUES ($1, $2, '{"_claimed":true}'::jsonb, $3)`,
				[replayScope, replayKey, new Date(Date.now() + 60_000)],
			);
			let releaseReplayLock;
			let workgroupLocked;
			let replayLockAttempted;
			const waitForReplayRelease = new Promise((resolve) => {
				releaseReplayLock = resolve;
			});
			const workgroupLockReady = new Promise((resolve) => {
				workgroupLocked = resolve;
			});
			const replayLockReady = new Promise((resolve) => {
				replayLockAttempted = resolve;
			});
			const lockForTest = transaction.lockExpensePayments;
			let observeReplayLock = true;
			transaction.lockExpensePayments = (tx, currentWgId) => {
				if (observeReplayLock) {
					observeReplayLock = false;
					replayLockAttempted();
				}
				return lockForTest(tx, currentWgId);
			};
			const replayLockHolder = db.transaction(async (tx) => {
				await lockForTest(tx, accountWgId);
				workgroupLocked();
				await waitForReplayRelease;
			});
			try {
				const holderAcquiredLock = await Promise.race([
					workgroupLockReady.then(() => true),
					replayLockHolder.then(() => false),
				]);
				assert.equal(holderAcquiredLock, true, 'test transaction holds the WG lock');
				const replayModule = loadTypeScript(
					path.join(process.cwd(), 'src/features/pinnwand/announcement-replay.ts'),
					{
						'@/core/db': { db, idempotencyResponses: schema.idempotencyResponses },
						'@/core/db/transaction': transaction,
						'@/core/guards/idempotency': { claimReplaySlotWithRetry: async () => ({ won: true }) },
						'@/core/idempotency': {
							RESPONSE_REPLAY_TTL_SECONDS: 604_800,
							getCachedResponse: async () => null,
							readIdempotencyKey: (request) => request.headers.get('Idempotency-Key'),
						},
						'@/core/infra/observability': { logApiError: () => undefined },
					},
				);
				let mutateStarted = false;
				const replay = replayModule.withAnnouncementReplay(
					new Request('https://app.example', { headers: { 'Idempotency-Key': replayKey } }),
					replayScope,
					async () => {
						mutateStarted = true;
						return {
							response: { status: 200, body: { announcement: { id: 'created' } } },
							effect: null,
						};
					},
					undefined,
					accountWgId,
				);
				const lockObservedBeforeReplay = await Promise.race([
					replayLockReady.then(() => true),
					replay.then(() => false),
				]);
				assert.equal(
					lockObservedBeforeReplay,
					true,
					'WG lock is attempted before the replay-row lock',
				);
				let advisoryWaitObserved = false;
				for (let attempt = 0; attempt < 30; attempt++) {
					const waiting = await setup.query(
						"SELECT query FROM pg_stat_activity WHERE application_name = 'manawg_private_image_test' AND wait_event_type = 'Lock' LIMIT 1",
					);
					if (waiting.rowCount) {
						advisoryWaitObserved = /pg_advisory_xact_lock/.test(waiting.rows[0].query);
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(advisoryWaitObserved, true);
				assert.equal(mutateStarted, false);
				releaseReplayLock();
				await replayLockHolder;
				assert.equal((await replay).response.status, 200);
			} finally {
				releaseReplayLock();
				await replayLockHolder.catch(() => undefined);
			}
		} finally {
			await pool.end();
			await setup.query(`DROP SCHEMA ${schemaName} CASCADE`);
			await setup.end();
		}
	},
);
