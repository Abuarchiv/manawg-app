'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from '@/components/ui/input-group';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { formatEuroInput, parseEuroAmount } from '@/core/utils/amount';
import { inputDateToIso, todayInputValue } from '@/core/utils/local-date';
import { CENTS_PER_EURO } from '@/core/utils/money';
import type { MemberOption } from '@/features/expenses/components/abos/abos-types';
import { amountErrorMessage } from '@/features/expenses/components/ausgaben/constants';
import { splitInputErrorMessage } from '@/features/expenses/expense-errors';
import { countMissedOccurrences } from '@/features/expenses/recurring-expenses';
import { useEffect, useMemo, useState } from 'react';
import { AboSplitFields } from './AboSplitFields';
import {
	AMOUNT_MAX_EUROS,
	AMOUNT_MIN_EUROS,
	type AboFormValues,
	DESCRIPTION_MAX,
	INTERVAL_OPTIONS,
	type SplitMode,
	buildAboSplits,
	initialEqualParticipants,
	initialManualMap,
	isoDateToInput,
} from './abo-form-model';

export type { AboFormValues } from './abo-form-model';

interface AboFormProps {
	mode: 'create' | 'edit';
	members: MemberOption[];
	initial?: AboFormValues;
	defaultPaidByMemberId: string;
	submitting: boolean;
	saveError?: string | null | undefined;
	onCancel: () => void;
	onSubmit: (values: AboFormValues) => void;
}

