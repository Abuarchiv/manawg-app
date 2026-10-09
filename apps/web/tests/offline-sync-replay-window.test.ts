import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
	type Action,
	OFFLINE_REPLAY_MAX_AGE_MS,
	RESPONSE_REPLAY_TTL_SECONDS,
	VALID_KEY,
	createAction,
	deferred,
	makeLockManager,
	makeQueueModule,
	makeStorage,
	restoreGlobals,
	setQueue,
} from './support/offline-harness.ts';

afterEach(restoreGlobals);

test('expired replay windows fence automatic and forced sync before upload or mutation', async () => {
	const now = Date.parse('2026-10-10T12:00:00Z');
	class Clock extends Date {
		static override now() {
			return now;
		}
	}
	for (const force of [false, true]) {
		for (const attempts of [undefined, 3]) {
			let requests = 0;
			let uploads = 0;
			const storage = makeStorage();
			const { module } = await makeQueueModule({
				clock: Clock,
				storage,
				apiFetch: async () => {
					requests += 1;
					return { ok: true, data: {} };
				},
				images: {
					uploadPendingImageToken: async () => {
						uploads += 1;
						return 'https://app.invalid/image';
					},
				},
			});
			const action = createAction({
				type: 'expense.create',
				createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
				...(attempts === undefined
					? {}
					: { attempts, lastAttemptAt: new Date(now - 1000).toISOString() }),
				payload: {
					description: 'Old expense',
					amountCents: 100,
					paidByMemberId: 'member-a',
					splits: [{ debtorMemberId: 'member-b', amountCents: 100 }],
					imageUrl: 'manawg-pending-image:receipt',
				},
			});
			// Direct storage models a crash before attempts/lastAttemptAt could be persisted.
			storage.setItem('manawg:offline-actions', JSON.stringify([action]));
			assert.equal(await module.syncOfflineActions('TEST1234', { memberId: 'member-a', force }), 0);
			assert.equal(requests, 0);
			assert.equal(uploads, 0);
			const retained = module.readOfflineQueue()[0];
			assert.equal(retained.idempotencyKey, action.idempotencyKey);
			assert.equal(JSON.stringify(retained.payload), JSON.stringify(action.payload));
			assert.match(retained.lastError, /^Server prüfen:/);
			assert.match(retained.lastError, /Wiederholungsfrist ist abgelaufen/);
			assert.equal(module.needsManualOfflineResolution(retained), true);
		}
	}
});

test('replay fence includes the retention boundary and invalid clocks but tolerates small future skew', async () => {
	const now = Date.parse('2026-10-10T12:00:00Z');
	class Clock extends Date {
		static override now() {
			return now;
		}
	}
	for (const [createdAt, expectedRequests] of [
		[new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(), 0],
		[new Date(now - RESPONSE_REPLAY_TTL_SECONDS * 1000 + 1).toISOString(), 0],
		[new Date(now - OFFLINE_REPLAY_MAX_AGE_MS).toISOString(), 0],
		[new Date(now - OFFLINE_REPLAY_MAX_AGE_MS + 1).toISOString(), 1],
		['invalid', 0],
		[new Date(now + 24 * 60 * 60 * 1000).toISOString(), 0],
		[new Date(now + 60 * 1000).toISOString(), 1],
	]) {
		let requests = 0;
		const { module } = await makeQueueModule({
			clock: Clock,
			apiFetch: async () => {
				requests += 1;
				return { ok: true, data: {} };
			},
		});
		await setQueue(module, [createAction({ createdAt })]);
		await module.syncOfflineActions('TEST1234', { memberId: 'member-a', force: true });
		assert.equal(requests, expectedRequests, String(createdAt));
	}
});

test('replay window is rechecked after an upload crosses the deadline', async () => {
	let now = Date.parse('2026-10-10T12:00:00Z');
	class Clock extends Date {
		static override now() {
			return now;
		}
	}
	let requests = 0;
	const { module } = await makeQueueModule({
		clock: Clock,
		apiFetch: async () => {
			requests += 1;
			return { ok: true, data: {} };
		},
		images: {
			uploadPendingImageToken: async () => {
				now += 2;
				return 'https://app.invalid/image';
			},
		},
	});
	await setQueue(module, [
		createAction({
			createdAt: new Date(now - OFFLINE_REPLAY_MAX_AGE_MS + 1).toISOString(),
			payload: { content: 'receipt', kind: 'info', imageUrl: 'manawg-pending-image:receipt' },
		}),
	]);
	await module.syncOfflineActions('TEST1234', { memberId: 'member-a', force: true });
	assert.equal(requests, 0);
	assert.equal(module.readOfflineQueue().length, 1);
	assert.match(module.readOfflineQueue()[0].lastError, /^Server prüfen:/);
});

