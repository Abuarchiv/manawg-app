import { recordAuditEvent } from '@/core/audit';
import { db, pushSubscriptions, wgMembers } from '@/core/db';
import { hasCapturingMemberPayment, lockActiveAccountMember } from '@/core/db/account-deletion';
import { apiError, badRequest, conflict, forbidden, notFound, tooMany } from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { computeBalances } from '@/features/expenses/debts';
import {
	loadCompletedExpensePayments,
	withExpensePaymentLock,
} from '@/features/expenses/expense-payments';
import { loadOpenExpenses } from '@/features/expenses/open-expenses';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

/** One open debt of the member being viewed, from their own perspective. */
interface OpenBalanceDto {
	member_id: string;
	name: string;
	amount_cents: number;
	currency: string;
	// 'owes'  → this member still owes the counterparty
	// 'owed'  → the counterparty still owes this member
	direction: 'owes' | 'owed';
}

/**
 * GET returns the member plus their open balances, so the "Auszug" (move-out)
 * confirmation can warn about money that would be left hanging. This does not
 * block anything — the decision is to allow the move-out and merely surface it.
 */
export const GET = withWgRoute<{ id: string }>('members/[id] GET', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;

	const [target] = await db
		.select({
			id: wgMembers.id,
			name: wgMembers.name,
			deactivatedAt: wgMembers.deactivatedAt,
			paypalMerchantId: wgMembers.paypalMerchantId,
		})
		.from(wgMembers)
		.where(and(eq(wgMembers.id, id), eq(wgMembers.wgId, wgId)))
		.limit(1);
	if (!target) return notFound('member_not_found');

	const [openExpenses, payments] = await Promise.all([
		loadOpenExpenses(wgId),
		loadCompletedExpensePayments(wgId),
	]);
	const balances = computeBalances(openExpenses, payments);
	const involved = balances.filter((b) => b.debtorId === id || b.creditorId === id);

	let openBalances: OpenBalanceDto[] = [];
	if (involved.length > 0) {
		const roster = await db
			.select({ id: wgMembers.id, name: wgMembers.name })
			.from(wgMembers)
			.where(eq(wgMembers.wgId, wgId));
		const nameById = new Map(roster.map((row) => [row.id, row.name]));
		openBalances = involved.map((pair) =>
			pair.debtorId === id
				? {
						member_id: pair.creditorId,
						name: nameById.get(pair.creditorId) ?? 'Unbekannt',
						amount_cents: pair.amountCents,
						currency: pair.currency,
						direction: 'owes' as const,
					}
				: {
						member_id: pair.debtorId,
						name: nameById.get(pair.debtorId) ?? 'Unbekannt',
						amount_cents: pair.amountCents,
						currency: pair.currency,
						direction: 'owed' as const,
					},
		);
		openBalances.sort(
			(a, b) => a.currency.localeCompare(b.currency) || b.amount_cents - a.amount_cents,
		);
	}

	return NextResponse.json({
		member: {
			id: target.id,
			name: target.name,
			active: target.deactivatedAt === null,
			...(auth.member.memberId === target.id && auth.member.verified
				? { paypalMerchantId: target.paypalMerchantId }
				: {}),
		},
		openBalances,
	});
});

const patchSchema = z
	.object({
		active: z.boolean().optional(),
	})
	.strict()
	.refine((value) => value.active !== undefined);

/**
 * PATCH toggles a member between active and deactivated ("Auszug"). Deactivation
 * is a reversible soft-delete: it sets `deactivated_at` so the member drops out
 * of every active roster while all their history and balances stay intact.
 * `{ active: true }` clears the timestamp and brings them back.
 */
export const PATCH = withWgRoute<{ id: string }>(
	'members/[id] PATCH',
	async (req, { code, id }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
		let raw: unknown;
		try {
			raw = await req.json();
		} catch {
			return badRequest('invalid_json');
		}
		const parsed = patchSchema.safeParse(raw);
		if (!parsed.success) return badRequest('active_invalid');
		const { active } = parsed.data;
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;
		const limited = await checkRateLimit(
			wgWriteLimiter,
			`member-update:${wgId}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();

		const result = await withExpensePaymentLock(wgId, async (tx) => {
			const actor = await lockActiveAccountMember(tx, wgId, auth.member.memberId, auth.authUserId);
			if (!actor) return { ok: false as const, response: apiError('member_deactivated', 401) };
			const [target] = await tx
				.select({
					id: wgMembers.id,
					name: wgMembers.name,
					role: wgMembers.role,
					deactivatedAt: wgMembers.deactivatedAt,
					paypalMerchantId: wgMembers.paypalMerchantId,
				})
				.from(wgMembers)
				.where(and(eq(wgMembers.id, id), eq(wgMembers.wgId, wgId)))
				.for('update');
			if (!target) return { ok: false as const, response: notFound('member_not_found') };

			const verifiedOwner = auth.member.verified && actor.id === target.id;
			const verifiedAdmin = auth.member.verified && actor.role === 'admin';
			if (active !== undefined && !verifiedOwner && !verifiedAdmin) {
				return { ok: false as const, response: forbidden('not_owner', 'not_owner') };
			}
			if (active === false && target.role === 'admin') {
				return { ok: false as const, response: forbidden('admin_required', 'admin_required') };
			}

			if (
				active === false &&
				target.deactivatedAt === null &&
				(await hasCapturingMemberPayment(tx, wgId, id))
			) {
				return { ok: false as const, response: conflict('paypal_payment_pending') };
			}
			const activeUnchanged = active === undefined || active === (target.deactivatedAt === null);
			if (activeUnchanged) {
				return { ok: true as const, changedActive: false, member: target };
			}

			const updateValues = {
				...(active !== undefined ? { deactivatedAt: active ? null : new Date() } : {}),
			};
			const [updated] = await tx
				.update(wgMembers)
				.set(updateValues)
				.where(and(eq(wgMembers.id, id), eq(wgMembers.wgId, wgId)))
				.returning({
					id: wgMembers.id,
					name: wgMembers.name,
					deactivatedAt: wgMembers.deactivatedAt,
					paypalMerchantId: wgMembers.paypalMerchantId,
				});
			if (!updated) return { ok: false as const, response: notFound('member_not_found') };
			// A moved-out member must not keep receiving pushes, and their browser
			// endpoint has to be free for the next WG on the same device.
			if (active === false) {
				await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.memberId, id));
			}
			return {
				ok: true as const,
				changedActive: active !== undefined && active !== (target.deactivatedAt === null),
				member: updated,
			};
		});
		if (!result.ok) return result.response;
		if (result.changedActive) {
			await recordAuditEvent({
				wgId,
				memberId: auth.member.memberId,
				eventType: active ? 'member.reactivated' : 'member.deactivated',
				entityType: 'member',
				entityId: result.member.id,
				summary: active
					? `${auth.member.name} hat ${result.member.name} wieder aktiviert.`
					: `${auth.member.name} hat ${result.member.name} als ausgezogen markiert.`,
				metadata: { name: result.member.name },
			});
		}
		return NextResponse.json({
			member: {
				id: result.member.id,
				name: result.member.name,
				active: result.member.deactivatedAt === null,
				...(auth.member.memberId === result.member.id && auth.member.verified
					? { paypalMerchantId: result.member.paypalMerchantId }
					: {}),
			},
		});
	},
);
