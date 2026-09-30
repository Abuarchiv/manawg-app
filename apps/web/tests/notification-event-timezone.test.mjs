import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

// Vercel functions run in UTC; pin the process zone there so a formatter
// without an explicit timeZone produces the WRONG Berlin rendering.
process.env.TZ = 'UTC';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const srcRoot = path.join(process.cwd(), 'src');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWebModule(request, parent, isMain, options) {
	const resolved = request.startsWith('@/') ? path.join(srcRoot, request.slice(2)) : request;
	return resolveFilename.call(this, resolved, parent, isMain, options);
};
Module._extensions['.ts'] = (loadedModule, filename) => {
	const source = fs.readFileSync(filename, 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
		fileName: filename,
	}).outputText;
	loadedModule._compile(compiled, filename);
};

const { formatNotificationMessage } = requireFromWeb(
	path.join(srcRoot, 'core/notifications/notifications.ts'),
);

test('upcoming event push renders the Berlin wall clock, not the UTC one', () => {
	// 20:00 UTC in July is 22:00 CEST.
	const message = formatNotificationMessage('event.upcoming', {
		startsAt: '2026-07-15T20:00:00.000Z',
		title: 'WG-Treff',
		eventId: 'event-1',
	});
	assert.equal(message.body, 'Morgen in deiner WG: „WG-Treff“ um 15.07., 22:00.');
});

test('an event between 00:00 and 02:00 Berlin time keeps the Berlin date', () => {
	// 23:30 UTC on the 10th is already 00:30 CET on the 11th.
	const message = formatNotificationMessage('event.upcoming', {
		startsAt: '2026-01-10T23:30:00.000Z',
		title: 'Kochen',
		eventId: 'event-2',
	});
	assert.equal(message.body, 'Morgen in deiner WG: „Kochen“ um 11.01., 00:30.');
});

test('created event notification renders the same Berlin time', () => {
	const message = formatNotificationMessage('event.created', {
		startsAt: '2026-07-15T20:00:00.000Z',
		title: 'WG-Treff',
		eventId: 'event-1',
		actorName: 'Ada',
	});
	assert.match(message.body, /am 15\.07\., 22:00 eingetragen\.$/);
});
