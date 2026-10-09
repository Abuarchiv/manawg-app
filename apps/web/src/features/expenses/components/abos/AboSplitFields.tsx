'use client';

import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '@/components/ui/field';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from '@/components/ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { parseEuroAmount } from '@/core/utils/amount';
import { CENTS_PER_EURO, formatEuroCents } from '@/core/utils/money';
import type { AboSplit, MemberOption } from '@/features/expenses/components/abos/abos-types';
import { EqualParticipantsPicker } from '@/features/expenses/components/ausgaben/EqualParticipantsPicker';
import { SplitReview } from '@/features/expenses/components/ausgaben/SplitReview';
import type { AboSplitBuildError, SplitMode } from './abo-form-model';

interface AboSplitFieldsProps {
	submitting: boolean;
	splitMode: SplitMode;
	/** Total amount in cents for the live sum; null while the amount is invalid. */
	totalCents: number | null;
	onSplitModeChange: (mode: SplitMode) => void;
	splitCandidates: MemberOption[];
	/** Who shares an equal split; null means every active member. */
	participantIds: string[] | null;
	onParticipantsChange: (ids: string[] | null) => void;
	manualSplits: Record<string, string>;
	onManualSplitChange: (memberId: string, value: string) => void;
	splitError: string | null;
	splitPreview: AboSplit[] | AboSplitBuildError;
	paidByMemberId: string;
}

/** Only an unreadable share is a problem in itself; a wrong sum concerns no single field. */
function isUnreadableShare(raw: string | undefined): boolean {
	const value = raw?.trim() ?? '';
	if (value.length === 0) return false;
	const parsed = parseEuroAmount(value);
	return parsed === null || parsed < 0;
}

function splitSumHint(manualSplits: Record<string, string>, totalCents: number | null): string {
	if (totalCents === null) return 'Die Anteile müssen zusammen den Gesamtbetrag ergeben.';
	let sumCents = 0;
	for (const raw of Object.values(manualSplits)) {
		const parsed = parseEuroAmount(raw);
		if (parsed !== null && parsed > 0) sumCents += Math.round(parsed * CENTS_PER_EURO);
	}
	const base = `Verteilt ${formatEuroCents(sumCents)} von ${formatEuroCents(totalCents)}`;
	if (sumCents === totalCents) return `${base} · passt`;
	return sumCents < totalCents
		? `${base} · noch ${formatEuroCents(totalCents - sumCents)} offen`
		: `${base} · ${formatEuroCents(sumCents - totalCents)} zu viel`;
}

/** "Beteiligte & Aufteilung": equal split preview or one amount field per member. */
export function AboSplitFields({
	submitting,
	splitMode,
	totalCents,
	onSplitModeChange,
	splitCandidates,
	participantIds,
	onParticipantsChange,
	manualSplits,
	onManualSplitChange,
	splitError,
	splitPreview,
	paidByMemberId,
}: AboSplitFieldsProps) {
	return (
		<FieldSet
			disabled={submitting}
			data-invalid={Boolean(splitError)}
			aria-describedby={splitError ? 'abo-splits-error' : undefined}
		>
			<FieldLegend variant="label">Beteiligte & Aufteilung</FieldLegend>
			<ToggleGroup
				variant="segmented"
				value={[splitMode]}
				onValueChange={(values) => {
					const value = values[0];
					if (value === 'equal' || value === 'manual') onSplitModeChange(value);
				}}
				className="w-full"
				aria-label="Fixkosten-Aufteilung"
			>
				<ToggleGroupItem value="equal" className="flex-1">
					Gleichmäßig
				</ToggleGroupItem>
				<ToggleGroupItem value="manual" className="flex-1">
					Manuell
				</ToggleGroupItem>
			</ToggleGroup>
			{splitMode === 'manual' && (
				<FieldDescription>{splitSumHint(manualSplits, totalCents)}</FieldDescription>
			)}
			{splitMode === 'manual' && (
				<FieldGroup className={splitError ? 'block space-y-3' : 'gap-3'}>
					{splitCandidates.map((member, index) => (
						<Field key={member.id} orientation="responsive">
							<FieldLabel htmlFor={`abo-share-${member.id}`} className="min-w-0 flex-1 break-words">
								{member.name}
							</FieldLabel>
							<InputGroup className="w-full min-w-32 shrink-0 @md/field-group:max-w-32">
								<InputGroupInput
									id={`abo-share-${member.id}`}
									type="text"
									inputMode="decimal"
									value={manualSplits[member.id] ?? ''}
									onChange={(event) => onManualSplitChange(member.id, event.target.value)}
									placeholder="0,00"
									enterKeyHint={index === splitCandidates.length - 1 ? 'done' : 'next'}
									aria-label={`Anteil ${member.name} in Euro`}
									disabled={submitting}
									aria-invalid={Boolean(splitError) && isUnreadableShare(manualSplits[member.id])}
									aria-describedby={
										splitError && isUnreadableShare(manualSplits[member.id])
											? 'abo-splits-error'
											: undefined
									}
									className="min-h-11 font-mono tabular-nums text-base"
								/>
								<InputGroupAddon align="inline-end">
									<InputGroupText>€</InputGroupText>
								</InputGroupAddon>
							</InputGroup>
						</Field>
					))}
				</FieldGroup>
			)}
			{splitError && (
				<FieldError id="abo-splits-error" className="scroll-mb-32">
					{splitError}
				</FieldError>
			)}
			{splitMode !== 'manual' && (
				<EqualParticipantsPicker
					candidates={splitCandidates}
					participantIds={participantIds}
					onChange={onParticipantsChange}
					idPrefix="abo-participant"
					disabled={submitting}
				/>
			)}
			{splitMode !== 'manual' &&
				(typeof splitPreview === 'string' ? (
					<FieldDescription>Betrag eingeben, dann wird gleichmäßig aufgeteilt.</FieldDescription>
				) : (
					<SplitReview
						members={splitCandidates}
						splits={splitPreview}
						paidByMemberId={paidByMemberId}
					/>
				))}
		</FieldSet>
	);
}
