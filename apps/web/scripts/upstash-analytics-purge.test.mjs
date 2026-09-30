import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
	ATOMIC_DELETE_SCRIPT,
	createRedisClient,
	fingerprintMetadata,
	runBoundedPurge,
	safeErrorCode,
} from './upstash-analytics-purge.mjs';

const scanStart = Date.parse('2026-09-30T12:24:23.073Z');

function makeRecords(overrides = {}) {
	const rows = [
		{ key: `manawg:limiter-a:events:${scanStart - 3_600_000}`, type: 'zset', ttl: -1, zcard: 3 },
		{ key: `manawg:limiter-b:events:${scanStart - 1_800_000}`, type: 'zset', ttl: -1, zcard: 4 },
	];
	return rows.map((row) => ({ ...row, ...(overrides[row.key] ?? {}) }));
}

function makeBaseline(records = makeRecords()) {
	return {
		namespacePattern: 'manawg:*:events:*',
		scanStartedAt: new Date(scanStart).toISOString(),
		scanStartMs: scanStart,
		maxKeyCount: 2,
		keyCount: records.length,
		keyMetadataFingerprintSha256: fingerprintMetadata(records),
		typeCounts: { zset: records.length },
		ttlSecondsCounts: { '-1': records.length },
		zsetCardinalitySum: records.reduce((sum, row) => sum + row.zcard, 0),
		oldestBucketMs: scanStart - 3_600_000,
		newestBucketMs: scanStart - 1_800_000,
		confirmationLiteral: 'DELETE_TEST_ANALYTICS_KEYS',
	};
}

function fakeRedis(initialRecords = makeRecords(), { onScan, onRead, onEval } = {}) {
	let scanNumber = 0;
	let readNumber = 0;
	const evalCalls = [];
	const deletedKeys = [];
	const records = new Map(initialRecords.map((row) => [row.key, { ...row }]));
	return {
		evalCalls,
		deletedKeys,
		records,
		async scan(cursor, pattern) {
			assert.equal(pattern, 'manawg:*:events:*');
			assert.equal(String(cursor), '0');
			const selected = onScan ? onScan(++scanNumber, [...records.values()]) : [...records.values()];
			for (const row of selected) if (!records.has(row.key)) records.set(row.key, { ...row });
			return ['0', selected.map((row) => row.key)];
		},
		async type(key) {
			const row = records.get(key);
			const change = onRead?.('type', ++readNumber, key, row);
			return change?.type ?? row?.type ?? 'none';
		},
		async ttl(key) {
			const row = records.get(key);
			const change = onRead?.('ttl', readNumber, key, row);
			return change?.ttl ?? row?.ttl ?? -2;
		},
		async zcard(key) {
			const row = records.get(key);
			return row?.zcard ?? 0;
		},
		async eval(script, keys, args) {
			evalCalls.push({ script, keys: [...keys], args: [...args] });
			const reply = onEval
				? await onEval(script, keys, args, { records, deletedKeys })
				: ['DELETED', String(keys.length)];
			if (Array.isArray(reply) && reply[0] === 'DELETED') {
				for (const key of keys) {
					records.delete(key);
					deletedKeys.push(key);
				}
			}
			return reply;
		},
	};
}

class FakeSocket extends EventEmitter {
	writes = [];
	destroyed = false;

	write(chunk) {
		this.writes.push(String(chunk));
		return true;
	}

	end() {}

	destroy() {
		this.destroyed = true;
		return this;
	}
}

test('default dry run reports a bounded plan and never deletes', async () => {
	const records = makeRecords();
	const redis = fakeRedis(records);
	const summary = await runBoundedPurge({ redis, baseline: makeBaseline(records) });

	assert.equal(summary.mode, 'DRY_RUN');
	assert.equal(summary.candidateCount, 2);
	assert.equal(summary.deletedCount, 0);
	assert.equal(redis.evalCalls.length, 0);
	for (const row of records) assert.equal(JSON.stringify(summary).includes(row.key), false);
});

test('execution without the exact confirmation literal never deletes', async () => {
	const records = makeRecords();
	const redis = fakeRedis(records);
	await assert.rejects(
		runBoundedPurge({ redis, baseline: makeBaseline(records), execute: true, confirmation: 'yes' }),
		/explicit_confirmation_required/,
	);
	assert.equal(redis.evalCalls.length, 0);
});

test('foreign and limiter-counter keys abort before any deletion', async () => {
	const records = makeRecords();
	const foreign = { key: 'manawg:wg-write:member-x:limit', type: 'string', ttl: -1, zcard: 0 };
	const redis = fakeRedis(records, { onScan: () => [...records, foreign] });
	await assert.rejects(
		runBoundedPurge({
			redis,
			baseline: makeBaseline(records),
			execute: true,
			confirmation: 'DELETE_TEST_ANALYTICS_KEYS',
		}),
		/foreign_namespace_or_schema_drift/,
	);
	assert.equal(redis.evalCalls.length, 0);
	assert.equal(redis.deletedKeys.length, 0);
	assert.equal(redis.records.has(foreign.key), true);
});

