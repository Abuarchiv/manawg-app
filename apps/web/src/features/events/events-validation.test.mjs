import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('../../..', import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const path = resolve(appRoot, 'src', `${specifier.slice(2)}.ts`);
			return nextResolve(pathToFileURL(path).href, context);
		}
		return nextResolve(specifier, context);
	},
});

const { validateEventForm } = await import('./events.ts');

// Regression: EventFormFields wires aria-invalid/aria-describedby to the field
// named here. Without `field` on the failure branch, every validation error
// pointed at no input at all (a WCAG 3.3.1 violation).
test('tags a missing title as the title field', () => {
	const result = validateEventForm({ title: '', startsAt: '2026-01-01T10:00', endsAt: '' });
	assert.equal(result.ok, false);
	assert.equal(result.field, 'title');
});

test('tags a missing start as the startsAt field', () => {
	const result = validateEventForm({ title: 'Meeting', startsAt: '', endsAt: '' });
	assert.equal(result.ok, false);
	assert.equal(result.field, 'startsAt');
});

test('tags an end before start as the endsAt field', () => {
	const result = validateEventForm({
		title: 'Meeting',
		startsAt: '2026-01-02T10:00',
		endsAt: '2026-01-01T10:00',
	});
	assert.equal(result.ok, false);
	assert.equal(result.field, 'endsAt');
});

test('valid input reports no field error', () => {
	const result = validateEventForm({
		title: 'Meeting',
		startsAt: '2026-01-01T10:00',
		endsAt: '2026-01-01T11:00',
	});
	assert.equal(result.ok, true);
});
