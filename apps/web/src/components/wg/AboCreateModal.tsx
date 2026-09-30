'use client';

import { AboForm, type AboFormValues } from '@/components/wg/AboForm';
import { AboModalShell } from '@/components/wg/AboModalShell';
import type { MemberOption } from '@/components/wg/abos-types';

interface AboCreateModalProps {
	members: MemberOption[];
	defaultPaidByMemberId: string;
	submitting: boolean;
	saveError?: string | null | undefined;
	onClose: () => void;
	onSubmit: (values: AboFormValues) => void;
}

export function AboCreateModal({
	members,
	defaultPaidByMemberId,
	submitting,
	saveError,
	onClose,
	onSubmit,
}: AboCreateModalProps) {
	return (
		<AboModalShell title="Neue Fixkosten" onClose={onClose} submitting={submitting}>
			{(requestClose) => (
				<AboForm
					mode="create"
					members={members}
					defaultPaidByMemberId={defaultPaidByMemberId}
					submitting={submitting}
					saveError={saveError}
					onCancel={requestClose}
					onSubmit={onSubmit}
				/>
			)}
		</AboModalShell>
	);
}
