'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from '@/components/ui/input-group';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { AboSplit, MemberOption } from '@/components/wg/abos-types';
import { formatEuroInput, parseEuroAmount } from '@/core/utils/amount';
import { inputDateToIso } from '@/core/utils/local-date';
import { CENTS_PER_EURO } from '@/core/utils/money';
import { SplitReview } from '@/features/expenses/components/ausgaben/SplitReview';
import { splitInputErrorMessage } from '@/features/expenses/expense-errors';
import { useEffect, useMemo, useState } from 'react';

const DESCRIPTION_MAX = 200;
const AMOUNT_MIN_EUROS = 0.01;
const AMOUNT_MAX_EUROS = 1_000_000;

const INTERVAL_OPTIONS = [
	{ value: 1, label: '1 Monat' },
	{ value: 3, label: '3 Monate (Quartal)' },
	{ value: 6, label: '6 Monate' },
	{ value: 12, label: '12 Monate (Jahr)' },
] as const;

export interface AboFormValues {
	description: string;
	amountCents: number;
	paidByMemberId: string;
	intervalMonths: number;
	nextDueAt: string;
	splits: AboSplit[];
}

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

type SplitMode = 'equal' | 'manual';
type AboSplitBuildError =
	| 'amount_invalid'
	| 'invalid_share'
	| 'no_members'
	| 'splits_empty'
	| 'splits_mismatch';

function buildEqualSplits(members: MemberOption[], amountCents: number): AboSplit[] {
	// Only active members carry a share of a new equal split; members who
	// moved out stay in history but must not divide the amount.
	const participants = members.some((member) => member.active)
		? members.filter((member) => member.active)
		: members;
	if (participants.length === 0) return [];
	const base = Math.floor(amountCents / participants.length);
	const remainder = amountCents - base * participants.length;
	return participants.map((member, index) => ({
		debtorMemberId: member.id,
		amountCents: base + (index < remainder ? 1 : 0),
	}));
}

