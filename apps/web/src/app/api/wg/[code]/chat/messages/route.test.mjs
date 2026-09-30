import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { PgDialect, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = path.join(process.cwd(), 'src/app/api/wg/[code]/chat/messages/route.ts');
const key = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const mentionedId = '33333333-3333-4333-8333-333333333333';
const wgId = '44444444-4444-4444-8444-444444444444';

const idempotencyResponses = pgTable('idempotency_responses', {
	scope: text('scope'),
	key: text('key'),
	responseBody: jsonb('response_body'),
	expiresAt: timestamp('expires_at', { withTimezone: true }),
});
const wgChatMessages = pgTable('wg_chat_messages', {
	id: uuid('id'),
	wgId: uuid('wg_id'),
	deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
const wgChatMentions = pgTable('wg_chat_mentions', {
	mentionedMemberId: uuid('mentioned_member_id'),
});
const wgMembers = pgTable('wg_members', { id: uuid('id'), wgId: uuid('wg_id') });

function harness() {
	const state = {
		slot: null,
		messages: [],
		mentions: [],
		claims: 0,
		audits: 0,
		notifications: 0,
		failReplayWrite: false,
		failCommit: false,
		warning: null,
		warningUpdateSucceeds: true,
		warningWhere: '',
		claimExpiry: new Date('2026-09-25T00:00:00.000Z'),
		releaseWhere: '',
		errors: [],
		locks: 0,
		rejectImageAttachment: false,
	};
	class TransactionAbort extends Error {
		constructor(code) {
			super(code);
			this.code = code;
		}
	}
	let prior = Promise.resolve();
	const db = {
		delete: () => ({
			where: async (condition) => {
				state.releaseWhere = new PgDialect().sqlToQuery(condition).sql;
				if (state.slot?._claimed) state.slot = null;
			},
		}),
		update: () => ({
			set: () => ({
				where: (condition) => ({
					returning: async () => {
						state.warningWhere = new PgDialect().sqlToQuery(condition).sql;
						if (!state.warningUpdateSucceeds) return [];
						state.slot.body.warning = state.warning;
						return [{ scope: 'chat-message' }];
					},
				}),
			}),
		}),
	};
	const withTransaction = async (operation) => {
		const waitFor = prior;
		let release = () => undefined;
		prior = new Promise((resolve) => {
			release = resolve;
		});
		await waitFor;
		let slot = structuredClone(state.slot);
		const messages = [...state.messages];
		const mentions = [...state.mentions];
		const tx = {
			select: () => ({
				from: (table) => ({
					where: () =>
						table === wgMembers
							? Promise.resolve([{ id: mentionedId }])
							: {
									limit: () =>
										table === idempotencyResponses
											? {
													for: async () =>
														slot ? [{ body: slot, expiresAt: state.claimExpiry }] : [],
												}
											: Promise.resolve([]),
								},
				}),
			}),
			insert: (table) => ({
				values: (value) => ({
					returning: async () => {
						assert.equal(table, wgChatMessages);
						const message = { ...value, id: `message-${messages.length + 1}` };
						messages.push(message);
						return [message];
					},
					onConflictDoNothing: () => ({
						returning: async () => {
							assert.equal(table, wgChatMentions);
							mentions.push(...value);
							return value;
						},
					}),
				}),
			}),
			update: (table) => ({
				set: (value) => ({
					where: () => ({
						returning: async () => {
							assert.equal(table, idempotencyResponses);
							if (state.failReplayWrite) throw new Error('cache_write_failed');
							if (JSON.stringify(slot) !== '{"_claimed":true}') return [];
							slot = value.responseBody;
							return [{ scope: 'chat-message' }];
						},
					}),
				}),
			}),
		};
		try {
			const result = await operation(tx);
			if (state.failCommit) throw new Error('commit_outcome_unknown');
			state.slot = slot;
			state.messages = messages;
			state.mentions = mentions;
			return result;
		} finally {
			release();
		}
	};

	const source = transpileModule(readFileSync(routePath, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	const z = requireFromWeb('zod').z;
	const overrides = {
		'@/core/audit': { recordAuditEvent: async () => state.audits++ },
		'@/core/db': {
			db,
			idempotencyResponses,
			wgChatMentions,
			wgChatMessages,
			wgChatReactions: {},
			wgMembers,
		},
		'@/core/db/private-image-deletions': {
			assertPrivateImageCanBeAttached: async () => {
				if (state.rejectImageAttachment) throw new TransactionAbort('image_removed');
			},
		},
		'@/core/db/transaction': {
			TransactionAbort,
			lockExpensePayments: async () => {
				state.locks++;
			},
			withTransaction,
		},
		'@/core/errors': {
			conflict: (error, code) =>
				Response.json({ error, ...(code ? { code } : {}) }, { status: 409 }),
		},
		'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
		'@/core/guards/idempotency': {
			claimReplaySlotWithRetry: async () => {
				state.claims++;
				if (!state.slot) state.slot = { _claimed: true };
				return { won: true };
			},
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId, name: 'Member' },
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/http/read-json': {
			readJsonBody: async (req) => ({ ok: true, body: await req.json() }),
		},
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 604_800,
			getCachedResponse: async () => (state.slot && !state.slot._claimed ? state.slot : null),
			readIdempotencyKey: (req) => req.headers.get('idempotency-key'),
		},
		'@/core/infra/env': { readListLimit: (_env, _key, fallback) => fallback },
		'@/core/infra/observability': {
			logApiError: (label, err) => state.errors.push(`${label}: ${err}`),
		},
		'@/core/notifications/notification-dispatch': {
			dispatchNotificationSafely: async () => {
				assert.equal(state.messages.length, 1, 'notification must run after commit');
				state.notifications++;
				return { warning: state.warning };
			},
		},
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }) },
		'@/core/validators/image-url': {
			imageUrlSchema: z.string().nullable().optional(),
			isAllowedImageUrlForWg: () => true,
		},
		'@/features/chat/chat-pure': {
			CHAT_REFRESH_BATCH_SIZE: 100,
			filterPersistedMentionIds: (ids, rows) =>
				ids.filter((id) => rows.some((row) => row.mentionedMemberId === id)),
			previewBody: (body) => body,
			sanitizeMessageBody: (body) => body,
		},
		'@/features/chat/chat-read-query': {},
		'@/features/chat/chat-unread-query': {},
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	};
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return {
		state,
		post: (imageUrl = null) =>
			module.exports.POST(
				new Request('https://example.invalid', {
					method: 'POST',
					headers: { 'Idempotency-Key': key },
					body: JSON.stringify({ body: 'Hello', imageUrl, mentionMemberIds: [mentionedId] }),
				}),
				{ code: 'MTE8PZAT' },
			),
	};
}

