import { createHash } from 'node:crypto';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

export const RECORDED_BASELINE = Object.freeze({
	namespacePattern: 'manawg:*:events:*',
	scanStartedAt: '2026-09-30T12:24:23.073Z',
	scanStartMs: Date.parse('2026-09-30T12:24:23.073Z'),
	keyCount: 552,
	maxKeyCount: 552,
	keyMetadataFingerprintSha256: 'b48714848cef80fe678bbea0ebbc4fd9fc177f52cb37b464471f528ff87117c3',
	typeCounts: { zset: 552 },
	ttlSecondsCounts: { '-1': 552 },
	zsetCardinalitySum: 1111,
	oldestBucketMs: Date.parse('2026-08-29T06:00:00.000Z'),
	newestBucketMs: Date.parse('2026-09-28T01:00:00.000Z'),
	confirmationLiteral: 'DELETE_MANAWG_ANALYTICS_KEYS_552_UP_TO_2026-09-30T12:24:23.073Z_B4871484',
});

const SCAN_COUNT = 1000;
const SCAN_PAGE_CAP = 100;
const META_BATCH_SIZE = 100;
const NAMESPACE_MARKER = ':events:';

export const ATOMIC_DELETE_SCRIPT = String.raw`
local expectedCount = tonumber(ARGV[1])
local cutoffMs = tonumber(ARGV[2])
local expectedZcardTotal = tonumber(ARGV[3])
if not expectedCount or expectedCount > 552 or #KEYS ~= expectedCount then
  return {'ABORT', 'key_count'}
end
if #ARGV ~= expectedCount + 3 then
  return {'ABORT', 'argument_count'}
end
local seen = {}
local totalZcard = 0
for index, key in ipairs(KEYS) do
  if string.sub(key, 1, 7) ~= 'manawg:' then
    return {'ABORT', 'namespace'}
  end
  local marker = ':events:'
  local markerStart = string.find(key, marker, 1, true)
  if not markerStart or markerStart <= 8 or string.find(key, marker, markerStart + #marker, true) then
    return {'ABORT', 'namespace'}
  end
  local suffix = string.sub(key, markerStart + #marker)
  if string.len(suffix) ~= 13 or not string.match(suffix, '^%d+$') then
    return {'ABORT', 'bucket_schema'}
  end
  local bucketMs = tonumber(suffix)
  if not bucketMs or not cutoffMs or bucketMs > cutoffMs then
    return {'ABORT', 'bucket_cutoff'}
  end
  if seen[key] then
    return {'ABORT', 'duplicate_key'}
  end
  seen[key] = true
  local keyType = redis.call('TYPE', key)
  if type(keyType) == 'table' then keyType = keyType.ok end
  if keyType ~= 'zset' then
    return {'ABORT', 'type_drift'}
  end
  if redis.call('TTL', key) ~= -1 then
    return {'ABORT', 'ttl_drift'}
  end
  local zcard = redis.call('ZCARD', key)
  local expectedZcard = tonumber(ARGV[index + 3])
  if not expectedZcard or zcard ~= expectedZcard then
    return {'ABORT', 'cardinality_drift'}
  end
  totalZcard = totalZcard + zcard
end
if totalZcard ~= expectedZcardTotal then
  return {'ABORT', 'total_cardinality_drift'}
end
local deleted = redis.call('DEL', unpack(KEYS))
if deleted ~= expectedCount then
  return {'UNKNOWN', 'delete_count_mismatch'}
end
return {'DELETED', tostring(deleted)}
`;

class PurgeGuardError extends Error {
	constructor(code) {
		super(code);
		this.name = 'PurgeGuardError';
		this.code = code;
	}
}

export function fingerprintMetadata(records) {
	const rows = [...records]
		.sort((a, b) => a.key.localeCompare(b.key))
		.map((row) => `${row.key}\0${row.type}\0${row.ttl}\0${row.zcard ?? ''}`);
	return createHash('sha256').update(rows.join('\n')).digest('hex');
}

function bucketTimeMs(key) {
	if (typeof key !== 'string' || key.length > 512 || !key.startsWith('manawg:')) return null;
	const markerIndex = key.lastIndexOf(NAMESPACE_MARKER);
	if (markerIndex <= 'manawg:'.length || key.indexOf(NAMESPACE_MARKER) !== markerIndex) return null;
	const suffix = key.slice(markerIndex + NAMESPACE_MARKER.length);
	if (!/^\d{13}$/.test(suffix)) return null;
	const value = Number(suffix);
	return Number.isSafeInteger(value) ? value : null;
}

