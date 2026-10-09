'use client';

import { Checkbox } from '@/components/animate-ui/components/base/checkbox';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';

interface EqualParticipantsPickerProps {
	candidates: ReadonlyArray<{ id: string; name: string }>;
	/** Who shares the cost; null means every candidate. */
	participantIds: readonly string[] | null;
	/** Receives null when everyone is selected. */
	onChange: (ids: string[] | null) => void;
	idPrefix: string;
	disabled?: boolean;
}

/** One checkbox per active member for an equal split; the last selected person stays checked. */
export function EqualParticipantsPicker({
	candidates,
	participantIds,
	onChange,
	idPrefix,
	disabled = false,
}: EqualParticipantsPickerProps) {
	if (candidates.length < 2) return null;
	const chosen = new Set(participantIds ?? candidates.map((member) => member.id));
	function toggle(memberId: string, checked: boolean): void {
		const next = new Set(chosen);
		if (checked) next.add(memberId);
		else next.delete(memberId);
		onChange(next.size === candidates.length ? null : [...next]);
	}
	return (
		<FieldGroup className="gap-1" aria-label="Beteiligte Personen">
			{candidates.map((member) => {
				const checked = chosen.has(member.id);
				return (
					<Field key={member.id} orientation="horizontal" className="min-h-11 items-center">
						<Checkbox
							id={`${idPrefix}-${member.id}`}
							className="relative after:absolute after:-inset-3"
							checked={checked}
							onCheckedChange={(next) => toggle(member.id, next === true)}
							disabled={disabled || (checked && chosen.size === 1)}
						/>
						<FieldLabel htmlFor={`${idPrefix}-${member.id}`} className="min-w-0 break-words">
							{member.name}
						</FieldLabel>
					</Field>
				);
			})}
		</FieldGroup>
	);
}
