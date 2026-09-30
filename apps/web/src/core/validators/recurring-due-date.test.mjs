import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const validatorPath = path.join(process.cwd(), 'src/core/validators/recurring-due-date.ts');
const source = transpileModule(readFileSync(validatorPath, 'utf8'), {
	compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', source)(requireFromWeb, loaded, loaded.exports);
const { isRecurringDueAtEditAllowed, isRecurringDueAtInRange, recurringDueAtSchema } =
	loaded.exports;

test('a due date far in the past or future is out of range', (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	assert.equal(isRecurringDueAtInRange('2000-01-01T00:00:00.000Z'), false);
	assert.equal(isRecurringDueAtInRange('2040-01-01T00:00:00.000Z'), false);
	assert.equal(isRecurringDueAtInRange('2026-08-01T00:00:00.000Z'), true);
	assert.equal(isRecurringDueAtInRange('2027-01-01T00:00:00.000Z'), true);
	assert.equal(recurringDueAtSchema.safeParse('2000-01-01T00:00:00.000Z').success, false);
	assert.equal(recurringDueAtSchema.safeParse('2026-10-01T00:00:00.000Z').success, true);
});

test('an edit may not move the due date out of range but may resend the current one', (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const current = new Date('2026-10-01T00:00:00.000Z');
	// Regression: the PATCH schema had no bounds, so nextDueAt=2000-01-01
	// made the cron book ~320 catch-up expenses.
	assert.equal(isRecurringDueAtEditAllowed('2000-01-01T00:00:00.000Z', current), false);
	assert.equal(isRecurringDueAtEditAllowed('2040-01-01T00:00:00.000Z', current), false);
	assert.equal(isRecurringDueAtEditAllowed('2026-11-01T00:00:00.000Z', current), true);
	const stale = new Date('2024-01-01T00:00:00.000Z');
	assert.equal(isRecurringDueAtEditAllowed('2024-01-01T00:00:00.000Z', stale), true);
	assert.equal(isRecurringDueAtEditAllowed('2023-01-01T00:00:00.000Z', stale), false);
});