function countValues(rows, field) {
	const counts = {};
	for (const row of rows) {
		const value = row[field];
		const key = value === null || value === undefined ? 'metadata-error' : String(value);
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

async function readSnapshot(redis, baseline) {
	const keys = new Set();
	let cursor = '0';
	let pages = 0;
	do {
		const reply = await redis.scan(cursor, baseline.namespacePattern, SCAN_COUNT);
		if (!Array.isArray(reply) || !Array.isArray(reply[1])) {
			throw new PurgeGuardError('redis_scan_failed');
		}
		cursor = String(reply[0]);
		pages += 1;
		for (const key of reply[1]) {
			if (bucketTimeMs(key) === null)
				throw new PurgeGuardError('foreign_namespace_or_schema_drift');
			if (bucketTimeMs(key) > baseline.scanStartMs) {
				throw new PurgeGuardError('bucket_after_recorded_scan_start');
			}
			keys.add(key);
			if (keys.size > baseline.maxKeyCount) throw new PurgeGuardError('scan_key_cap_exceeded');
		}
		if (pages > SCAN_PAGE_CAP) throw new PurgeGuardError('scan_page_cap_exceeded');
	} while (cursor !== '0');

	const keyList = [...keys].sort();
	const records = [];
	for (let start = 0; start < keyList.length; start += META_BATCH_SIZE) {
		const batch = keyList.slice(start, start + META_BATCH_SIZE);
		const rows = await Promise.all(
			batch.map(async (key) => {
				const [type, ttl] = await Promise.all([redis.type(key), redis.ttl(key)]);
				const zcard = type === 'zset' ? await redis.zcard(key) : null;
				return { key, type, ttl, zcard };
			}),
		);
		records.push(...rows);
	}

	const buckets = keyList.map(bucketTimeMs);
	return {
		records,
		fingerprint: fingerprintMetadata(records),
		keyCount: keyList.length,
		typeCounts: countValues(records, 'type'),
		ttlSecondsCounts: countValues(records, 'ttl'),
		zsetCardinalitySum: records.reduce(
			(sum, row) => sum + (row.type === 'zset' && Number.isSafeInteger(row.zcard) ? row.zcard : 0),
			0,
		),
		oldestBucketMs: buckets.length ? Math.min(...buckets) : null,
		newestBucketMs: buckets.length ? Math.max(...buckets) : null,
	};
}

function validateSnapshot(snapshot, baseline) {
	if (snapshot.keyCount > baseline.maxKeyCount) throw new PurgeGuardError('scan_key_cap_exceeded');
	if (snapshot.keyCount !== baseline.keyCount) throw new PurgeGuardError('new_or_missing_key');
	if (JSON.stringify(snapshot.typeCounts) !== JSON.stringify(baseline.typeCounts)) {
		throw new PurgeGuardError('type_schema_drift');
	}
	if (JSON.stringify(snapshot.ttlSecondsCounts) !== JSON.stringify(baseline.ttlSecondsCounts)) {
		throw new PurgeGuardError('ttl_schema_drift');
	}
	if (snapshot.zsetCardinalitySum !== baseline.zsetCardinalitySum) {
		throw new PurgeGuardError('cardinality_drift');
	}
	if (
		snapshot.oldestBucketMs !== baseline.oldestBucketMs ||
		snapshot.newestBucketMs !== baseline.newestBucketMs
	) {
		throw new PurgeGuardError('bucket_range_drift');
	}
	if (snapshot.fingerprint !== baseline.keyMetadataFingerprintSha256) {
		throw new PurgeGuardError('metadata_fingerprint_drift');
	}
	if (
		snapshot.records.length !== baseline.keyCount ||
		snapshot.records.some(
			(row) => row.type !== 'zset' || row.ttl !== -1 || !Number.isSafeInteger(row.zcard),
		)
	) {
		throw new PurgeGuardError('per_key_metadata_drift');
	}
}

function summary(snapshot, baseline, mode, outcome, deletedCount, error = null) {
	return {
		mode,
		outcome,
		namespacePattern: baseline.namespacePattern,
		recordedScanStartedAt: baseline.scanStartedAt,
		keyCap: baseline.maxKeyCount,
		candidateCount: snapshot.keyCount,
		typeCounts: snapshot.typeCounts,
		ttlSecondsCounts: snapshot.ttlSecondsCounts,
		zsetCardinalitySum: snapshot.zsetCardinalitySum,
		keyBucketRangeUtc: {
			oldest: new Date(snapshot.oldestBucketMs).toISOString(),
			newest: new Date(snapshot.newestBucketMs).toISOString(),
		},
		metadataFingerprintSha256: snapshot.fingerprint,
		deletedCount,
		...(error ? { error } : {}),
		confirmationLiteralRequired: baseline.confirmationLiteral,
	};
}

export async function runBoundedPurge({
	redis,
	execute = false,
	confirmation = '',
	baseline = RECORDED_BASELINE,
}) {
	if (execute && confirmation !== baseline.confirmationLiteral) {
		throw new PurgeGuardError('explicit_confirmation_required');
	}
	const first = await readSnapshot(redis, baseline);
	validateSnapshot(first, baseline);
	if (!execute) return summary(first, baseline, 'DRY_RUN', 'NOT_ATTEMPTED', 0);

	// Final scan plus the Lua script rechecks the full candidate set atomically before DEL.
	const final = await readSnapshot(redis, baseline);
	validateSnapshot(final, baseline);
	if (final.fingerprint !== first.fingerprint)
		throw new PurgeGuardError('metadata_fingerprint_drift');
	const keys = final.records.map((row) => row.key);
	const args = [
		String(baseline.keyCount),
		String(baseline.scanStartMs),
		String(baseline.zsetCardinalitySum),
		...final.records.map((row) => String(row.zcard)),
	];
	let reply;
	try {
		reply = await redis.eval(ATOMIC_DELETE_SCRIPT, keys, args);
	} catch {
		return summary(
			final,
			baseline,
			'EXECUTION_ATTEMPTED',
			'UNKNOWN',
			null,
			'delete_outcome_unknown',
		);
	}
	if (!Array.isArray(reply) || typeof reply[0] !== 'string') {
		return summary(
			final,
			baseline,
			'EXECUTION_ATTEMPTED',
			'UNKNOWN',
			null,
			'delete_outcome_unknown',
		);
	}
	if (reply[0] === 'ABORT') {
		const safeReasons = new Set([
			'key_count',
			'argument_count',
			'namespace',
			'bucket_schema',
			'bucket_cutoff',
			'duplicate_key',
			'type_drift',
			'ttl_drift',
			'cardinality_drift',
			'total_cardinality_drift',
		]);
		const reason = safeReasons.has(reply[1]) ? reply[1] : 'rejected';
		throw new PurgeGuardError(`atomic_preflight_${reason}`);
	}
	if (reply[0] !== 'DELETED' || Number(reply[1]) !== baseline.keyCount) {
		return summary(
			final,
			baseline,
			'EXECUTION_ATTEMPTED',
			'UNKNOWN',
			null,
			'delete_outcome_unknown',
		);
	}
	return summary(final, baseline, 'EXECUTED', 'DELETED', Number(reply[1]));
}

function parseReply(buffer, offset = 0) {
	if (offset >= buffer.length) return null;
	const prefix = String.fromCharCode(buffer[offset]);
	const lineEnd = buffer.indexOf('\r\n', offset);
	if (lineEnd < 0) return null;
	const line = buffer.subarray(offset + 1, lineEnd).toString('utf8');
	const next = lineEnd + 2;
	if (prefix === '+') return { value: line, next };
	if (prefix === '-') return { value: { error: true }, next };
	if (prefix === ':') return { value: Number(line), next };
	if (prefix === '$') {
		const length = Number(line);
		if (length === -1) return { value: null, next };
		if (buffer.length < next + length + 2) return null;
		return {
			value: buffer.subarray(next, next + length).toString('utf8'),
			next: next + length + 2,
		};
	}
	if (prefix === '*') {
		const count = Number(line);
		if (count === -1) return { value: null, next };
		const items = [];
		let position = next;
		for (let index = 0; index < count; index += 1) {
			const item = parseReply(buffer, position);
			if (!item) return null;
			items.push(item.value);
			position = item.next;
		}
		return { value: items, next: position };
	}
	return { value: { error: true }, next };
}

function encodeCommand(args) {
	const parts = [`*${args.length}\r\n`];
	for (const value of args) {
		const text = String(value);
		parts.push(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
	}
	return parts.join('');
}

export function createRedisClient(url, { connect = tls.connect, handshakeTimeoutMs = 15000 } = {}) {
	const socket = connect({
		host: url.hostname,
		port: Number(url.port || 6379),
		servername: url.hostname,
		minVersion: 'TLSv1.2',
		rejectUnauthorized: true,
	});
	let buffer = Buffer.alloc(0);
	const pending = [];
	socket.on('data', (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (pending.length) {
			const reply = parseReply(buffer);
			if (!reply) break;
			buffer = buffer.subarray(reply.next);
			const current = pending.shift();
			clearTimeout(current.timeout);
			current.resolve(reply.value);
		}
	});
	socket.on('error', () => {
		while (pending.length) {
			const current = pending.shift();
			clearTimeout(current.timeout);
			current.reject(new PurgeGuardError('redis_transport_failed'));
		}
	});
	const send = (args) =>
		new Promise((resolve, reject) => {
			const current = { resolve, reject, timeout: null };
			current.timeout = setTimeout(() => {
				const index = pending.indexOf(current);
				if (index >= 0) pending.splice(index, 1);
				reject(new PurgeGuardError('redis_command_timeout'));
			}, 15000);
			pending.push(current);
			socket.write(encodeCommand(args));
		});
	const ready = new Promise((resolve, reject) => {
		let settled = false;
		const handshakeTimeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new PurgeGuardError('redis_tls_handshake_timeout'));
			socket.destroy();
		}, handshakeTimeoutMs);
		const finish = (error = null) => {
			if (settled) return;
			settled = true;
			clearTimeout(handshakeTimeout);
			if (error) reject(error);
			else resolve();
		};
		socket.once('secureConnect', () => finish());
		socket.once('error', () => finish(new PurgeGuardError('redis_connect_failed')));
		socket.once('close', () => finish(new PurgeGuardError('redis_connect_failed')));
	});
	const command = async (args) => {
		const reply = await send(args);
		if (reply?.error) throw new PurgeGuardError('redis_command_failed');
		return reply;
	};
	return {
		ready,
		scan: (cursor, pattern, count) => command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', count]),
		type: (key) => command(['TYPE', key]),
		ttl: (key) => command(['TTL', key]),
		zcard: (key) => command(['ZCARD', key]),
		eval: (script, keys, args) => command(['EVAL', script, String(keys.length), ...keys, ...args]),
		auth: async (username, password) =>
			command(username ? ['AUTH', username, password] : ['AUTH', password]),
		ping: () => command(['PING']),
		close: () => socket.end(),
	};
}