test('sync does not resurrect an action deleted while its request waits', async () => {
	const entered = deferred();
	const response = deferred();
	const { module } = await makeQueueModule({
		apiFetch: async () => {
			entered.resolve();
			return response.promise;
		},
	});
	await setQueue(module, [createAction()]);
	const syncing = module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	await entered.promise;
	await setQueue(module, []);
	response.resolve({ ok: false, status: 0, error: 'network' });
	await syncing;
	assert.equal(module.readOfflineQueue().length, 0);
});

test('sync preserves an action edit made while its request waits', async () => {
	const entered = deferred();
	const response = deferred();
	let requestCount = 0;
	const { module } = await makeQueueModule({
		apiFetch: async () => {
			requestCount += 1;
			entered.resolve();
			return response.promise;
		},
	});
	await setQueue(module, [createAction()]);
	const syncing = module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	await entered.promise;
	await setQueue(module, [
		createAction({ payload: { content: 'edited', kind: 'info', imageUrl: null } }),
	]);
	response.resolve({ ok: false, status: 0, error: 'network' });
	await syncing;
	assert.equal(module.readOfflineQueue()[0].payload.content, 'edited');
	assert.match(module.readOfflineQueue()[0].lastError, /^Server prüfen:/);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(requestCount, 1);
});

test('a successful old request cannot hide a concurrent edit when final storage save fails', async () => {
	const entered = deferred();
	const response = deferred();
	const storage = makeStorage();
	let failQueueSave = false;
	storage.setItem = (key, value) => {
		if (failQueueSave && key === 'manawg:offline-actions') throw new Error('quota');
		storage.values.set(key, String(value));
	};
	const { module } = await makeQueueModule({
		storage,
		apiFetch: async () => {
			entered.resolve();
			return response.promise;
		},
	});
	await setQueue(module, [createAction()]);
	const syncing = module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	await entered.promise;
	await setQueue(module, [
		createAction({ payload: { content: 'edited', kind: 'info', imageUrl: null } }),
	]);
	failQueueSave = true;
	response.resolve({ ok: true, data: undefined });
	await syncing;
	const edited = module.readOfflineQueue()[0];
	assert.equal(edited.payload.content, 'edited');
	assert.equal(edited.idempotencyKey, VALID_KEY);
	assert.match(edited.lastError, /^Server prüfen:/);
	const reloaded = await makeQueueModule({
		storage,
		apiFetch: async () => {
			throw new Error('review-required action must not replay');
		},
	});
	assert.match(reloaded.module.readOfflineQueue()[0].lastError, /^Server prüfen:/);
	await reloaded.module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	failQueueSave = false;
	await setQueue(reloaded.module, []);
	assert.equal(storage.getItem('manawg:offline-review-ids'), '{}');
	await setQueue(reloaded.module, [
		createAction({ payload: { content: 'replacement', kind: 'info', imageUrl: null } }),
	]);
	assert.equal(reloaded.module.readOfflineQueue()[0].lastError, undefined);
});

test('failed final queue read marks a successful action for review after storage recovers', async () => {
	const storage = makeStorage();
	const locks = makeLockManager();
	const getItem = storage.getItem.bind(storage);
	let failQueueRead = false;
	let requests = 0;
	storage.getItem = (key) => {
		if (failQueueRead && key === 'manawg:offline-actions')
			throw new Error('temporary read failure');
		return getItem(key);
	};
	const { module } = await makeQueueModule({
		storage,
		locks,
		apiFetch: async () => {
			requests += 1;
			failQueueRead = true;
			return { ok: true, data: undefined };
		},
	});
	await setQueue(module, [createAction()]);
	assert.equal(
		await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' }),
		1,
	);
	failQueueRead = false;
	const recovered = module.readOfflineQueue()[0];
	assert.equal(recovered.payload.content, 'original');
	assert.match(recovered.lastError, /^Server prüfen:/);
	assert.equal(module.needsManualOfflineResolution(recovered), true);
	assert.equal(
		await module.updateOfflineQueue((actions) =>
			actions.map((action) =>
				action.id === 'action-1'
					? { ...action, payload: { ...action.payload, content: 'edited' } }
					: action,
			),
		),
		true,
	);
	assert.equal(module.readOfflineQueue()[0].payload.content, 'edited');
	assert.match(module.readOfflineQueue()[0].lastError, /^Server prüfen:/);
	assert.equal(
		await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' }),
		0,
	);
	assert.equal(requests, 1);
});

