'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
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
import type { Member } from '@/components/wg/WgContextProvider';
import { formatEuroInput, parseEuroAmount } from '@/core/utils/amount';
import { formatEuroCents } from '@/core/utils/money';
import { type ReopenedShare, remainderCandidates } from '@/features/expenses/expense-split-input';
import type { Dispatch, SetStateAction } from 'react';
import { EqualParticipantsPicker } from './EqualParticipantsPicker';
import { ManualSplitSummary } from './ManualSplitSummary';
import { SplitReview } from './SplitReview';
import type { SplitMode } from './expense-form-draft';

interface ExpenseSplitFieldsetProps {
	members: Member[];
	splitCandidates: Member[];
	splitMode: SplitMode;
	setSplitMode: Dispatch<SetStateAction<SplitMode>>;
	manualSplits: Record<string, string>;
	setManualSplits: Dispatch<SetStateAction<Record<string, string>>>;
	/** Who shares an equal split; null means every active member. */
	participantIds: string[] | null;
	setParticipantIds: (ids: string[] | null) => void;
	/** Paid shares the current edit would reopen. */
	reopenedShares: ReopenedShare[];
	splitsError: string | undefined;
	onClearSplitsError: () => void;
	amountStr: string;
	currency: string;
	paidByMemberId: string;
	previewSplits: Array<{ debtorMemberId: string; amountCents: number }> | null;
	isEditingExpense: boolean;
	formSaving: boolean;
}

/**
 * "Beteiligte & Aufteilung": equal split preview or one share field per member. When an
 * existing expense has a moved-out member's share, that share stays locked.
 */
