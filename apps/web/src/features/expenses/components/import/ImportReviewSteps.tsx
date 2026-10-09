'use client';

import { Checkbox } from '@/components/animate-ui/components/base/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { describeRejectedRowReason } from '@/features/expenses/import-parsers';
import type { RejectedRow } from '@/features/expenses/import-parsers';
import type { Ref } from 'react';
import { ImportMemberMapping } from './ImportMemberMapping';
import { ImportPreviewTable } from './ImportPreviewTable';
import { ImportRunningBar } from './ImportProgress';
import { ImportStepHeading } from './ImportStepHeading';
import type { ImportWizardState } from './use-import-wizard';

interface StepProps {
	headingRef: Ref<HTMLHeadingElement>;
	wizard: ImportWizardState;
}

export function ImportMappingStep({ headingRef, wizard }: StepProps) {
	const suggested = wizard.preview?.memberMapping ?? {};
	// A suggestion stops being one as soon as the member picks something else.
	const fuzzyNames = (wizard.preview?.fuzzyNames ?? []).filter(
		(name) => wizard.mapping[name] === suggested[name],
	);
	return (
		<section className="flex flex-col gap-4">
			<ImportStepHeading headingRef={headingRef}>Namen WG-Mitgliedern zuordnen</ImportStepHeading>
			<p className="text-sm text-muted-foreground">
				{wizard.conflicts.length > 0
					? 'Ordne die Namen zu, die noch offen sind.'
					: fuzzyNames.length > 0
						? 'Einige Namen wurden nur nach Ähnlichkeit zugeordnet. Bitte prüfen.'
						: 'Alle Namen automatisch erkannt. Bitte prüfen.'}
			</p>
			<ImportMemberMapping
				names={wizard.namesNeedingMapping}
				mapping={wizard.mapping}
				members={wizard.memberOptions}
				onChange={wizard.updateMapping}
				showErrors={wizard.mappingValidated}
				suggestedNames={fuzzyNames}
			/>
			<div className="flex min-w-0 flex-wrap gap-2">
				<Button className="flex-1" onClick={wizard.continueFromMapping}>
					Weiter zur Vorschau
				</Button>
				<Button variant="outline" onClick={() => wizard.goTo('input')}>
					Zurück
				</Button>
			</div>
		</section>
	);
}

function RejectedRowsAlert({ rejected }: { rejected: readonly RejectedRow[] }) {
	if (rejected.length === 0) return null;
	return (
		<Alert>
			<AlertTitle>
				{rejected.length === 1
					? '1 Zeile konnte nicht gelesen werden'
					: `${rejected.length} Zeilen konnten nicht gelesen werden`}
			</AlertTitle>
			<AlertDescription>
				<details>
					<summary className="min-h-11 cursor-pointer py-2">Details anzeigen</summary>
					<ul className="flex flex-col gap-1">
						{rejected.map((row) => (
							<li key={row.line}>
								Zeile {row.line}: {row.description} ({describeRejectedRowReason(row.reason)})
							</li>
						))}
					</ul>
				</details>
			</AlertDescription>
		</Alert>
	);
}

export function ImportPreviewStep({ headingRef, wizard }: StepProps) {
	const { busy, selectedCount } = wizard;
	if (!wizard.preview) return null;
	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<ImportStepHeading headingRef={headingRef}>Vorschau</ImportStepHeading>
				<Badge variant="secondary">{selectedCount} ausgewählt</Badge>
			</div>
			<p className="text-sm text-muted-foreground">
				Prüfe Beträge und Anteile. Nicht gewünschte Einträge abwählen.
			</p>
			<RejectedRowsAlert rejected={wizard.preview.rejected ?? []} />
			<ImportPreviewTable
				expenses={wizard.preview.parsed}
				mapping={wizard.mapping}
				members={wizard.memberOptions}
				skipIndexes={wizard.skipIndexes}
				onToggleSkip={wizard.toggleSkip}
				disabled={busy}
			/>
			<FieldGroup>
				<Field orientation="horizontal" className="min-h-11 items-start" data-disabled={busy}>
					<Checkbox
						className="relative mt-0.5 after:absolute after:-inset-3"
						id="import-duplicates"
						checked={wizard.skipDuplicates}
						onCheckedChange={(checked) => wizard.setSkipDuplicates(checked === true)}
						disabled={busy}
					/>
					<div className="flex flex-col gap-1">
						<FieldLabel htmlFor="import-duplicates">Duplikate überspringen</FieldLabel>
						<FieldDescription>
							Gleiches Datum, Beschreibung, Betrag und zahlende Person.
						</FieldDescription>
					</div>
				</Field>
			</FieldGroup>
			<div className="sticky bottom-[var(--app-nav-height,5rem)] flex min-w-0 flex-wrap gap-2 bg-background py-3">
				{busy && <ImportRunningBar decorative className="w-full basis-full" />}
				<Button
					className="flex-1"
					disabled={busy || selectedCount === 0}
					onClick={() => void wizard.submitCommit()}
				>
					{busy && <Spinner data-icon="inline-start" />}Importieren ({selectedCount})
				</Button>
				<Button variant="outline" disabled={busy} onClick={() => wizard.goTo('mapping')}>
					Zurück
				</Button>
			</div>
		</section>
	);
}
