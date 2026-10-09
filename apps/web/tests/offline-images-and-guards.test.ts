import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import {
	type Action,
	createAction,
	deferred,
	makeQueueModule,
	makeStorage,
	readStoredQueue,
	restoreGlobals,
	setGlobal,
	setQueue,
} from './support/offline-harness.ts';

// biome-ignore lint/suspicious/noExplicitAny: hand-rolled IndexedDB fake
type Loose = any;

afterEach(restoreGlobals);

function fakeIndexedDb(records: Map<string, Loose>) {
	return {
		open() {
			const request: Loose = {
				result: null,
				onupgradeneeded: null,
				onsuccess: null,
				onerror: null,
			};
			request.result = {
				objectStoreNames: { contains: () => true },
				createObjectStore() {},
				close() {},
				transaction() {
					const tx: Loose = { oncomplete: null, onerror: null, error: null };
					const makeRequest = (run: () => unknown) => {
						const req: Loose = { result: undefined, error: null, onsuccess: null, onerror: null };
						queueMicrotask(() => {
							try {
								req.result = run();
								req.onsuccess?.();
								queueMicrotask(() => tx.oncomplete?.());
							} catch (error) {
								req.error = error;
								tx.error = error;
								req.onerror?.();
								tx.onerror?.();
							}
						});
						return req;
					};
					tx.objectStore = () => ({
						get: (key: string) => makeRequest(() => records.get(key)),
						put: (value: Loose, key: string) =>
							makeRequest(() => {
								records.set(key, value);
								return key;
							}),
						delete: (key: string) => makeRequest(() => records.delete(key)),
					});
					return tx;
				},
			};
			queueMicrotask(() => request.onsuccess?.());
			return request;
		},
	};
}

test('resolved upload URL is persisted to the queue before its IndexedDB blob is deleted', async () => {
	const pendingToken = 'manawg-pending-image:pic';
	const publicUrl = 'https://app.invalid/api/upload/read?key=uploaded';
	const records = new Map([
		[
			'pic',
			{
				id: 'pic',
				file: new Blob(['abc'], { type: 'image/png' }),
				name: 'pic.png',
				type: 'image/png',
				size: 3,
				shareCode: 'TEST1234',
				memberId: 'member-a',
				purpose: 'announcement',
				createdAt: '2026-09-27T10:00:00.000Z',
			},
		],
	]);
	const indexedDB = fakeIndexedDb(records);
	setGlobal('indexedDB', indexedDB);
	setGlobal('fetch', async (url: string) =>
		url === '/api/upload/sign'
			? Response.json({
					presignedUrl: 'https://storage.invalid/upload',
					publicUrl,
					maxFileSize: 100,
				})
			: new Response(null, { status: 200 }),
	);
	const storage = makeStorage();
	let queueAtRequest: Action[] | undefined;
	const { module } = await makeQueueModule({
		storage,
		// The real image store runs against the fake IndexedDB above.
		images: null,
		apiFetch: async (_path, init) => {
			queueAtRequest = readStoredQueue(storage);
			return { ok: false, status: 0, error: 'network', signal: init.signal };
		},
	});
	await setQueue(module, [
		createAction({ payload: { content: 'with image', kind: 'info', imageUrl: pendingToken } }),
	]);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(queueAtRequest?.[0]?.payload.imageUrl, publicUrl);
	assert.equal(module.readOfflineQueue()[0].payload.imageUrl, publicUrl);
	assert.equal(records.has('pic'), false);
});

test('delete or edit during attachment cleanup stops the stale network request', async () => {
	for (const change of ['delete', 'edit']) {
		const cleanupStarted = deferred();
		const cleanupRelease = deferred();
		let requestCount = 0;
		const { module } = await makeQueueModule({
			apiFetch: async () => {
				requestCount += 1;
				return { ok: true, data: undefined };
			},
			images: {
				uploadPendingImageToken: async () => 'https://app.invalid/image',
				removePendingImage: async () => {
					cleanupStarted.resolve();
					await cleanupRelease.promise;
				},
			},
		});
		await setQueue(module, [
			createAction({
				payload: { content: 'original', kind: 'info', imageUrl: 'manawg-pending-image:pic' },
			}),
		]);
		const syncing = module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
		await cleanupStarted.promise;
		if (change === 'delete') {
			await setQueue(module, []);
		} else {
			const current = module.readOfflineQueue()[0];
			await setQueue(module, [{ ...current, payload: { ...current.payload, content: 'edited' } }]);
		}
		cleanupRelease.resolve();
		await syncing;
		assert.equal(requestCount, 0);
	}
});