export function AboForm({
	mode,
	members,
	initial,
	defaultPaidByMemberId,
	submitting,
	saveError,
	onCancel,
	onSubmit,
}: AboFormProps) {
	// Only active members are offered for new selections ("aus Listen raus").
	// Moved-out members are re-added below where an existing abo still references
	// them, so editing never silently drops or reassigns a participant.
	const activeMembers = useMemo(() => members.filter((member) => member.active), [members]);

	const [description, setDescription] = useState(initial?.description ?? '');
	const [amountStr, setAmountStr] = useState(
		initial ? formatEuroInput(initial.amountCents / CENTS_PER_EURO) : '',
	);
	const [paidByMemberId, setPaidByMemberId] = useState(
		initial?.paidByMemberId ?? defaultPaidByMemberId,
	);
	const [intervalMonths, setIntervalMonths] = useState(initial?.intervalMonths ?? 1);
	const [nextDueAt, setNextDueAt] = useState(
		initial ? isoDateToInput(initial.nextDueAt) : todayInputValue(),
	);
	const initialParticipants = initialEqualParticipants(initial, activeMembers);
	const [splitMode, setSplitMode] = useState<SplitMode>(
		initialParticipants === 'manual' ? 'manual' : 'equal',
	);
	const [participantIds, setParticipantIds] = useState<string[] | null>(
		initialParticipants === 'manual' ? null : initialParticipants,
	);
	const [manualSplits, setManualSplits] = useState<Record<string, string>>(
		initialManualMap(initial),
	);
	const [error, setError] = useState<string | null>(null);
	const [splitError, setSplitError] = useState<string | null>(null);

	useEffect(() => {
		if (!initial) return;
		setDescription(initial.description);
		setAmountStr(formatEuroInput(initial.amountCents / CENTS_PER_EURO));
		setPaidByMemberId(initial.paidByMemberId);
		setIntervalMonths(initial.intervalMonths);
		setNextDueAt(isoDateToInput(initial.nextDueAt));
		const participants = initialEqualParticipants(initial, activeMembers);
		setSplitMode(participants === 'manual' ? 'manual' : 'equal');
		setParticipantIds(participants === 'manual' ? null : participants);
		setManualSplits(initialManualMap(initial));
		setSplitError(null);
	}, [initial, activeMembers]);

	const parsedAmountCents = useMemo(() => {
		const euros = parseEuroAmount(amountStr);
		if (euros === null || euros < AMOUNT_MIN_EUROS || euros > AMOUNT_MAX_EUROS) return null;
		return Math.round(euros * CENTS_PER_EURO);
	}, [amountStr]);
	const descriptionError =
		error && (description.trim().length === 0 || description.trim().length > DESCRIPTION_MAX)
			? 'Gib eine kurze Beschreibung ein.'
			: null;
	const amountError =
		error && parsedAmountCents === null
			? amountErrorMessage(parseEuroAmount(amountStr), amountStr)
			: null;
	// A start in the past is booked retroactively by the daily run; say so before it happens.
	const dueDateChanged = !initial || nextDueAt !== isoDateToInput(initial.nextDueAt);
	const missedBookings =
		dueDateChanged && nextDueAt.length > 0 && nextDueAt < todayInputValue()
			? countMissedOccurrences(inputDateToIso(nextDueAt) ?? '', intervalMonths)
			: 0;
	const nextDueError = error && nextDueAt.trim().length === 0 ? 'Fälligkeit fehlt.' : null;
	const formError = error && !descriptionError && !amountError && !nextDueError ? error : null;

	// Payer dropdown offers active members, but keeps the currently selected
	// payer visible even if they moved out — otherwise saving would silently
	// reassign the abo to someone else.
	const payerOptions = useMemo(() => {
		if (activeMembers.some((member) => member.id === paidByMemberId)) return activeMembers;
		return [...activeMembers, ...members.filter((member) => member.id === paidByMemberId)];
	}, [activeMembers, members, paidByMemberId]);

	// Manual split rows show active members plus any moved-out member who still
	// carries a share, so an edit preserves the stored amounts (sum stays exact).
	const splitCandidates = useMemo(() => {
		if (splitMode !== 'manual') return activeMembers;
		return members.filter(
			(member) => member.active || (manualSplits[member.id] ?? '').trim().length > 0,
		);
	}, [activeMembers, members, splitMode, manualSplits]);
	function buildSplits() {
		return buildAboSplits({
			amountCents: parsedAmountCents,
			splitMode,
			activeMembers,
			splitCandidates,
			manualSplits,
			participantIds,
		});
	}

	function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		setError(null);
		setSplitError(null);
		const trimmedDescription = description.trim();
		if (trimmedDescription.length === 0 || trimmedDescription.length > DESCRIPTION_MAX) {
			setError('Gib eine kurze Beschreibung ein.');
			return;
		}
		if (parsedAmountCents === null) {
			setError(amountErrorMessage(parseEuroAmount(amountStr), amountStr));
			return;
		}
		if (nextDueAt.trim().length === 0) {
			setError('Fälligkeit fehlt.');
			return;
		}
		// An unchanged date keeps the stored timestamp: otherwise every edit would move it to
		// 12:00 local time, and the server would reject a long-overdue date as out of range.
		const nextDueAtIso =
			initial && nextDueAt === isoDateToInput(initial.nextDueAt)
				? initial.nextDueAt
				: inputDateToIso(nextDueAt);
		if (nextDueAtIso === null) {
			setError('Fälligkeit fehlt.');
			return;
		}
		const splits = buildSplits();
		if (typeof splits === 'string') {
			if (splits === 'amount_invalid') setError('Gib einen Betrag über 0 € ein, z. B. 12,50.');
			else if (splits === 'no_members') setError('Keine Mitglieder vorhanden.');
			else {
				setSplitError(splitInputErrorMessage(splits));
				// The message sits below the fields, often outside the visible area.
				requestAnimationFrame(() =>
					document.getElementById('abo-splits-error')?.scrollIntoView({ block: 'nearest' }),
				);
			}
			return;
		}
		onSubmit({
			description: trimmedDescription,
			amountCents: parsedAmountCents,
			paidByMemberId,
			intervalMonths,
			nextDueAt: nextDueAtIso,
			splits,
		});
	}

	const splitPreview = buildSplits();
	return (
		<form onSubmit={handleSubmit} className="flex min-h-full flex-col gap-5">
			<FieldGroup>
				<Field data-disabled={submitting} data-invalid={Boolean(descriptionError)}>
					<FieldLabel htmlFor="abo-description">Beschreibung</FieldLabel>
					<Input
						id="abo-description"
						value={description}
						maxLength={DESCRIPTION_MAX}
						onChange={(event) => setDescription(event.target.value)}
						placeholder="z. B. Netflix"
						disabled={submitting}
						enterKeyHint="next"
						className="text-base"
						aria-invalid={Boolean(descriptionError)}
						aria-describedby={descriptionError ? 'abo-description-error' : undefined}
					/>
					<FieldError id="abo-description-error">{descriptionError}</FieldError>
				</Field>
				<Field data-disabled={submitting} data-invalid={Boolean(amountError)}>
					<FieldLabel htmlFor="abo-amount">Betrag</FieldLabel>
					<InputGroup>
						<InputGroupInput
							id="abo-amount"
							type="text"
							inputMode="decimal"
							value={amountStr}
							onChange={(event) => {
								setAmountStr(event.target.value);
								setSplitError(null);
							}}
							placeholder="0,00"
							disabled={submitting}
							enterKeyHint="next"
							className="min-h-11 font-mono tabular-nums text-base"
							aria-invalid={Boolean(amountError)}
							aria-describedby={amountError ? 'abo-amount-error' : undefined}
						/>
						<InputGroupAddon align="inline-end">
							<InputGroupText>€</InputGroupText>
						</InputGroupAddon>
					</InputGroup>
					<FieldError id="abo-amount-error">{amountError}</FieldError>
				</Field>
				<Field data-disabled={submitting}>
					<FieldLabel htmlFor="abo-paid-by">Bezahlt von</FieldLabel>
					<NativeSelect
						id="abo-paid-by"
						value={paidByMemberId}
						onChange={(event) => setPaidByMemberId(event.target.value)}
						disabled={submitting}
						className="w-full [&_select]:h-11 [&_select]:text-base"
					>
						{payerOptions.map((member) => (
							<NativeSelectOption key={member.id} value={member.id}>
								{member.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
				<Field data-disabled={submitting}>
					<FieldLabel htmlFor="abo-interval">Intervall</FieldLabel>
					<NativeSelect
						id="abo-interval"
						value={intervalMonths}
						onChange={(event) => setIntervalMonths(Number(event.target.value))}
						disabled={submitting}
						className="w-full [&_select]:h-11 [&_select]:text-base"
					>
						{!INTERVAL_OPTIONS.some((option) => option.value === intervalMonths) && (
							<NativeSelectOption value={intervalMonths}>
								{intervalMonths} Monate
							</NativeSelectOption>
						)}
						{INTERVAL_OPTIONS.map((option) => (
							<NativeSelectOption key={option.value} value={option.value}>
								{option.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
				<Field data-disabled={submitting} data-invalid={Boolean(nextDueError)}>
					<FieldLabel htmlFor="abo-next-due">
						{mode === 'create' ? 'Erste Fälligkeit' : 'Nächste Fälligkeit'}
					</FieldLabel>
					<Input
						id="abo-next-due"
						type="date"
						value={nextDueAt}
						onChange={(event) => setNextDueAt(event.target.value)}
						disabled={submitting}
						required
						aria-invalid={Boolean(nextDueError)}
						aria-describedby={nextDueError ? 'abo-next-due-error' : undefined}
						className="text-base"
					/>
					{missedBookings > 0 && (
						<FieldDescription>
							Liegt in der Vergangenheit: Beim nächsten täglichen Lauf{' '}
							{missedBookings === 1 ? 'wird 1 Buchung' : `werden ${missedBookings} Buchungen`}{' '}
							nachgetragen und die WG wird benachrichtigt.
						</FieldDescription>
					)}
					<FieldError id="abo-next-due-error">{nextDueError}</FieldError>
				</Field>
				<AboSplitFields
					submitting={submitting}
					splitMode={splitMode}
					totalCents={parsedAmountCents}
					onSplitModeChange={(value) => {
						setSplitMode(value);
						setSplitError(null);
					}}
					splitCandidates={splitCandidates}
					participantIds={participantIds}
					onParticipantsChange={(ids) => {
						setParticipantIds(ids);
						setSplitError(null);
					}}
					manualSplits={manualSplits}
					onManualSplitChange={(memberId, value) => {
						setManualSplits((current) => ({ ...current, [memberId]: value }));
						setSplitError(null);
					}}
					splitError={splitError}
					splitPreview={splitPreview}
					paidByMemberId={paidByMemberId}
				/>
			</FieldGroup>
			<div className="sticky bottom-0 mt-auto flex flex-col gap-2 bg-popover pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
				{(formError || saveError) && (
					<Alert variant="destructive">
						<AlertDescription>{formError ?? saveError}</AlertDescription>
					</Alert>
				)}
				<Button type="submit" className="w-full whitespace-normal" disabled={submitting}>
					{submitting && <Spinner data-icon="inline-start" />}
					{mode === 'create' ? 'Fixkosten anlegen' : 'Speichern'}
				</Button>
				<Button
					type="button"
					variant="ghost"
					className="w-full"
					onClick={onCancel}
					disabled={submitting}
				>
					Abbrechen
				</Button>
			</div>
		</form>
	);
}
