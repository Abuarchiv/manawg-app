import { expect, test } from '@playwright/test';
import { chooseNextAvailableMember } from '../src/features/chores/chore-fairness';
import { MEMBER_TOKEN_HEADER } from '../src/shared/lib/member-header';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const SHARE_CODE = FIXTURE_WG.shareCode;
const CURRENT_MEMBER = FIXTURE_WG.memberId;

type FixtureMember = { id: string; name: string; color: string | null; active: boolean };
type FixtureAbsence = {
	id: string;
	memberId: string;
	memberName: string;
	startDate: string;
	endDate: string;
	reason: string;
};

function chore(id: string, assignedMemberId: string) {
	return {
		id,
		title: `Aufgabe ${id}`,
		intervalDays: 7,
		recurrenceType: 'days',
		nextDueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		assignedMemberId,
		lastCompletedAt: null,
		lastCompletedByName: null,
		openGapCountForAssignee: 0,
	};
}

function absence(member: FixtureMember): FixtureAbsence {
	return {
		id: `absence-${member.id}`,
		memberId: member.id,
		memberName: member.name,
		startDate: new Date(Date.now() - 86_400_000).toISOString(),
		endDate: new Date(Date.now() + 86_400_000).toISOString(),
		reason: 'Urlaub',
	};
}

async function openPutzen(
	page: import('@playwright/test').Page,
	members: FixtureMember[],
	chores: ReturnType<typeof chore>[],
	absences: FixtureAbsence[],
	viewerIsAdmin = false,
) {
	await setupMember(page);
	const memberTokens: Array<string | undefined> = [];
	await page.route(`**/api/wg/${SHARE_CODE}/members`, (route) => {
		memberTokens.push(route.request().headers()[MEMBER_TOKEN_HEADER]);
		return route.fulfill({ json: { members, viewerIsAdmin } });
	});
	await page.route(`**/api/wg/${SHARE_CODE}/chores`, (route) =>
		route.fulfill({ json: { chores, monthCompletions: {} } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/absences`, (route) =>
		route.fulfill({ json: { absences } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/dashboard`, (route) =>
		route.fulfill({
			json: { openShoppingCount: 123, dueChores: [], dueRecurringExpenses: [] },
		}),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);
	await navigateToFeature(page, `/wg/${SHARE_CODE}/putzen`);
	await dismissOnboarding(page);
	await expect.poll(() => memberTokens.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
	expect(memberTokens.every((token) => token === 'fixture-member-token')).toBe(true);
	const household = page.getByRole('navigation', { name: 'Haushalt' });
	const shopping = household.getByRole('link', { name: 'Einkäufe, 123 offen' });
	await expect(shopping).toBeVisible();
	await expect(shopping).toHaveText('Einkäufe99+');
}

test('hides permanent chore removal from non-admin members', async ({ page }) => {
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const title = 'Aufgabe delete-permission';
	const rows = [chore('delete-permission', viewer.id)];

	await openPutzen(page, [viewer], rows, []);
	await page.getByRole('button', { name: `Aufgabenaktionen: ${title}` }).click();
	await expect(page.getByRole('button', { name: `Aufgabe entfernen: ${title}` })).toHaveCount(0);
});

test('shows permanent chore removal to WG admins', async ({ page }) => {
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const title = 'Aufgabe delete-permission';
	const rows = [chore('delete-permission', viewer.id)];

	await openPutzen(page, [viewer], rows, [], true);
	await page.getByRole('button', { name: `Aufgabenaktionen: ${title}` }).click();
	await expect(page.getByRole('button', { name: `Aufgabe entfernen: ${title}` })).toBeVisible();
});

test('shows the authoritative next member and labels the viewer as du', async ({ page }) => {
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const absentMember: FixtureMember = { id: 'ben', name: 'Ben', color: null, active: true };
	const choreOwner: FixtureMember = { id: 'anna', name: 'Anna', color: null, active: true };
	const departedMember: FixtureMember = { id: 'dora', name: 'Dora', color: null, active: false };
	const members = [viewer, absentMember, choreOwner, departedMember];
	const chores = [chore('viewer-next', 'anna')];
	const absences = [absence(absentMember)];
	const activeMembers = members
		.filter((member) => member.active)
		.map(({ id, name }) => ({ id, name }));
	const nextMember = chooseNextAvailableMember({
		members: activeMembers,
		currentMemberId: 'anna',
		absentMemberIds: ['ben'],
		chores,
	});
	expect(nextMember).toBe(CURRENT_MEMBER);

	await openPutzen(page, members, chores, absences);
	const row = page.locator('#chore-viewer-next');
	await expect(row.getByText('Voraussichtlich als Nächstes: du.')).toBeVisible();
	await expect(row.getByText('Zuständig: Anna')).toBeVisible();
});

test('states when no active member is eligible for the next round', async ({ page }) => {
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const choreOwner: FixtureMember = { id: 'anna', name: 'Anna', color: null, active: true };
	const departedMember: FixtureMember = { id: 'dora', name: 'Dora', color: null, active: false };
	const members = [viewer, choreOwner, departedMember];
	const chores = [chore('no-successor', 'anna')];
	const absences = [absence(viewer), absence(choreOwner)];
	const activeMembers = members
		.filter((member) => member.active)
		.map(({ id, name }) => ({ id, name }));
	const nextMember = chooseNextAvailableMember({
		members: activeMembers,
		currentMemberId: 'anna',
		absentMemberIds: [CURRENT_MEMBER, 'anna'],
		chores,
	});
	expect(nextMember).toBeNull();

	await openPutzen(page, members, chores, absences);
	const row = page.locator('#chore-no-successor');
	await expect(row.getByText('Für die nächste Runde ist niemand verfügbar.')).toBeVisible();
	await expect(row.getByText('Dora', { exact: true })).toHaveCount(0);
});

test('wraps a long predicted name at phone widths in both themes', async ({ page }, testInfo) => {
	const owner: FixtureMember = { id: 'anna', name: 'Anna', color: null, active: true };
	const longNext: FixtureMember = {
		id: 'long-next',
		name: 'Alexandria-Winterstein-Schwarzenberg',
		color: null,
		active: true,
	};
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const members = [owner, longNext, viewer];
	const chores = [chore('long-next', owner.id)];
	const predicted = chooseNextAvailableMember({
		members: members.map(({ id, name }) => ({ id, name })),
		currentMemberId: owner.id,
		absentMemberIds: [],
		chores,
	});
	expect(predicted).toBe(longNext.id);

	await openPutzen(page, members, chores, []);
	const row = page.locator('#chore-long-next');
	await expect(row.getByText(`Voraussichtlich als Nächstes: ${longNext.name}.`)).toBeVisible();

	for (const theme of ['light', 'dark'] as const) {
		for (const width of [320, 390]) {
			await page.setViewportSize({ width, height: 844 });
			await page.emulateMedia({ colorScheme: theme });
			await page.evaluate(() => window.scrollTo(0, 0));
			const layout = await page.evaluate(() => ({
				viewport: document.documentElement.clientWidth,
				page: document.documentElement.scrollWidth,
			}));
			expect(layout.page).toBeLessThanOrEqual(layout.viewport);
			await page.screenshot({
				path: testInfo.outputPath(`putzen-${width}-${theme}.png`),
				animations: 'disabled',
			});
		}
	}
});
