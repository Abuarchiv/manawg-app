'use client';

import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

interface MemberOption {
	id: string;
	name: string;
}

interface Props {
	names: readonly string[];
	mapping: Readonly<Record<string, string | null>>;
	members: readonly MemberOption[];
	onChange: (name: string, memberId: string | null) => void;
	showErrors?: boolean;
}

export function ImportMemberMapping({
	names,
	mapping,
	members,
	onChange,
	showErrors = false,
}: Props) {
	if (names.length === 0)
		return <p className="text-sm text-muted-foreground">Keine Namen erkannt.</p>;
	const memberIds = new Set(members.map((m) => m.id));
	return (
		<FieldGroup>
			{names.map((name, index) => {
				const selectedId = mapping[name] ?? '';
				// A mapping target that is not among the offered members (moved-out
				// member) is as invalid as no mapping at all — without this check the
				// field looked valid while the commit rejected it with
				// `member_not_in_wg`.
				const unknownMember = selectedId !== '' && !memberIds.has(selectedId);
				const invalid = showErrors && (selectedId === '' || unknownMember);
				const value = unknownMember ? '' : selectedId;
				return (
					<Field key={name} data-invalid={invalid || undefined}>
						<FieldLabel htmlFor={`import-map-${index}`}>{name}</FieldLabel>
						<NativeSelect
							id={`import-map-${index}`}
							value={value}
							onChange={(event) => onChange(name, event.target.value || null)}
							aria-label={`Mitglied für ${name} wählen`}
							aria-invalid={invalid || undefined}
							aria-describedby={invalid ? `import-map-error-${index}` : undefined}
							className="w-full [&_select]:h-11 [&_select]:text-base"
						>
							<NativeSelectOption value="">Noch zuordnen</NativeSelectOption>
							{members.map((member) => (
								<NativeSelectOption key={member.id} value={member.id}>
									{member.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
						{invalid && (
							<FieldError id={`import-map-error-${index}`}>
								{unknownMember
									? 'Dieses Mitglied gehört nicht (mehr) zu dieser WG. Bitte ein aktuelles Mitglied wählen.'
									: 'Bitte WG-Mitglied auswählen.'}
							</FieldError>
						)}
					</Field>
				);
			})}
		</FieldGroup>
	);
}
