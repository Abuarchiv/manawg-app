'use client';

import { useTranslations } from 'next-intl';
import type { Ref } from 'react';
import { Switch } from '@/components/animate-ui/components/base/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import type { RejectedRow } from '@/features/expenses/import-parsers';
import { describeRejectedRowReason } from '@/features/expenses/import-parsers';
import { useMessage } from '@/shared/i18n/message';
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
	const t = useTranslations('expenses-import');
	const suggested = wizard.preview?.memberMapping ?? {};
	// A suggestion stops being one as soon as the member picks something else.
	const fuzzyNames = (wizard.preview?.fuzzyNames ?? []).filter(
		(name) => wizard.mapping[name] === suggested[name],
	);
	return (
		<section className="flex flex-col gap-4">
			<ImportStepHeading headingRef={headingRef}>{t('mapping.heading')}</ImportStepHeading>
			<p className="text-sm text-muted-foreground">
				{wizard.conflicts.length > 0
					? t('mapping.open')
					: fuzzyNames.length > 0
						? t('mapping.fuzzy')
						: t('mapping.allRecognised')}
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
					{t('actions.continueToPreview')}
				</Button>
				<Button variant="outline" onClick={() => wizard.goTo('input')}>
					{t('actions.back')}
				</Button>
			</div>
		</section>
	);
}

/** The rows the parser could not read, each with its line and reason, behind a disclosure. */
export function RejectedRowsDetails({ rejected }: { rejected: readonly RejectedRow[] }) {
	const t = useTranslations('expenses-import.preview');
	const renderMessage = useMessage();
	return (
		<details>
			<summary className="min-h-11 cursor-pointer py-2">{t('rejectedDetails')}</summary>
			<ul className="flex flex-col gap-1">
				{rejected.map((row) => (
					<li key={row.line}>
						{t('rejectedRow', {
							line: String(row.line),
							description: row.description,
							reason: renderMessage(describeRejectedRowReason(row.reason)),
						})}
					</li>
				))}
			</ul>
		</details>
	);
}

function RejectedRowsAlert({ rejected }: { rejected: readonly RejectedRow[] }) {
	const t = useTranslations('expenses-import.preview');
	if (rejected.length === 0) return null;
	return (
		<Alert>
			<AlertTitle>{t('rejectedTitle', { count: rejected.length })}</AlertTitle>
			<AlertDescription>
				<RejectedRowsDetails rejected={rejected} />
			</AlertDescription>
		</Alert>
	);
}

export function ImportPreviewStep({ headingRef, wizard }: StepProps) {
	const t = useTranslations('expenses-import');
	const { busy, selectedCount } = wizard;
	if (!wizard.preview) return null;
	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<ImportStepHeading headingRef={headingRef}>{t('preview.heading')}</ImportStepHeading>
				<Badge variant="secondary">{t('preview.selected', { count: String(selectedCount) })}</Badge>
			</div>
			<p className="text-sm text-muted-foreground">{t('preview.hint')}</p>
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
				<Field
					orientation="horizontal"
					className="min-h-11 items-center justify-between"
					data-disabled={busy}
				>
					<div className="flex flex-col gap-1">
						<FieldLabel htmlFor="import-duplicates">{t('preview.skipDuplicates')}</FieldLabel>
						<FieldDescription>{t('preview.skipDuplicatesHint')}</FieldDescription>
					</div>
					<Switch
						className="shrink-0"
						id="import-duplicates"
						checked={wizard.skipDuplicates}
						onCheckedChange={(checked) => wizard.setSkipDuplicates(checked === true)}
						disabled={busy}
					/>
				</Field>
			</FieldGroup>
			<div className="sticky bottom-[var(--app-nav-height,5rem)] flex min-w-0 flex-wrap gap-2 bg-background py-3">
				{busy && <ImportRunningBar decorative className="w-full basis-full" />}
				<Button
					className="flex-1"
					disabled={busy || selectedCount === 0}
					onClick={() => void wizard.submitCommit()}
				>
					{busy && <Spinner data-icon="inline-start" />}
					{t('actions.import', { count: String(selectedCount) })}
				</Button>
				<Button variant="outline" disabled={busy} onClick={() => wizard.goTo('mapping')}>
					{t('actions.back')}
				</Button>
			</div>
		</section>
	);
}