test('confirmed execution deletes only analytics keys and leaves limiter counters intact', async () => {
	const analytics = makeRecords();
	const protectedKeys = [
		{ key: 'manawg:wg-write:member-x:limit', type: 'string', ttl: -1, zcard: 0 },
		{ key: 'manawg:foreign:events:not-a-bucket', type: 'string', ttl: -1, zcard: 0 },
	];
	const protectedKeyNames = new Set(protectedKeys.map((row) => row.key));
	const redis = fakeRedis([...analytics, ...protectedKeys], {
		onScan: (_number, rows) => rows.filter((row) => !protectedKeyNames.has(row.key)),
	});
	const baseline = makeBaseline(analytics);
	const summary = await runBoundedPurge({
		redis,
		baseline,
		execute: true,
		confirmation: baseline.confirmationLiteral,
	});

	assert.equal(summary.outcome, 'DELETED');
	assert.deepEqual(
		redis.deletedKeys,
		analytics.map((row) => row.key),
	);
	for (const row of protectedKeys) assert.equal(redis.records.has(row.key), true);
});

test('candidate key cap aborts before any EVAL', async () => {
	const records = makeRecords();
	const extra = {
		key: `manawg:limiter-c:events:${scanStart - 900_000}`,
		type: 'zset',
		ttl: -1,
		zcard: 1,
	};
	const redis = fakeRedis([...records, extra]);
	await assert.rejects(
		runBoundedPurge({ redis, baseline: makeBaseline(records) }),
		/scan_key_cap_exceeded/,
	);
	assert.equal(redis.evalCalls.length, 0);
});

test('an empty limiter namespace fails closed before metadata reads or deletion', async () => {
	const malformed = [{ key: `manawg::events:${scanStart - 1}`, type: 'zset', ttl: -1, zcard: 1 }];
	const redis = fakeRedis(malformed);
	await assert.rejects(
		runBoundedPurge({ redis, baseline: makeBaseline(makeRecords()) }),
		/foreign_namespace_or_schema_drift/,
	);
	assert.equal(redis.evalCalls.length, 0);
});

test('a new bucket on the final scan aborts before any deletion', async () => {
	const records = makeRecords();
	const newer = {
		key: `manawg:limiter-c:events:${scanStart + 1}`,
		type: 'zset',
		ttl: -1,
		zcard: 1,
	};
	const redis = fakeRedis(records, { onScan: (n) => (n === 1 ? records : [...records, newer]) });
	await assert.rejects(
		runBoundedPurge({
			redis,
			baseline: makeBaseline(records),
			execute: true,
			confirmation: 'DELETE_TEST_ANALYTICS_KEYS',
		}),
		/bucket_after_recorded_scan_start/,
	);
	assert.equal(redis.evalCalls.length, 0);
});

test('a same-count replacement key fails the exact fingerprint before deletion', async () => {
	const records = makeRecords();
	const replacements = records.map((row, index) =>
		index === 0 ? { ...row, key: row.key.replace('limiter-a', 'new-limiter') } : row,
	);
	const redis = fakeRedis(records, { onScan: (n) => (n === 1 ? records : replacements) });
	await assert.rejects(
		runBoundedPurge({
			redis,
			baseline: makeBaseline(records),
			execute: true,
			confirmation: 'DELETE_TEST_ANALYTICS_KEYS',
		}),
		/metadata_fingerprint_drift/,
	);
	assert.equal(redis.evalCalls.length, 0);
});

test('type drift during final recheck aborts before any deletion', async () => {
	const records = makeRecords();
	let typeReads = 0;
	const redis = fakeRedis(records, {
		onRead: (kind, _n, key, row) => {
			if (kind === 'type' && key === records[0].key && ++typeReads > 1) return { type: 'string' };
			return row;
		},
	});
	await assert.rejects(
		runBoundedPurge({
			redis,
			baseline: makeBaseline(records),
			execute: true,
			confirmation: 'DELETE_TEST_ANALYTICS_KEYS',
		}),
		/type_schema_drift/,
	);
	assert.equal(redis.evalCalls.length, 0);
});

test('TTL drift during final recheck aborts before any deletion', async () => {
	const records = makeRecords();
	let ttlReads = 0;
	const redis = fakeRedis(records, {
		onRead: (kind, _n, key, row) => {
			if (kind === 'ttl' && key === records[0].key && ++ttlReads > 1) return { ttl: 120 };
			return row;
		},
	});
	await assert.rejects(
		runBoundedPurge({
			redis,
			baseline: makeBaseline(records),
			execute: true,
			confirmation: 'DELETE_TEST_ANALYTICS_KEYS',
		}),
		/ttl_schema_drift/,
	);
	assert.equal(redis.evalCalls.length, 0);
});