export function ExpenseSplitFieldset({
	members,
	splitCandidates,
	splitMode,
	setSplitMode,
	manualSplits,
	setManualSplits,
	participantIds,
	setParticipantIds,
	reopenedShares,
	splitsError,
	onClearSplitsError,
	amountStr,
	currency,
	paidByMemberId,
	previewSplits,
	isEditingExpense,
	formSaving,
}: ExpenseSplitFieldsetProps) {
	const splitErrorId = 'expense-splits-error';
	const hasLockedHistoricalShare =
		isEditingExpense && splitCandidates.some((member) => !member.active);
	const historicalShareHintId = `${splitErrorId}-inactive-share`;
	const remainderMembers = remainderCandidates(members);
	const firstSplitMemberId = splitCandidates[0]?.id;
	const memberName = (id: string) => members.find((member) => member.id === id)?.name ?? '?';
	const splitErrorTargetsMode =
		Boolean(splitsError) && (splitMode !== 'manual' || firstSplitMemberId === undefined);
	return (
		<FieldSet disabled={formSaving} data-invalid={Boolean(splitsError)}>
			<FieldLegend variant="label">Beteiligte & Aufteilung</FieldLegend>
			<ToggleGroup
				variant="segmented"
				value={[splitMode]}
				onValueChange={(values) => {
					onClearSplitsError();
					const value = values[0];
					if (value === 'equal' || value === 'manual') setSplitMode(value);
				}}
				className="w-full"
				aria-label="Aufteilung"
				aria-invalid={splitErrorTargetsMode ? true : undefined}
				aria-describedby={splitErrorTargetsMode ? splitErrorId : undefined}
			>
				<ToggleGroupItem
					value="equal"
					className="flex-1"
					disabled={hasLockedHistoricalShare}
					aria-label="Aufteilung: Gleichmäßig"
					aria-describedby={hasLockedHistoricalShare ? historicalShareHintId : undefined}
				>
					Gleichmäßig
				</ToggleGroupItem>
				<ToggleGroupItem value="manual" className="flex-1" aria-label="Aufteilung: Manuell">
					Manuell
				</ToggleGroupItem>
			</ToggleGroup>
			{hasLockedHistoricalShare && (
				<FieldDescription id={historicalShareHintId}>
					Ausgezogene Anteile bleiben unverändert; nur aktive Personen übernehmen den Rest.
				</FieldDescription>
			)}
			{splitsError && <FieldError id={splitErrorId}>{splitsError}</FieldError>}
			{splitMode === 'manual' && (
				<FieldGroup className={splitsError ? 'block space-y-3' : 'gap-3'}>
					{splitCandidates.map((member, index) => (
						<Field
							key={member.id}
							orientation="responsive"
							data-disabled={formSaving || (isEditingExpense && !member.active)}
						>
							<FieldLabel htmlFor={`share-${member.id}`} className="min-w-0 flex-1 break-words">
								{member.name}
								{isEditingExpense && !member.active && (
									<span className="ml-1 text-xs font-normal text-muted-foreground">
										(ausgezogen)
									</span>
								)}
							</FieldLabel>
							<InputGroup className="w-full min-w-32 shrink-0 has-[[data-slot][aria-invalid=true]]:border-input has-[[data-slot][aria-invalid=true]]:ring-0 @md/field-group:max-w-32">
								<InputGroupInput
									id={`share-${member.id}`}
									type="text"
									inputMode="decimal"
									value={manualSplits[member.id] ?? ''}
									onChange={(event) => {
										setManualSplits((previous) => ({
											...previous,
											[member.id]: event.target.value,
										}));
										onClearSplitsError();
									}}
									onBlur={(event) => {
										const euros = parseEuroAmount(event.target.value);
										if (euros === null || euros < 0) return;
										const formatted = formatEuroInput(euros);
										setManualSplits((previous) => ({ ...previous, [member.id]: formatted }));
									}}
									placeholder="0,00"
									disabled={formSaving || (isEditingExpense && !member.active)}
									enterKeyHint={index === splitCandidates.length - 1 ? 'done' : 'next'}
									aria-label={`Anteil ${member.name} in ${currency === 'EUR' ? 'Euro' : currency}${isEditingExpense && !member.active ? ', ausgezogen. Anteil bleibt unverändert.' : ''}`}
									aria-invalid={
										Boolean(splitsError) && member.id === firstSplitMemberId ? true : undefined
									}
									aria-describedby={
										Boolean(splitsError) && member.id === firstSplitMemberId
											? splitErrorId
											: undefined
									}
									className="min-h-11 font-mono tabular-nums text-base"
								/>
								<InputGroupAddon align="inline-end">
									<InputGroupText>{currency === 'EUR' ? '€' : currency}</InputGroupText>
								</InputGroupAddon>
							</InputGroup>
						</Field>
					))}
					<ManualSplitSummary
						amountStr={amountStr}
						currency={currency}
						manualSplits={manualSplits}
						members={remainderMembers}
						setManualSplits={setManualSplits}
						disabled={formSaving}
					/>
					{!splitsError && (
						<FieldDescription>
							Leer lassen oder{' '}
							<span className="font-mono tabular-nums">{formatEuroCents(0, currency)}</span> für
							keinen Anteil.
						</FieldDescription>
					)}
				</FieldGroup>
			)}
			{splitMode !== 'manual' && (
				<EqualParticipantsPicker
					candidates={splitCandidates}
					participantIds={participantIds}
					onChange={(ids) => {
						onClearSplitsError();
						setParticipantIds(ids);
					}}
					idPrefix="participant"
					disabled={formSaving}
				/>
			)}
			{splitMode !== 'manual' && (
				<SplitReview
					members={splitCandidates}
					splits={previewSplits}
					paidByMemberId={paidByMemberId}
					currency={currency}
				/>
			)}
			{reopenedShares.length > 0 && (
				<Alert>
					<AlertDescription className="flex flex-col gap-1">
						{reopenedShares.map((share) => (
							<span key={share.debtorMemberId}>
								Der Anteil von {memberName(share.debtorMemberId)} (
								{formatEuroCents(share.previousCents, currency)}) ist schon als bezahlt vermerkt und
								wird wegen der Änderung wieder geöffnet
								{share.nextCents === null
									? ' (entfällt).'
									: ` (neu ${formatEuroCents(share.nextCents, currency)}).`}
							</span>
						))}
					</AlertDescription>
				</Alert>
			)}
		</FieldSet>
	);
}