test('failed final save does not resend a synced recurring expense', async () => {
	const storage = makeStorage();
	let primaryRequestDone = false;
	storage.setItem = (key, value) => {
		if (primaryRequestDone && key === 'manawg:offline-actions') throw new Error('quota');
		storage.values.set(key, String(value));
	};
	let calls = 0;
	const { module } = await makeQueueModule({
		storage,
		apiFetch: async (_path, init) => {
			calls += 1;
			if (init.method === 'PATCH') return { ok: false, status: 503, error: 'unavailable' };
			primaryRequestDone = true;
			return { ok: true, data: undefined };
		},
	});
	await setQueue(module, [
		createAction({
			type: 'expense.create',
			payload: {
				description: 'Miete',
				amountCents: 100,
				paidByMemberId: 'member-a',
				splits: [{ debtorMemberId: 'member-a', amountCents: 100 }],
				imageUrl: null,
				recurringExpenseId: 'recurring-1',
				expectedRecurringNextDueAt: '2026-10-01T00:00:00.000Z',
			},
		}),
	]);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(calls, 1);
	assert.equal(module.readOfflineQueue().length, 0);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(calls, 1);
});

test('a recurring advance action is not followed by a second advance request', async () => {
	let calls = 0;
	const { module } = await makeQueueModule({
		apiFetch: async () => {
			calls += 1;
			return { ok: true, data: undefined };
		},
	});
	await setQueue(module, [
		createAction({
			type: 'recurring.advance',
			payload: {
				recurringExpenseId: 'recurring-1',
				expectedRecurringNextDueAt: '2026-10-01T00:00:00.000Z',
			},
		}),
	]);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(calls, 1);
});

test('queued PATCH keeps its idempotency key and expected member in the request', async () => {
	let request: Action | undefined;
	const { module } = await makeQueueModule({
		apiFetch: async (_path, init) => {
			request = init;
			return { ok: true, data: undefined };
		},
	});
	await setQueue(module, [
		createAction({
			type: 'shopping.update',
			payload: {
				itemId: 'item-1',
				name: 'Milch',
				bought: true,
				expectedUpdatedAt: '2026-09-27T09:00:00.000Z',
				expectedBoughtAt: null,
			},
		}),
	]);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(request?.headers['Idempotency-Key'], VALID_KEY);
	assert.equal(request?.memberId, 'member-a');
});

test('connection failures keep no backoff while server errors do', async () => {
	for (const [status, backedOff] of [
		[0, false],
		[500, true],
	] as const) {
		let requests = 0;
		const { module } = await makeQueueModule({
			apiFetch: async () => {
				requests += 1;
				return { ok: false, status, error: status === 0 ? 'Netzwerkfehler' : 'boom' };
			},
		});
		await setQueue(module, [createAction()]);
		await module.syncOfflineActions('TEST1234', { memberId: 'member-a' });
		const retained = module.readOfflineQueue()[0];
		assert.equal(retained.attempts, backedOff ? 1 : undefined, String(status));
		assert.equal(retained.lastAttemptAt === undefined, !backedOff, String(status));
		// The harness stubs shouldRetryOfflineAction, so the backoff itself is read from the fields.
		await module.syncOfflineActions('TEST1234', { memberId: 'member-a' });
		assert.equal(requests, 2, String(status));
	}
});

test('upload network errors keep no backoff', async () => {
	const { module } = await makeQueueModule({
		images: {
			uploadPendingImageToken: async () => {
				throw new TypeError('Failed to fetch');
			},
		},
	});
	await setQueue(module, [
		createAction({
			payload: { content: 'receipt', kind: 'info', imageUrl: 'manawg-pending-image:receipt' },
		}),
	]);
	await module.syncOfflineActions('TEST1234', { memberId: 'member-a' });
	assert.equal(module.readOfflineQueue()[0].attempts, undefined);
});
