import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = 'src/app/api/wg/[code]/chat/read/route.ts';

const memberId = '22222222-2222-4222-8222-222222222222';
const messageId = '11111111-1111-4111-8111-111111111111';

function loadTs(file, overrides = {}) {
	const source = transpileModule(readFileSync(path.join(process.cwd(), file), 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

function harness({ deleteRows = [], upsertRows = [{ memberId }], messageExists = true } = {}) {
	const state = { deletes: 0, upserts: [], deleteRows, upsertRows, messageExists };

	const wgChatReads = {};
	const wgChatMessages = {};

	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => (state.messageExists ? [{ id: messageId }] : []),
				}),
			}),
		}),
		delete: (table) => ({
			where: () => ({
				returning: async () => {
					assert.equal(table, wgChatReads, 'a reset must target the read-marker row');
					state.deletes += 1;
					return state.deleteRows;
				},
			}),
		}),
		insert: (table) => ({
			values: (value) => ({
				onConflictDoUpdate: (options) => ({
					returning: async () => {
						assert.equal(table, wgChatReads);
						state.upserts.push({ value, options });
						return state.upsertRows;
					},
				}),
			}),
		}),
	};

	const { POST } = loadTs(routePath, {
		'@/core/db': { db, wgChatMessages, wgChatReads },
		'@/core/errors': {
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			notFound: (error) => Response.json({ error }, { status: 404 }),
			tooMany: () => Response.json({ error: 'rate_limited' }, { status: 429 }),
		},
		'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId, name: 'Member', verified: true },
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/rate-limit': { chatReadLimiter: {}, checkRateLimit: async () => ({ success: true }) },
		'@/features/chat/chat-read-query': loadTs('src/features/chat/chat-read-query.ts'),
		'drizzle-orm': { and: () => null, eq: () => null },
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	});

	return {
		state,
		post: (lastReadMessageId) =>
			POST(
				new Request('https://example.invalid', {
					method: 'POST',
					body: JSON.stringify({ lastReadMessageId }),
				}),
				{ code: 'MTE8PZAT' },
			),
	};
}

test('a null read marker resets the row and reports whether anything changed', async () => {
	const missing = harness({ deleteRows: [] });
	const missingResponse = await missing.post(null);
	const missingBody = await missingResponse.json();
	assert.equal(missingResponse.status, 200, JSON.stringify(missingBody));
	assert.deepEqual(missingBody, { ok: true, applied: false });
	assert.equal(missing.state.deletes, 1, 'the reset must delete the stored marker');
	assert.equal(missing.state.upserts.length, 0, 'a null marker must not ride the guarded upsert');

	const stored = harness({ deleteRows: [{ memberId }] });
	const storedResponse = await stored.post(null);
	const storedBody = await storedResponse.json();
	assert.equal(storedResponse.status, 200, JSON.stringify(storedBody));
	assert.deepEqual(storedBody, { ok: true, applied: true });
	assert.equal(stored.state.deletes, 1);
});

test('an upsert that matches zero rows does not claim the marker was saved', async () => {
	const unchanged = harness({ upsertRows: [] });
	const unchangedResponse = await unchanged.post(messageId);
	const unchangedBody = await unchangedResponse.json();
	assert.equal(unchangedResponse.status, 200, JSON.stringify(unchangedBody));
	assert.deepEqual(unchangedBody, { ok: true, applied: false });
	assert.equal(unchanged.state.upserts.length, 1);
	assert.ok(
		unchanged.state.upserts[0].options.setWhere,
		'the advance path keeps the forward-only setWhere guard',
	);

	const advanced = harness({ upsertRows: [{ memberId }] });
	const advancedResponse = await advanced.post(messageId);
	const advancedBody = await advancedResponse.json();
	assert.equal(advancedResponse.status, 200, JSON.stringify(advancedBody));
	assert.deepEqual(advancedBody, { ok: true, applied: true });
});

test('a marker for a message outside the WG is still rejected', async () => {
	const route = harness({ messageExists: false });
	const response = await route.post(messageId);
	assert.equal(response.status, 404);
	assert.equal((await response.json()).error, 'message_not_found');
	assert.equal(route.state.deletes, 0);
	assert.equal(route.state.upserts.length, 0);
});
