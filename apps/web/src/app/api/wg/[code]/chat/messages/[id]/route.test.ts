import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { PgDialect, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const id = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const wgId = '44444444-4444-4444-8444-444444444444';

const wgChatMessages = pgTable('wg_chat_messages', {
	id: uuid('id'),
	wgId: uuid('wg_id'),
	senderMemberId: uuid('sender_member_id'),
	kind: text('kind'),
	body: text('body'),
	deletedAt: timestamp('deleted_at', { withTimezone: true }),
	editedAt: timestamp('edited_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }),
});

const state = { updateWhere: '', updateRows: [] as unknown[], audits: 0 };

const db = {
	select: () => ({
		from: () => ({
			where: () => ({
				limit: async () => [
					{ id, senderMemberId: memberId, kind: 'text', deletedAt: null, createdAt: new Date() },
				],
			}),
		}),
	}),
	update: () => ({
		set: () => ({
			where: (condition: never) => ({
				returning: async () => {
					state.updateWhere = new PgDialect().sqlToQuery(condition).sql;
					return state.updateRows;
				},
			}),
		}),
	}),
};

mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => state.audits++ } });
mock.module('@/core/db', { namedExports: { db, wgChatMessages } });
mock.module('@/core/db/private-image-deletions', {
	namedExports: { revokePrivateImageIfUnreferenced: async () => undefined },
});
mock.module('@/core/db/transaction', {
	namedExports: { lockExpensePayments: async () => undefined, withTransaction: async () => null },
});
mock.module('@/core/guards/admin', { namedExports: { requireOwnerOrAdmin: async () => null } });
mock.module('@/core/guards/api-auth', { namedExports: { UUID_PATTERN: /^[0-9a-f-]{36}$/i } });
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: wgId },
			member: { memberId, name: 'Member' },
		}),
	},
});
mock.module('@/core/guards/with-wg-route', {
	namedExports: {
		withWgRoute:
			(_label: string, handler: (req: Request, params: unknown) => unknown) =>
			async (req: Request, ctx: { params: Promise<unknown> }) =>
				handler(req, await ctx.params),
	},
});
mock.module('@/core/rate-limit', {
	namedExports: { wgWriteLimiter: {}, checkRateLimit: async () => ({ success: true }) },
});

const { PATCH } = await import('./route');

function patch() {
	return PATCH(
		new Request('https://example.invalid', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ body: 'neuer Text' }),
		}) as never,
		{ params: Promise.resolve({ code: 'MTE8PZAT', id }) } as never,
	);
}

test('an edit that loses the race against a delete answers 409 and writes no audit event', async () => {
	state.updateRows = [];
	state.audits = 0;
	const response = await patch();
	assert.equal(response.status, 409);
	assert.equal(((await response.json()) as { error: string }).error, 'message_deleted');
	assert.equal(state.audits, 0);
	// The UPDATE itself must refuse deleted rows, other authors and non-text messages.
	assert.match(state.updateWhere, /"deleted_at" is null/);
	assert.match(state.updateWhere, /"sender_member_id" = \$/);
	assert.match(state.updateWhere, /"kind" = \$/);
});

test('an edit of a live message still succeeds', async () => {
	state.updateRows = [{ id, body: 'neuer Text' }];
	state.audits = 0;
	const response = await patch();
	assert.equal(response.status, 200);
	assert.equal(state.audits, 1);
});