test('confirmed execution deletes only the exact preflight analytics key set', async () => {
	const records = makeRecords();
	const redis = fakeRedis(records);
	const summary = await runBoundedPurge({
		redis,
		baseline: makeBaseline(records),
		execute: true,
		confirmation: 'DELETE_TEST_ANALYTICS_KEYS',
	});

	assert.equal(summary.mode, 'EXECUTED');
	assert.equal(summary.outcome, 'DELETED');
	assert.equal(summary.deletedCount, 2);
	assert.equal(redis.evalCalls.length, 1);
	assert.deepEqual(
		redis.evalCalls[0].keys,
		records.map((row) => row.key),
	);
	assert.equal(
		redis.evalCalls[0].keys.some(
			(key) => key.includes('wg-write') || key.includes('limiter-counter'),
		),
		false,
	);
	assert.equal(redis.evalCalls[0].script, ATOMIC_DELETE_SCRIPT);
});

test('atomic Lua script checks type, TTL, and ZCARD before DEL without reading members', () => {
	const typeCheck = ATOMIC_DELETE_SCRIPT.indexOf("redis.call('TYPE'");
	const ttlCheck = ATOMIC_DELETE_SCRIPT.indexOf("redis.call('TTL'");
	const zcardCheck = ATOMIC_DELETE_SCRIPT.indexOf("redis.call('ZCARD'");
	const deleteCall = ATOMIC_DELETE_SCRIPT.indexOf("redis.call('DEL'");
	assert.ok(typeCheck >= 0 && typeCheck < deleteCall);
	assert.ok(ttlCheck >= 0 && ttlCheck < deleteCall);
	assert.ok(zcardCheck >= 0 && zcardCheck < deleteCall);
	assert.match(ATOMIC_DELETE_SCRIPT, /markerStart <= 8/);
	assert.doesNotMatch(ATOMIC_DELETE_SCRIPT, /ZRANGE|ZSCORE|ZSCAN|HGET|GET/);
});

test('atomic guard rejections are known not to have deleted any keys', async () => {
	const records = makeRecords();
	for (const reason of [
		'namespace',
		'bucket_cutoff',
		'type_drift',
		'ttl_drift',
		'cardinality_drift',
		'total_cardinality_drift',
	]) {
		const redis = fakeRedis(records, { onEval: () => ['ABORT', reason] });
		await assert.rejects(
			runBoundedPurge({
				redis,
				baseline: makeBaseline(records),
				execute: true,
				confirmation: 'DELETE_TEST_ANALYTICS_KEYS',
			}),
			new RegExp(`atomic_preflight_${reason}`),
		);
		assert.equal(redis.evalCalls.length, 1);
		assert.deepEqual(redis.deletedKeys, []);
		assert.equal(redis.records.size, records.length);
	}
});

test('Redis EVAL encodes the exact key set and expected metadata arguments', async () => {
	const socket = new FakeSocket();
	const redis = createRedisClient(new URL('rediss://default:secret@example.upstash.io:6379'), {
		connect: () => socket,
	});
	const script = "return {'DELETED', '2'}";
	const keys = ['manawg:limiter-a:events:1234567890123', 'manawg:limiter-b:events:1234567890456'];
	const args = ['2', String(scanStart), '7', '3', '4'];
	socket.emit('secureConnect');
	await redis.ready;
	const replyPromise = redis.eval(script, keys, args);
	const fields = ['EVAL', script, String(keys.length), ...keys, ...args];
	const expectedWire = `*${fields.length}\r\n${fields
		.map((value) => {
			const text = String(value);
			return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
		})
		.join('')}`;
	assert.equal(socket.writes[0], expectedWire);
	socket.emit('data', Buffer.from('*2\r\n$7\r\nDELETED\r\n$1\r\n2\r\n'));
	assert.deepEqual(await replyPromise, ['DELETED', '2']);
	redis.close();
});

test('TLS handshake timeout destroys the socket and rejects the connection', async () => {
	const socket = new FakeSocket();
	const redis = createRedisClient(new URL('rediss://default:secret@example.upstash.io:6379'), {
		connect: () => socket,
		handshakeTimeoutMs: 5,
	});

	await assert.rejects(redis.ready, /redis_tls_handshake_timeout/);
	assert.equal(socket.destroyed, true);
});

test('lost or mismatched EVAL response is reported as unknown with null deleted count', async (_t) => {
	const records = makeRecords();
	const baseline = makeBaseline(records);
	for (const onEval of [
		() => {
			throw new Error('response lost: rediss://default:private-secret@example.invalid');
		},
		() => ['DELETED', '1'],
	]) {
		const redis = fakeRedis(records, { onEval });
		const summary = await runBoundedPurge({
			redis,
			baseline,
			execute: true,
			confirmation: baseline.confirmationLiteral,
		});
		assert.equal(summary.outcome, 'UNKNOWN');
		assert.equal(summary.deletedCount, null);
		assert.equal(summary.error, 'delete_outcome_unknown');
		assert.doesNotMatch(JSON.stringify(summary), /private-secret|rediss:\/\//);
	}
});

test('untrusted connection errors are reduced to a generic safe label', () => {
	const label = safeErrorCode(
		new Error('REDIS_URL=rediss://default:private-secret@example.invalid:6379'),
	);
	assert.equal(label, 'metadata_scan_failed');
	assert.equal(label.includes('private-secret'), false);
});