function parseCliArgs(args) {
	let execute = false;
	let confirmation = '';
	for (const arg of args) {
		if (arg === '--execute') execute = true;
		else if (arg.startsWith('--confirm=')) confirmation = arg.slice('--confirm='.length);
		else throw new PurgeGuardError('unsupported_argument');
	}
	return { execute, confirmation };
}

export function safeErrorCode(error) {
	return error instanceof PurgeGuardError ? error.code : 'metadata_scan_failed';
}

async function main() {
	const options = parseCliArgs(process.argv.slice(2));
	if (options.execute && options.confirmation !== RECORDED_BASELINE.confirmationLiteral) {
		throw new PurgeGuardError('explicit_confirmation_required');
	}
	const redisValue = process.env.REDIS_URL;
	const kvValue = process.env.KV_URL;
	if (!redisValue || !kvValue) throw new PurgeGuardError('private_redis_environment_missing');
	const url = new URL(redisValue);
	const kv = new URL(kvValue);
	if (
		url.protocol !== 'rediss:' ||
		!url.password ||
		!url.hostname.endsWith('.upstash.io') ||
		url.hostname !== kv.hostname ||
		url.port !== kv.port ||
		url.pathname !== kv.pathname
	)
		throw new PurgeGuardError('private_redis_target_mismatch');
	const redis = createRedisClient(url);
	try {
		await redis.ready;
		const username = decodeURIComponent(url.username || 'default');
		const auth = await redis.auth(
			username === 'default' ? '' : username,
			decodeURIComponent(url.password),
		);
		if (auth !== 'OK' || (await redis.ping()) !== 'PONG')
			throw new PurgeGuardError('redis_auth_failed');
		const result = await runBoundedPurge({ redis, ...options });
		process.stdout.write(`${JSON.stringify(result)}\n`);
		if (result.outcome === 'UNKNOWN') process.exitCode = 1;
	} finally {
		redis.close();
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((error) => {
		process.stdout.write(`${JSON.stringify({ error: safeErrorCode(error), deletedCount: 0 })}\n`);
		process.exitCode = 1;
	});
}