test('concurrent claimed retries commit one chat message and replay one response', async () => {
	const { state, post } = harness();
	const responses = await Promise.all([post(), post()]);
	const bodies = await Promise.all(responses.map((response) => response.json()));
	assert.deepEqual(bodies[0], bodies[1]);
	assert.equal(state.messages.length, 1);
	assert.equal(state.mentions.length, 1);
	assert.equal(state.audits, 1);
	assert.equal(state.notifications, 2);
});

test('failed replay write rolls back message and mentions before a safe retry', async () => {
	const { state, post } = harness();
	state.failReplayWrite = true;
	await assert.rejects(post(), /cache_write_failed/);
	assert.equal(state.messages.length, 0);
	assert.equal(state.mentions.length, 0);
	assert.equal(state.notifications, 0);
	assert.match(state.releaseWhere, /expires_at/, JSON.stringify(state.errors));
	assert.match(state.releaseWhere, /_claimed/);
	assert.equal(state.slot, null);
	state.failReplayWrite = false;
	assert.equal((await post()).status, 200);
	assert.equal(state.messages.length, 1);
	assert.equal(state.claims, 2);
});

test('malformed claim cannot authorize a chat insert', async () => {
	const { state, post } = harness();
	state.slot = { _claimed: true, extra: 1 };
	await assert.rejects(post(), /idempotency_claim_invalid/);
	assert.equal(state.messages.length, 0);
});

test('uncertain COMMIT outcome keeps the claim fail-closed', async () => {
	const { state, post } = harness();
	state.failCommit = true;
	await assert.rejects(post(), /commit_outcome_unknown/);
	assert.deepEqual(state.slot, { _claimed: true });
	assert.equal(state.releaseWhere, '');
	assert.equal(state.notifications, 0);
});

test('failed warning enrichment leaves replay base response unchanged', async () => {
	const { state, post } = harness();
	state.warning = 'notification_delivery_failed';
	state.warningUpdateSucceeds = false;
	const first = await (await post()).json();
	const replay = await (await post()).json();
	assert.equal(first.warning, null);
	assert.equal(replay.warning, null);
	assert.equal(state.messages.length, 1);
	assert.equal(state.notifications, 2);
	assert.match(state.warningWhere, /expires_at/);
	assert.match(state.warningWhere, /message/);
	assert.match(state.warningWhere, /warning/);
});

test('persisted notification warning is replayed without a second dispatch', async () => {
	const { state, post } = harness();
	state.warning = 'notification_delivery_failed';
	const first = await (await post()).json();
	const replay = await (await post()).json();
	assert.equal(first.warning, state.warning);
	assert.equal(replay.warning, state.warning);
	assert.equal(state.messages.length, 1);
	assert.equal(state.notifications, 2);
});

test('revoked private image attachment returns 409 and creates no chat row', async () => {
	const { state, post } = harness();
	state.rejectImageAttachment = true;
	const response = await post(
		'https://app.example/api/upload/read?key=manawg%2F44444444-4444-4444-8444-444444444444%2Fannouncement%2F55555555-5555-4555-8555-555555555555.jpg',
	);
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: 'image_removed', code: 'image_removed' });
	assert.equal(state.messages.length, 0);
	assert.equal(state.notifications, 0);
	assert.ok(state.locks > 0);
});
