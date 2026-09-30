import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const { ModuleKind, ScriptTarget, transpileModule } = requireFromWeb('typescript');
function loadModule(relativePath, resolve) {
	const compiled = transpileModule(readFileSync(path.join(process.cwd(), relativePath), 'utf8'), {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(resolve, module, module.exports);
	return module;
}
const berlinDay = loadModule('src/core/utils/berlin-day.ts', requireFromWeb);
const module = loadModule('src/core/notifications/notifications.ts', (name) => {
	if (name === '@/core/utils/money') return { formatEuroCents: () => '' };
	if (name === '@/core/utils/berlin-day') return berlinDay.exports;
	return requireFromWeb(name);
});
const { formatNotificationMessage } = module.exports;

test('event notification times use Europe/Berlin in summer and winter', () => {
	const previousTimezone = process.env.TZ;
	process.env.TZ = 'UTC';
	try {
		const summer = formatNotificationMessage('event.upcoming', {
			wgName: 'WG',
			title: 'Treffen',
			startsAt: '2026-07-01T18:00:00.000Z',
		});
		const winter = formatNotificationMessage('event.created', {
			wgName: 'WG',
			title: 'Treffen',
			startsAt: '2026-01-01T18:00:00.000Z',
		});
		const today = formatNotificationMessage('event.today', {
			wgName: 'WG',
			title: 'Treffen',
			startsAt: '2026-01-01T18:00:00.000Z',
		});
		const allDay = formatNotificationMessage('event.today', {
			wgName: 'WG',
			title: 'Feiertag',
			startsAt: '2026-01-01T23:00:00.000Z',
			allDay: true,
		});
		const ongoing = formatNotificationMessage('event.today', {
			wgName: 'WG',
			title: 'Nachtfahrt',
			startsAt: '2026-01-01T23:00:00.000Z',
			ongoing: true,
		});

		assert.match(summer.body, /01\.07\., 20:00/);
		assert.match(winter.body, /01\.01\., 19:00/);
		assert.equal(today.title, 'Termin heute');
		assert.match(today.body, /^Heute in WG:/);
		assert.match(allDay.body, /ist ganztägig/);
		assert.doesNotMatch(allDay.body, /23:00|00:00/);
		assert.match(ongoing.body, /läuft noch/);
	} finally {
		if (previousTimezone === undefined) Reflect.deleteProperty(process.env, 'TZ');
		else process.env.TZ = previousTimezone;
	}
});

test('all-day event pushes show the Berlin date without a clock time', () => {
	const previousTimezone = process.env.TZ;
	process.env.TZ = 'UTC';
	try {
		// All-day events are stored at Berlin midnight (22:00/23:00 UTC the day before).
		const created = formatNotificationMessage('event.created', {
			wgName: 'WG',
			actorName: 'Alex',
			title: 'Umzug',
			startsAt: '2026-09-30T22:00:00.000Z',
			allDay: true,
		});
		const upcoming = formatNotificationMessage('event.upcoming', {
			wgName: 'WG',
			title: 'Feiertag',
			startsAt: '2026-01-01T23:00:00.000Z',
			allDay: true,
		});

		assert.equal(created.body, 'Alex hat in WG „Umzug“ am 01.10. (ganztägig) eingetragen.');
		assert.equal(upcoming.body, 'Morgen in WG: „Feiertag“ am 02.01. (ganztägig).');
		for (const message of [created, upcoming]) {
			assert.doesNotMatch(message.body, /\d{2}:\d{2}/);
		}
	} finally {
		if (previousTimezone === undefined) Reflect.deleteProperty(process.env, 'TZ');
		else process.env.TZ = previousTimezone;
	}
});

test('chore.due copy follows the Berlin day distance to nextDueAt', (t) => {
	// 2026-09-29 23:30 Berlin (21:30 UTC) — still the 29th on the Berlin wall clock.
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-29T21:30:00.000Z') });
	const body = (nextDueAt) =>
		formatNotificationMessage('chore.due', { wgName: 'WG', title: 'Bad putzen', nextDueAt }).body;

	assert.equal(body('2026-09-29T08:00:00.000Z'), 'Bad putzen ist heute in WG fällig.');
	assert.equal(body('2026-09-29T22:30:00.000Z'), 'Bad putzen ist morgen in WG fällig.');
	assert.equal(body('2026-09-28T08:00:00.000Z'), 'Bad putzen ist in WG seit 1 Tag offen.');
	assert.equal(body('2026-09-24T08:00:00.000Z'), 'Bad putzen ist in WG seit 5 Tagen offen.');
	assert.equal(body('2026-10-03T08:00:00.000Z'), 'Bad putzen ist am 03.10. in WG fällig.');
	assert.equal(body(undefined), 'Bad putzen ist heute in WG fällig.');
});
