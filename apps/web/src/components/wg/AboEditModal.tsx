'use client';

import { AboForm, type AboFormValues } from '@/components/wg/AboForm';
import { AboModalShell } from '@/components/wg/AboModalShell';
import type { Abo, MemberOption } from '@/components/wg/abos-types';
import { useMemo } from 'react';

interface AboEditModalProps {
	abo: Abo;
	members: MemberOption[];
	submitting: boolean;
	saveError?: string | null | undefined;
	onClose: () => void;
	onSubmit: (values: AboFormValues) => void;
}

export function AboEditModal({
	abo,
	members,
	submitting,
	saveError,
	onClose,
	onSubmit,
}: AboEditModalProps) {
	// AboForm resyncs its fields whenever `initial` changes identity (so
	// switching to a different abo picks up fresh values). A fresh object
	// literal here would give it a new identity on every re-render of this
	// modal — e.g. any unrelated state change on the parent abos page while
	// the user is mid-edit — silently discarding whatever they just typed.
	// Keying the memo on `abo` ties the identity to the actual data instead.
	const initial = useMemo(
		() => ({
			description: abo.description,
			amountCents: abo.amountCents,
			paidByMemberId: abo.paidByMemberId,
			intervalMonths: abo.intervalMonths,
			nextDueAt: abo.nextDueAt,
			splits: abo.splits,
		}),
		[abo],
	);

	return (
		<AboModalShell title="Fixkosten bearbeiten" onClose={onClose} submitting={submitting}>
			{(requestClose) => (
				<AboForm
					mode="edit"
					members={members}
					submitting={submitting}
					saveError={saveError}
					defaultPaidByMemberId={abo.paidByMemberId}
					initial={initial}
					onCancel={requestClose}
					onSubmit={onSubmit}
				/>
			)}
		</AboModalShell>
	);
}
