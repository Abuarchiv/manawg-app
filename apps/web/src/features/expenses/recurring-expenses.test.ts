import assert from 'node:assert/strict';
import test from 'node:test';

const {
	canBookRecurringTemplate,
	canManageRecurringTemplate,
	countMissedOccurrences,
	previewNextOccurrences,
} = await import('./recurring-expenses');

test('the preview keeps month-end templates on their anchor day', () => {
	// Booked on 28 Feb after starting on the 31st: without the anchor the cadence drifts to 28.
	const preview = previewNextOccurrences(
		{
			nextDueAt: '2027-02-28T12:00:00.000Z',
			intervalMonths: 1,
			anchorAt: '2027-01-31T12:00:00.000Z',
		},
		3,
	);
	assert.deepEqual(
		preview.map((date) => date.toISOString().slice(0, 10)),
		['2027-02-28', '2027-03-31', '2027-04-30'],
	);
	const drifting = previewNextOccurrences(
		{ nextDueAt: '2027-02-28T12:00:00.000Z', intervalMonths: 1 },
		2,
	);
	assert.equal(drifting[1]?.toISOString().slice(0, 10), '2027-03-28');
});

test('missed bookings are counted per interval up to the catch-up cap', () => {
	const now = new Date('2026-10-15T12:00:00.000Z');
	assert.equal(countMissedOccurrences('2026-10-20T12:00:00.000Z', 1, now), 0);
	assert.equal(countMissedOccurrences('2026-10-15T09:00:00.000Z', 1, now), 1);
	assert.equal(countMissedOccurrences('2026-08-01T12:00:00.000Z', 1, now), 3);
	assert.equal(countMissedOccurrences('2026-01-01T12:00:00.000Z', 12, now), 1);
	assert.equal(countMissedOccurrences('2020-01-01T12:00:00.000Z', 1, now), 13);
	assert.equal(countMissedOccurrences('nonsense', 1, now), 0);
});

test('only the creator or an admin manages a template, and booking needs a share', () => {
	assert.equal(canManageRecurringTemplate({ createdByMemberId: 'a' }, 'a', false), true);
	assert.equal(canManageRecurringTemplate({ createdByMemberId: 'a' }, 'b', false), false);
	assert.equal(canManageRecurringTemplate({ createdByMemberId: 'a' }, 'b', true), true);
	assert.equal(canManageRecurringTemplate({}, 'b', false), true);

	const template = { paidByMemberId: 'a', splits: [{ debtorMemberId: 'a', amountCents: 500 }] };
	assert.equal(canBookRecurringTemplate(template, 'a'), true);
	assert.equal(canBookRecurringTemplate(template, 'b'), false);
});
