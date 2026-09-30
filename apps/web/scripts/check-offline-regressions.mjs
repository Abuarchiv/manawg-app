import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relativePath) => readFileSync(path.join(webRoot, relativePath), 'utf8');

const contextProvider = readSource('src/components/wg/WgContextProvider.tsx');
assert.match(
	contextProvider,
	/useVisibilityPausedInterval\(\(\) => void sync\(\), identity && accountReady \? 60_000 : null\)/,
	'WG offline sync must use the visibility-paused interval after account binding',
);
assert.doesNotMatch(
	contextProvider,
	/const interval = window\.setInterval\(\(\) => void sync\(\), 60_000\)/,
	'WG offline sync must not keep an unconditional interval while hidden',
);

const offlineClient = readSource('src/core/offline/offline-client.ts');
assert.match(
	offlineClient,
	/let cachedOfflineQueue: OfflineAction\[\] \| null = null/,
	'offline queue reads need a last-known snapshot',
);
assert.match(
	offlineClient,
	/return filterOfflineQueue\(cachedOfflineQueue \?\? \[\]\)/,
	'offline queue reads must fall back to the last-known snapshot',
);

const offlineImages = readSource('src/core/offline/offline-images.ts');
assert.match(
	offlineImages,
	/import \{ createOfflineIdempotencyKey \} from '\.\/offline-queue'/,
	'pending images must use the existing guarded UUID helper',
);
assert.doesNotMatch(
	offlineImages,
	/crypto\.randomUUID\(\)/,
	'pending image storage must not call randomUUID without a fallback',
);