test('edit during image upload keeps the replacement and does not send the stale snapshot', async () => {
	const uploadStarted = deferred();
	const uploadResponse = deferred();
	let requests = 0;
	let removals = 0;
	const { module } = await makeQueueModule({
		apiFetch: async () => {
			requests += 1;
			return { ok: true, data: undefined };
		},
		images: {
			uploadPendingImageToken: async () => {
				uploadStarted.resolve();
				return uploadResponse.promise;
			},
			removePendingImage: async () => {
				removals += 1;
			},
		},
	});
	await setQueue(module, [
		createAction({
			payload: { content: 'original', kind: 'info', imageUrl: 'manawg-pending-image:pic' },
		}),
	]);
	const syncing = module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	await uploadStarted.promise;
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
	uploadResponse.resolve('https://app.invalid/image');
	await syncing;
	assert.equal(requests, 0);
	assert.equal(removals, 0);
	assert.equal(module.readOfflineQueue()[0].payload.content, 'edited');
	assert.equal(module.readOfflineQueue()[0].payload.imageUrl, 'manawg-pending-image:pic');
});

test('aborting after an auth change stops later requests and keeps all queue entries', async () => {
	const entered = deferred();
	let requestCount = 0;
	const { module } = await makeQueueModule({
		apiFetch: async (_path, init) => {
			requestCount += 1;
			entered.resolve();
			return new Promise((resolve) => {
				init.signal.addEventListener(
					'abort',
					() => resolve({ ok: false, status: 0, error: 'aborted' }),
					{ once: true },
				);
			});
		},
	});
	await setQueue(module, [
		createAction(),
		createAction({ id: 'action-2', payload: { content: 'second', kind: 'info', imageUrl: null } }),
	]);
	const controller = new AbortController();
	const syncing = module.syncOfflineActions('TEST1234', {
		force: true,
		memberId: 'member-a',
		signal: controller.signal,
	});
	await entered.promise;
	controller.abort();
	await syncing;
	assert.equal(requestCount, 1);
	assert.equal(module.readOfflineQueue().length, 2);
});

test('missing and revoked image blobs stay visible and are never silently dropped', async () => {
	let requestCount = 0;
	const pendingAction = createAction({
		payload: { content: 'with image', kind: 'info', imageUrl: 'manawg-pending-image:missing' },
	});
	const { module } = await makeQueueModule({
		apiFetch: async () => {
			requestCount += 1;
			return { ok: true, data: undefined };
		},
		images: {
			uploadPendingImageToken: async () => {
				throw new Error('pending-image-missing');
			},
		},
	});
	await setQueue(module, [pendingAction]);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(module.readOfflineQueue()[0].payload.imageUrl, 'manawg-pending-image:missing');
	assert.match(module.readOfflineQueue()[0].lastError, /^Bild fehlt:/);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(requestCount, 0);
	await setQueue(module, [
		{
			...module.readOfflineQueue()[0],
			payload: { ...module.readOfflineQueue()[0].payload, imageUrl: null },
		},
	]);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(requestCount, 1);

	let revokedRequests = 0;
	const revoked = await makeQueueModule({
		apiFetch: async () => {
			revokedRequests += 1;
			return { ok: true, data: undefined };
		},
		images: {
			uploadPendingImageToken: async () => {
				throw new Error('sign-failed:409:image_removed');
			},
		},
	});
	await setQueue(revoked.module, [
		createAction({
			id: 'revoked',
			payload: { content: 'with image', kind: 'info', imageUrl: 'manawg-pending-image:revoked' },
		}),
	]);
	await revoked.module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.match(revoked.module.readOfflineQueue()[0].lastError, /^Bild wurde entfernt:/);
	await revoked.module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(revokedRequests, 0);
});

