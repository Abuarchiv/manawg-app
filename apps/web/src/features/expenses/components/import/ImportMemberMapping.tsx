'use client';

import { Badge } from '@/components/ui/badge';
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
	/** Names the server matched by similarity only. */
	suggestedNames?: readonly string[];
}

export function ImportMemberMapping({
	names,
	mapping,
	members,
	onChange,
	showErrors = false,
	suggestedNames = [],
}: Props) {
	if (names.length === 0)
		return <p className="text-sm text-muted-foreground">Keine Namen erkannt.</p>;
	return (
		<FieldGroup>
			{names.map((name, index) => {
				const mapped = mapping[name];
				// A stale id (e.g. a moved-out member) is shown as unassigned and flagged.
				const value = mapped && members.some((member) => member.id === mapped) ? mapped : '';
				const invalid = showErrors && !value;
				return (
					<Field key={name} data-invalid={invalid || undefined}>
						<FieldLabel htmlFor={`import-map-${index}`}>
							{name}
							{value && suggestedNames.includes(name) && (
								<Badge variant="secondary">Vorschlag, bitte prüfen</Badge>
							)}
						</FieldLabel>
						<NativeSelect
							id={`import-map-${index}`}
							value={value}
							onChange={(event) => onChange(name, event.target.value || null)}
							aria-label={`Mitglied für ${name} wählen`}
							aria-invalid={invalid || undefined}
							aria-describedby={invalid ? `import-map-error-${index}` : undefined}
							className="w-full [&_select]:h-auto [&_select]:py-[0.5625rem] [&_select]:text-base"
						>
							<NativeSelectOption value="">Noch zuordnen</NativeSelectOption>
							{members.map((member) => (
								<NativeSelectOption key={member.id} value={member.id}>
									{member.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
						{invalid && (
							<FieldError id={`import-map-error-${index}`}>Bitte WG-Mitglied auswählen.</FieldError>
						)}
					</Field>
				);
			})}
		</FieldGroup>
	);
}