function todayInputValue(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function isoDateToInput(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return todayInputValue();
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function initialSplitMode(initial: AboFormValues | undefined, members: MemberOption[]): SplitMode {
	if (!initial) return 'equal';
	const equal = buildEqualSplits(members, initial.amountCents);
	const sameLength = initial.splits.length === equal.length;
	if (!sameLength) return 'manual';
	const sortedInitial = [...initial.splits].sort((a, b) =>
		a.debtorMemberId.localeCompare(b.debtorMemberId),
	);
	const sortedEqual = [...equal].sort((a, b) => a.debtorMemberId.localeCompare(b.debtorMemberId));
	const allEqual = sortedInitial.every((split, idx) => {
		const counterpart = sortedEqual[idx];
		return (
			counterpart !== undefined &&
			split.debtorMemberId === counterpart.debtorMemberId &&
			split.amountCents === counterpart.amountCents
		);
	});
	return allEqual ? 'equal' : 'manual';
}

function initialManualMap(initial: AboFormValues | undefined): Record<string, string> {
	if (!initial) return {};
	return Object.fromEntries(
		initial.splits.map((split) => [
			split.debtorMemberId,
			formatEuroInput(split.amountCents / CENTS_PER_EURO),
		]),
	);
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
	const [splitMode, setSplitMode] = useState<SplitMode>(initialSplitMode(initial, activeMembers));
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
		setSplitMode(initialSplitMode(initial, activeMembers));
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
			? 'Beschreibung fehlt.'
			: null;
	const amountError = error && parsedAmountCents === null ? 'Betrag ungültig.' : null;
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

	function buildSplits(): AboSplit[] | AboSplitBuildError {
		if (parsedAmountCents === null) return 'amount_invalid';
		if (splitMode === 'equal') {
			const equal = buildEqualSplits(activeMembers, parsedAmountCents);
			if (equal.length === 0) return 'no_members';
			return equal;
		}
		const splits: AboSplit[] = [];
		let sum = 0;
		for (const member of splitCandidates) {
			const raw = manualSplits[member.id] ?? '';
			if (raw.trim().length === 0) continue;
			const value = parseEuroAmount(raw);
			if (value === null || value < 0) return 'invalid_share';
			if (value === 0) continue;
			const cents = Math.round(value * CENTS_PER_EURO);
			splits.push({ debtorMemberId: member.id, amountCents: cents });
			sum += cents;
		}
		if (splits.length === 0) return 'splits_empty';
		if (sum !== parsedAmountCents) return 'splits_mismatch';
		return splits;
	}

	function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		setError(null);
		setSplitError(null);
		const trimmedDescription = description.trim();
		if (trimmedDescription.length === 0 || trimmedDescription.length > DESCRIPTION_MAX) {
			setError('Beschreibung fehlt.');
			return;
		}
		if (parsedAmountCents === null) {
			setError('Betrag ungültig.');
			return;
		}
		if (nextDueAt.trim().length === 0) {
			setError('Fälligkeit fehlt.');
			return;
		}
		const nextDueAtIso = inputDateToIso(nextDueAt);
		if (nextDueAtIso === null) {
			setError('Fälligkeit fehlt.');
			return;
		}
		const splits = buildSplits();
		if (typeof splits === 'string') {
			if (splits === 'amount_invalid') setError('Betrag ungültig.');
			else if (splits === 'no_members') setError('Keine Mitglieder vorhanden.');
			else setSplitError(splitInputErrorMessage(splits));
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
		<form onSubmit={handleSubmit} className="flex flex-col gap-5">
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
					<FieldError id="abo-next-due-error">{nextDueError}</FieldError>
				</Field>
				<FieldSet disabled={submitting} data-invalid={Boolean(splitError)}>
					<FieldLegend>Beteiligte & Aufteilung</FieldLegend>
					<ToggleGroup
						variant="segmented"
						value={[splitMode]}
						onValueChange={(values) => {
							const value = values[0];
							if (value === 'equal' || value === 'manual') {
								setSplitMode(value);
								setSplitError(null);
							}
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
						<FieldGroup className={splitError ? 'block space-y-3' : 'gap-3'}>
							{splitCandidates.map((member, index) => (
								<Field key={member.id} orientation="responsive">
									<FieldLabel
										htmlFor={`abo-share-${member.id}`}
										className="min-w-0 flex-1 break-words"
									>
										{member.name}
									</FieldLabel>
									<InputGroup className="w-full min-w-32 shrink-0 @md/field-group:max-w-32">
										<InputGroupInput
											id={`abo-share-${member.id}`}
											type="text"
											inputMode="decimal"
											value={manualSplits[member.id] ?? ''}
											onChange={(event) => {
												setManualSplits((current) => ({
													...current,
													[member.id]: event.target.value,
												}));
												setSplitError(null);
											}}
											placeholder="0,00"
											enterKeyHint={index === splitCandidates.length - 1 ? 'done' : 'next'}
											aria-label={`Anteil ${member.name} in Euro`}
											disabled={submitting}
											aria-invalid={Boolean(splitError)}
											aria-describedby={splitError ? 'abo-splits-error' : undefined}
											className="min-h-11 font-mono tabular-nums text-base"
										/>
										<InputGroupAddon align="inline-end">
											<InputGroupText>€</InputGroupText>
										</InputGroupAddon>
									</InputGroup>
								</Field>
							))}
							<FieldDescription>
								Die Anteile müssen zusammen den Gesamtbetrag ergeben.
							</FieldDescription>
						</FieldGroup>
					)}
					{splitError && <FieldError id="abo-splits-error">{splitError}</FieldError>}
					{splitMode !== 'manual' && (
						<SplitReview
							members={splitCandidates}
							splits={typeof splitPreview === 'string' ? null : splitPreview}
							paidByMemberId={paidByMemberId}
						/>
					)}
				</FieldSet>
				{(formError || saveError) && (
					<Alert variant="destructive">
						<AlertDescription>{formError ?? saveError}</AlertDescription>
					</Alert>
				)}
			</FieldGroup>
			<div className="sticky bottom-0 flex flex-col gap-3 bg-popover pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
				<Separator />
				<p className="text-xs text-muted-foreground">
					{intervalMonths === 1 ? 'Monatlich' : `Alle ${intervalMonths} Monate`} · keine
					automatische Überweisung.
				</p>
				<div className="flex flex-col gap-2">
					<Button type="submit" className="w-full" disabled={submitting}>
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
			</div>
		</form>
	);
}