test('server image_removed retains payload and supports explicit removal after rejection', async () => {
	const publicUrl = 'https://app.invalid/api/upload/read?key=revoked';
	let requestCount = 0;
	const { module } = await makeQueueModule({
		apiFetch: async () => {
			requestCount += 1;
			return requestCount === 1
				? { ok: false, status: 409, error: 'image_removed' }
				: { ok: true, data: undefined };
		},
	});
	await setQueue(module, [
		createAction({ payload: { content: 'with image', kind: 'info', imageUrl: publicUrl } }),
	]);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	const blocked = module.readOfflineQueue()[0];
	assert.equal(blocked.payload.imageUrl, publicUrl);
	assert.match(blocked.lastError, /^Bild wurde entfernt:/);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(requestCount, 1);
	await setQueue(module, [{ ...blocked, payload: { ...blocked.payload, imageUrl: null } }]);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(requestCount, 2);
	assert.equal(module.readOfflineQueue().length, 0);

	const entered = deferred();
	const response = deferred();
	let racedRequestCount = 0;
	const raced = await makeQueueModule({
		apiFetch: async () => {
			racedRequestCount += 1;
			if (racedRequestCount === 1) {
				entered.resolve();
				return response.promise;
			}
			return { ok: true, data: undefined };
		},
	});
	await setQueue(raced.module, [
		createAction({ payload: { content: 'with image', kind: 'info', imageUrl: publicUrl } }),
	]);
	const syncing = raced.module.syncOfflineActions('TEST1234', {
		force: true,
		memberId: 'member-a',
	});
	await entered.promise;
	const current = raced.module.readOfflineQueue()[0];
	await setQueue(raced.module, [{ ...current, payload: { ...current.payload, imageUrl: null } }]);
	response.resolve({ ok: false, status: 409, error: 'image_removed' });
	await syncing;
	assert.equal(raced.module.readOfflineQueue()[0].payload.imageUrl, null);
	assert.doesNotMatch(raced.module.readOfflineQueue()[0].lastError ?? '', /^Server prüfen:/);
	await raced.module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(racedRequestCount, 2);
	assert.equal(raced.module.readOfflineQueue().length, 0);
});

test('API client sends only the expected member header, never a member id or token', async () => {
	let sentHeaders: Headers | undefined;
	let sentSignal: AbortSignal | undefined;
	setGlobal('fetch', async (_path: string, init: RequestInit) => {
		sentHeaders = new Headers(init.headers);
		sentSignal = init.signal as AbortSignal;
		return new Response(null, { status: 204 });
	});
	const api = await import('../src/core/infra/api-client.ts');
	const controller = new AbortController();
	await api.apiFetch('/api/wg/TEST1234/announcements', {
		method: 'POST',
		memberId: 'member-a',
		body: '{}',
		signal: controller.signal,
	});
	assert.equal(sentHeaders?.get('x-manawg-expected-member-id'), 'member-a');
	assert.equal(sentHeaders?.has('x-manawg-member-id'), false);
	assert.equal(sentHeaders?.has('x-manawg-member-token'), false);
	assert.notEqual(sentSignal, controller.signal);
	controller.abort();
	assert.equal(sentSignal?.aborted, true);
});

