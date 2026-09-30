import type { DashboardData } from '@/core/reads/dashboard-data';
import { getWgHealth } from '@/core/reads/dashboard-insights';

export const E2E_EXISTING_WG = {
	id: '989ac820-58b7-431f-9c65-28721264f333',
	shareCode: 'MTE8PZAT',
	name: 'sadf',
	member: {
		id: '7d898f9e-5ad7-4f5d-abed-8c3e99a76973',
		name: 'dsaf',
		color: '#6d5efc',
	},
} as const;

export const E2E_CREATED_WG = {
	id: 'f3cfbb01-844c-4ba6-9ea7-0ee8d68b0d83',
	shareCode: 'SMKETEST',
	member: {
		id: 'a2c3f1b7-2fd9-476b-9e25-a1c8c0115db1',
		color: '#0ea5e9',
	},
} as const;

export interface E2EWgFixture {
	id: string;
	name: string;
	shareCode: string;
	joiningEnabled: boolean;
	shareCodeRotatedAt: string | null;
	members: Array<{ id: string; name: string; color: string | null }>;
}

/**
 * Fixture mode serves the fixture roster and mints member tokens without real
 * authentication, so it must never activate on a hosted deployment: Vercel
 * sets `VERCEL=1` on every build and function (Preview and Production alike),
 * while the local/CI fixture runs only fake `VERCEL_ENV=preview`.
 */
export function isE2EDbDownMode(): boolean {
	return (
		(process.env.E2E_FIXTURE_MODE === 'true' || process.env.NODE_ENV === 'test') &&
		process.env.VERCEL !== '1' &&
		process.env.VERCEL_ENV !== 'production' &&
		process.env.NEXT_PUBLIC_DB_DOWN === 'true' &&
		process.env.CI === 'true' &&
		!process.env.POSTGRES_URL &&
		!process.env.DATABASE_URL
	);
}

export function getE2EWgFixture(code: string): E2EWgFixture | null {
	if (code === E2E_EXISTING_WG.shareCode) {
		return {
			id: E2E_EXISTING_WG.id,
			name: E2E_EXISTING_WG.name,
			shareCode: E2E_EXISTING_WG.shareCode,
			joiningEnabled: true,
			shareCodeRotatedAt: null,
			members: [
				E2E_EXISTING_WG.member,
				{ id: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55', name: 'Mina', color: '#0f766e' },
			],
		};
	}

	if (code === E2E_CREATED_WG.shareCode) {
		return {
			id: E2E_CREATED_WG.id,
			name: 'Smoke Test WG',
			shareCode: E2E_CREATED_WG.shareCode,
			joiningEnabled: true,
			shareCodeRotatedAt: null,
			members: [{ ...E2E_CREATED_WG.member, name: 'Smoke Tester' }],
		};
	}

	return null;
}

export function buildE2EDashboardData(code: string): DashboardData {
	const now = Date.now();
	const day = 86_400_000;

	return {
		balances: [
			{
				memberId:
					code === E2E_CREATED_WG.shareCode ? E2E_CREATED_WG.member.id : E2E_EXISTING_WG.member.id,
				memberName:
					code === E2E_CREATED_WG.shareCode ? 'Smoke Tester' : E2E_EXISTING_WG.member.name,
				color:
					code === E2E_CREATED_WG.shareCode
						? E2E_CREATED_WG.member.color
						: E2E_EXISTING_WG.member.color,
				currency: 'EUR',
				paidCents: 3290,
				owedCents: 0,
				balanceCents: 3290,
			},
		],
		spendByDay: Array.from({ length: 14 }, (_, idx) => ({
			date: new Date(now - (13 - idx) * day).toISOString().slice(0, 10),
			currency: 'EUR',
			cents: idx === 13 ? 3290 : 0,
		})),
		totalSpendByCurrency: { EUR: 3290 },
		weekSpendByCurrency: { EUR: 3290 },
		monthSpendByCurrency: { EUR: 3290 },
		totalSpendCents: 3290,
		weekSpendCents: 3290,
		monthSpendCents: 3290,
		openShoppingCount: 1,
		openShoppingTop: ['Hafermilch'],
		dueChores: [
			{
				id: 'dc02a93f-59f6-4cf9-80a7-53d4a407cb49',
				title: 'Bad putzen',
				assignedMemberId:
					code === E2E_CREATED_WG.shareCode ? E2E_CREATED_WG.member.id : E2E_EXISTING_WG.member.id,
				assignedMemberName:
					code === E2E_CREATED_WG.shareCode ? 'Smoke Tester' : E2E_EXISTING_WG.member.name,
				assignedColor:
					code === E2E_CREATED_WG.shareCode
						? E2E_CREATED_WG.member.color
						: E2E_EXISTING_WG.member.color,
				nextDueAt: new Date(now + day).toISOString(),
				overdue: false,
			},
		],
		activity: [
			{
				kind: 'expense',
				timestamp: new Date(now).toISOString(),
				memberId:
					code === E2E_CREATED_WG.shareCode ? E2E_CREATED_WG.member.id : E2E_EXISTING_WG.member.id,
				memberName:
					code === E2E_CREATED_WG.shareCode ? 'Smoke Tester' : E2E_EXISTING_WG.member.name,
				text: 'Internet',
				amountCents: 3290,
			},
		],
		latestAnnouncement: null,
		myOpenAnnouncements: [],
		wgHealth: getWgHealth({
			shareCode: code,
			openShoppingCount: 1,
			overdueChoreCount: 0,
			openDebtCents: 0,
			openAnnouncementCount: 0,
			absentMemberCount: 0,
			dueRecurringCount: 1,
		}),
		dueRecurringExpenses: [
			{
				id: 'a1ef32d5-d40a-4df2-9977-7684dce7df3f',
				description: 'Internet',
				amountCents: 3290,
				currency: 'EUR',
				nextDueAt: new Date(now - day).toISOString(),
			},
		],
		absentMembers: [],
		setup: {
			choreCount: 1,
			hasExpense: true,
			hasShoppingItem: true,
			hasAnnouncement: false,
			notificationsEnabled: true,
		},
	};
}