test('server guard rejects a stale expected member only after cookie membership lookup', async () => {
	let authenticated = false;
	let membershipResolved = false;
	mock.module('@/core/auth/server', {
		namedExports: {
			getAuthenticatedUser: async () => {
				authenticated = true;
				return { id: 'user-a' };
			},
		},
	});
	mock.module('@/core/db', {
		namedExports: {
			db: {
				query: {
					wgMembers: {
						findFirst: async () => {
							membershipResolved = true;
							return { id: 'member-a', name: 'A', deactivatedAt: null };
						},
					},
				},
			},
			wgMembers: {},
		},
	});
	mock.module('@/core/http/api-errors', {
		namedExports: {
			HTTP: { UNAUTHORIZED: 401, CONFLICT: 409, SERVICE_UNAVAILABLE: 503 },
			apiError: (code: string, status: number) => ({ code, status }),
		},
	});
	mock.module('@/core/infra/observability', { namedExports: { logApiError() {} } });
	mock.module('drizzle-orm', {
		namedExports: {
			and: (...args: unknown[]) => args,
			eq: (...args: unknown[]) => args,
		},
	});
	const guard = await import('../src/core/guards/api-auth.ts');
	const request = (expectedMember: string) =>
		({
			method: 'POST',
			headers: {
				get: (name: string) => (name === 'x-manawg-expected-member-id' ? expectedMember : null),
			},
		}) as never;
	const result: Action = await guard.requireMember(request('member-b'), 'wg-1');
	assert.equal(authenticated, true);
	assert.equal(membershipResolved, true);
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'member_context_changed');
	assert.deepEqual(result.response, { code: 'member_context_changed', status: 409 });
	const matching: Action = await guard.requireMember(request('member-a'), 'wg-1');
	assert.equal(matching.ok, true);
	assert.equal(matching.member.memberId, 'member-a');
});

test('offline data is visible only for the currently bound local account', async () => {
	const identities = new Map([
		['wg-1', { memberId: 'member-a', authUserId: 'user-a' }],
		['wg-2', { memberId: 'member-b' }],
	]);
	const { module } = await makeQueueModule({
		identity: (wgId) => identities.get(wgId ?? '') ?? null,
	});
	assert.equal(typeof module.filterOfflineActionsForAuthUser, 'function');
	const scoped = [
		createAction(),
		createAction({ id: 'legacy', wgId: 'wg-2', memberId: 'member-b' }),
		createAction({ id: 'unscoped', wgId: undefined }),
	];
	assert.equal(module.filterOfflineActionsForAuthUser(scoped, 'user-a').length, 1);
	assert.equal(module.filterOfflineActionsForAuthUser(scoped, 'user-b').length, 0);
	assert.equal(module.filterOfflineActionsForAuthUser(scoped, null).length, 0);
});

test('a synced queue entry no longer counts as queued for an open queue edit', async () => {
	const { module } = await makeQueueModule({ apiFetch: async () => ({ ok: true, data: {} }) });
	await setQueue(module, [createAction()]);
	assert.equal(module.isOfflineActionQueued('action-1'), true);
	await module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	assert.equal(module.isOfflineActionQueued('action-1'), false);
});

test('a stalled image upload times out so the next sync is not blocked', async () => {
	const records = new Map([
		[
			'pic',
			{
				id: 'pic',
				file: new Blob(['abc'], { type: 'image/png' }),
				name: 'pic.png',
				type: 'image/png',
				size: 3,
				shareCode: 'TEST1234',
				memberId: 'member-a',
				purpose: 'announcement',
				createdAt: '2026-09-27T10:00:00.000Z',
			},
		],
	]);
	setGlobal('indexedDB', fakeIndexedDb(records));
	let sawSignal = false;
	setGlobal('fetch', async (url: string, init: { signal?: AbortSignal }) => {
		if (url === '/api/upload/sign') {
			return Response.json({ presignedUrl: 'https://storage.invalid/upload', publicUrl: 'x' });
		}
		sawSignal = init.signal instanceof AbortSignal;
		// The PUT never resolves on its own; only the timeout signal ends it.
		return new Promise((_resolve, reject) => {
			init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
		});
	});
	const realTimeout = AbortSignal.timeout.bind(AbortSignal);
	const timeoutMock = mock.method(AbortSignal, 'timeout', () => realTimeout(20));
	const { module } = await makeQueueModule({ images: null });
	await setQueue(module, [
		createAction({
			payload: { content: 'x', kind: 'info', imageUrl: 'manawg-pending-image:pic' },
		}),
	]);
	const sync = module.syncOfflineActions('TEST1234', { force: true, memberId: 'member-a' });
	await sync;
	timeoutMock.mock.restore();
	assert.equal(sawSignal, true);
	assert.equal(module.readOfflineQueue().length, 1);
});
