'use client';

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type ActionNotice, ActionNoticeBanner } from '@/components/wg/ActionNoticeBanner';
import { ImageUploader } from '@/components/wg/ImageUploader';
import type { Member } from '@/components/wg/WgContextProvider';
import { formatEuroCents } from '@/core/utils/money';
import { remainderCandidates } from '@/features/expenses/expense-split-input';
import { ArrowLeft, ChevronDown, Receipt, Repeat2 } from 'lucide-react';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { ManualSplitSummary } from './ManualSplitSummary';
import { SplitReview } from './SplitReview';
import { TextField } from './TextField';
import { DESCRIPTION_MAX, RECURRING_INTERVAL_OPTIONS } from './constants';
import type { RecurringExpense } from './expense-types';
import type { SplitMode } from './useExpenseForm';

const EXPENSE_DESCRIPTION_FIELD_ID = 'expense-description';

export type ExpenseFormField = 'description' | 'amount' | 'splits';
export type ExpenseFormFieldErrors = Partial<Record<ExpenseFormField, string>>;

interface ExpenseFormSectionProps {
	description: string;
	setDescription: Dispatch<SetStateAction<string>>;
	amountStr: string;
	setAmountStr: Dispatch<SetStateAction<string>>;
	paidByMemberId: string;
	setPaidByMemberId: Dispatch<SetStateAction<string>>;
	members: Member[];
	payerOptions: Member[];
	splitCandidates: Member[];
	identityMemberId: string;
	splitMode: SplitMode;
	setSplitMode: Dispatch<SetStateAction<SplitMode>>;
	recurringIntervalMonths: number;
	setRecurringIntervalMonths: Dispatch<SetStateAction<number>>;
	manualSplits: Record<string, string>;
	setManualSplits: Dispatch<SetStateAction<Record<string, string>>>;
	imageUrl: string | null;
	setImageUrl: Dispatch<SetStateAction<string | null>>;
	shareCode: string;
	currency: string;
	isEditingQueuedExpense: boolean;
	isEditingQueuedRecurring: boolean;
	formError: string | null;
	fieldErrors: ExpenseFormFieldErrors;
	validationAttempt: number;
	onClearFieldError: (field: ExpenseFormField) => void;
	conflictExpenseId: string | null;
	onReloadServerVersion: () => void;
	onKeepDraft: () => void;
	savingRecurringTemplate: boolean;
	editingRecurringExpense: RecurringExpense | null;
	formSaving: boolean;
	onSaveRecurringTemplate: () => void;
	onCancel: () => void;
	onDiscard: () => void;
	title: string;
	previewSplits: Array<{ debtorMemberId: string; amountCents: number }> | null;
	pendingPrefillDescription: string | null;
	onReplacePrefill: () => void;
	isEditingExpense: boolean;
	editingExpenseId: string | null;
	notice: ActionNotice | null;
	onSubmit: () => void;
}

export function ExpenseFormSection({
	description,
	setDescription,
	amountStr,
	setAmountStr,
	paidByMemberId,
	setPaidByMemberId,
	members,
	payerOptions,
	splitCandidates,
	identityMemberId,
	splitMode,
	setSplitMode,
	recurringIntervalMonths,
	setRecurringIntervalMonths,
	manualSplits,
	setManualSplits,
	imageUrl,
	setImageUrl,
	shareCode,
	currency,
	isEditingQueuedExpense,
	isEditingQueuedRecurring,
	formError,
	fieldErrors,
	validationAttempt,
	onClearFieldError,
	conflictExpenseId,
	onReloadServerVersion,
	onKeepDraft,
	savingRecurringTemplate,
	editingRecurringExpense,
	formSaving,
	onSaveRecurringTemplate,
	onCancel,
	onDiscard,
	onSubmit,
	title,
	previewSplits,
	pendingPrefillDescription,
	onReplacePrefill,
	isEditingExpense,
	editingExpenseId,
	notice,
}: ExpenseFormSectionProps): React.ReactElement {
	const [showRecurring, setShowRecurring] = useState(false);
	const [showReceipt, setShowReceipt] = useState(Boolean(imageUrl));
	const [confirmClose, setConfirmClose] = useState(false);
	const [replaceOpen, setReplaceOpen] = useState(false);
	const formRef = useRef<HTMLFormElement>(null);
	const recurringOpen =
		showRecurring || editingRecurringExpense !== null || isEditingQueuedRecurring;
	const editingTemplate = Boolean(
		editingRecurringExpense && !isEditingQueuedExpense && !isEditingQueuedRecurring,
	);
	const formModeKey = editingRecurringExpense
		? `recurring:${editingRecurringExpense.id}`
		: isEditingExpense
			? `expense:${editingExpenseId ?? 'invalid'}`
			: 'new';
	const formStateKey = JSON.stringify({
		description,
		amountStr,
		paidByMemberId,
		splitMode,
		manualSplits: Object.entries(manualSplits).sort(([left], [right]) => left.localeCompare(right)),
		imageUrl,
		recurringIntervalMonths,
	});
	const emptyFormStateKey = JSON.stringify({
		description: '',
		amountStr: '',
		paidByMemberId: identityMemberId,
		splitMode: 'equal',
		manualSplits: [],
		imageUrl: null,
		recurringIntervalMonths: 1,
	});
	const initialStateKey =
		isEditingExpense || editingRecurringExpense !== null ? formStateKey : emptyFormStateKey;
	const initialFormStateRef = useRef({ formModeKey, formStateKey: initialStateKey });

	useEffect(() => {
		if (initialFormStateRef.current.formModeKey === formModeKey) return;
		initialFormStateRef.current = { formModeKey, formStateKey: initialStateKey };
	}, [formModeKey, initialStateKey]);

	useEffect(() => {
		if (validationAttempt === 0) return;
		formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
	}, [validationAttempt]);

	const isDirty = initialFormStateRef.current.formStateKey !== formStateKey;
	const splitErrorId = 'expense-splits-error';
	const hasLockedHistoricalShare =
		isEditingExpense && splitCandidates.some((member) => !member.active);
	const historicalShareHintId = `${splitErrorId}-inactive-share`;
	const remainderMembers = remainderCandidates(members);
	const firstSplitMemberId = splitCandidates[0]?.id;
	const splitErrorTargetsMode =
		Boolean(fieldErrors.splits) && (splitMode !== 'manual' || firstSplitMemberId === undefined);

	function requestClose() {
		if (formSaving || savingRecurringTemplate) return;
		if (isDirty) setConfirmClose(true);
		else onCancel();
	}

	return (
		<>
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open) requestClose();
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="top-0 flex h-dvh max-h-dvh w-full max-w-md translate-y-0 flex-col gap-0 rounded-none p-0"
					initialFocus={() => document.getElementById(EXPENSE_DESCRIPTION_FIELD_ID)}
				>
					<DialogHeader className="shrink-0 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
						<div className="flex items-center gap-2">
							<Button
								variant="ghost"
								size="icon"
								className="size-9"
								onClick={requestClose}
								disabled={formSaving}
								aria-label="Ausgabe abbrechen"
							>
								<ArrowLeft />
							</Button>
							<DialogTitle>{title}</DialogTitle>
						</div>
						<DialogDescription>Speichern löst keine Überweisung aus.</DialogDescription>
					</DialogHeader>
					<Separator />
					<form
						ref={formRef}
						className="flex min-h-0 flex-1 flex-col"
						onSubmit={(event) => {
							event.preventDefault();
							if (formSaving || savingRecurringTemplate) return;
							if (editingTemplate) onSaveRecurringTemplate();
							else onSubmit();
						}}
					>
						<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
							<FieldGroup>
								{notice && <ActionNoticeBanner notice={notice} />}
								{pendingPrefillDescription && (
									<Alert>
										<AlertDescription>Dein vorhandener Entwurf bleibt erhalten.</AlertDescription>
										<Button
											type="button"
											variant="outline"
											className="mt-3 h-auto w-full whitespace-normal"
											disabled={formSaving}
											onClick={() => setReplaceOpen(true)}
										>
											Entwurf verwerfen und „{pendingPrefillDescription}“ übernehmen
										</Button>
									</Alert>
								)}
								{(isEditingQueuedExpense || isEditingQueuedRecurring) && (
									<Alert>
										<AlertDescription>
											{isEditingQueuedRecurring
												? 'Wartende Fixkosten-Vorlage bearbeiten'
												: 'Wartende Ausgabe bearbeiten'}{' '}
											· noch nicht synchronisiert.
										</AlertDescription>
									</Alert>
								)}
								<TextField
									id={EXPENSE_DESCRIPTION_FIELD_ID}
									label="Beschreibung"
									value={description}
									onChange={(value) => {
										setDescription(value);
										onClearFieldError('description');
									}}
									maxLength={DESCRIPTION_MAX}
									placeholder="z. B. Wocheneinkauf"
									disabled={formSaving}
									error={fieldErrors.description}
									enterKeyHint="next"
								/>
								<TextField
									label="Betrag"
									value={amountStr}
									onChange={(value) => {
										setAmountStr(value);
										onClearFieldError('amount');
										onClearFieldError('splits');
									}}
									inputMode="decimal"
									placeholder="0,00"
									suffix={currency === 'EUR' ? '€' : currency}
									disabled={formSaving}
									error={fieldErrors.amount}
									enterKeyHint="next"
								/>
								<Field data-disabled={formSaving}>
									<FieldLabel htmlFor="paid-by">Bezahlt von</FieldLabel>
									<NativeSelect
										id="paid-by"
										value={paidByMemberId}
										onChange={(event) => setPaidByMemberId(event.target.value)}
										disabled={formSaving || isEditingExpense}
										className="w-full [&_select]:h-11 [&_select]:text-base"
									>
										{payerOptions.map((member) => (
											<NativeSelectOption key={member.id} value={member.id}>
												{member.name}
												{member.id === identityMemberId ? ' (du)' : ''}
											</NativeSelectOption>
										))}
									</NativeSelect>
									{isEditingExpense && (
										<FieldDescription>
											Die zahlende Person kann bei einer bestehenden Ausgabe nicht geändert werden.
										</FieldDescription>
									)}
								</Field>
								<FieldSet disabled={formSaving} data-invalid={Boolean(fieldErrors.splits)}>
									<FieldLegend>Beteiligte & Aufteilung</FieldLegend>
									<ToggleGroup
										variant="segmented"
										value={[splitMode]}
										onValueChange={(values) => {
											onClearFieldError('splits');
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
											aria-describedby={
												hasLockedHistoricalShare ? historicalShareHintId : undefined
											}
										>
											Gleichmäßig
										</ToggleGroupItem>
										<ToggleGroupItem
											value="manual"
											className="flex-1"
											aria-label="Aufteilung: Manuell"
										>
											Manuell
										</ToggleGroupItem>
									</ToggleGroup>
									{hasLockedHistoricalShare && (
										<FieldDescription id={historicalShareHintId}>
											Ausgezogene Anteile bleiben unverändert; nur aktive Personen übernehmen den
											Rest.
										</FieldDescription>
									)}
									{fieldErrors.splits && (
										<FieldError id={splitErrorId}>{fieldErrors.splits}</FieldError>
									)}
									{splitMode === 'manual' && (
										<FieldGroup className={fieldErrors.splits ? 'block space-y-3' : 'gap-3'}>
											{splitCandidates.map((member, index) => (
												<Field
													key={member.id}
													orientation="responsive"
													data-disabled={formSaving || (isEditingExpense && !member.active)}
													data-invalid={
														Boolean(fieldErrors.splits) && member.id === firstSplitMemberId
													}
												>
													<FieldLabel
														htmlFor={`share-${member.id}`}
														className="min-w-0 flex-1 break-words"
													>
														{member.name}
														{isEditingExpense && !member.active && (
															<span className="ml-1 text-xs font-normal text-muted-foreground">
																(ausgezogen)
															</span>
														)}
													</FieldLabel>
													<InputGroup className="w-full min-w-32 shrink-0 @md/field-group:max-w-32">
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
																onClearFieldError('splits');
															}}
															placeholder="0,00"
															disabled={formSaving || (isEditingExpense && !member.active)}
															enterKeyHint={index === splitCandidates.length - 1 ? 'done' : 'next'}
															aria-label={`Anteil ${member.name} in ${currency === 'EUR' ? 'Euro' : currency}${isEditingExpense && !member.active ? ', ausgezogen. Anteil bleibt unverändert.' : ''}`}
															aria-invalid={
																Boolean(fieldErrors.splits) && member.id === firstSplitMemberId
																	? true
																	: undefined
															}
															aria-describedby={
																Boolean(fieldErrors.splits) && member.id === firstSplitMemberId
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
											{!fieldErrors.splits && (
												<FieldDescription>
													Für einzelne Personen{' '}
													<span className="font-mono tabular-nums">
														{formatEuroCents(0, currency)}
													</span>{' '}
													eintragen oder das Feld leer lassen.
												</FieldDescription>
											)}
										</FieldGroup>
									)}
									{splitMode !== 'manual' && (
										<SplitReview
											members={splitCandidates}
											splits={previewSplits}
											paidByMemberId={paidByMemberId}
											currency={currency}
										/>
									)}
								</FieldSet>
								<Separator />
								<Collapsible open={showReceipt} onOpenChange={setShowReceipt}>
									<CollapsibleTrigger
										render={
											<Button type="button" variant="ghost" className="w-full justify-start" />
										}
										disabled={formSaving}
									>
										<Receipt data-icon="inline-start" />
										Beleg hinzufügen
										{imageUrl && <Badge variant="secondary">Angehängt</Badge>}
										<ChevronDown data-icon="inline-end" className="ml-auto" />
									</CollapsibleTrigger>
									<CollapsiblePanel>
										<div className="pt-3">
											<ImageUploader
												shareCode={shareCode}
												purpose="expense"
												value={imageUrl}
												onChange={setImageUrl}
												disabled={formSaving}
												imageLabel="Beleg"
											/>
										</div>
									</CollapsiblePanel>
								</Collapsible>
								<Collapsible open={recurringOpen} onOpenChange={setShowRecurring}>
									<CollapsibleTrigger
										render={
											<Button type="button" variant="ghost" className="w-full justify-start" />
										}
										disabled={
											formSaving || editingRecurringExpense !== null || isEditingQueuedRecurring
										}
									>
										<Repeat2 data-icon="inline-start" />
										Fixkosten-Vorlage
										{recurringOpen && (
											<Badge variant="secondary">
												{recurringIntervalMonths === 1
													? 'Monatlich'
													: `Alle ${recurringIntervalMonths} Monate`}
											</Badge>
										)}
										<ChevronDown data-icon="inline-end" className="ml-auto" />
									</CollapsibleTrigger>
									<CollapsiblePanel>
										<FieldGroup className="pt-3">
											<Field>
												<FieldLabel htmlFor="expense-interval">Wiederholung</FieldLabel>
												<NativeSelect
													id="expense-interval"
													value={recurringIntervalMonths}
													onChange={(event) =>
														setRecurringIntervalMonths(Number(event.target.value))
													}
													disabled={formSaving}
													className="w-full [&_select]:h-11 [&_select]:text-base"
												>
													{RECURRING_INTERVAL_OPTIONS.map(({ value, label }) => (
														<NativeSelectOption key={value} value={value}>
															{label}
														</NativeSelectOption>
													))}
												</NativeSelect>
												<FieldDescription>
													Die Vorlage merkt Betrag, Zahler:in und diese Aufteilung.
												</FieldDescription>
											</Field>
											{!isEditingQueuedExpense &&
												!isEditingQueuedRecurring &&
												!editingRecurringExpense && (
													<Button
														type="button"
														variant="outline"
														onClick={onSaveRecurringTemplate}
														disabled={formSaving}
													>
														{savingRecurringTemplate && <Spinner data-icon="inline-start" />}Als
														Vorlage merken
													</Button>
												)}
										</FieldGroup>
									</CollapsiblePanel>
								</Collapsible>
								{formError && (
									<Alert variant="destructive">
										<AlertDescription>{formError}</AlertDescription>
										{conflictExpenseId && (
											<div className="flex flex-col gap-2 pt-3">
												<Button type="button" variant="outline" onClick={onReloadServerVersion}>
													Server-Version laden
												</Button>
												<Button type="button" variant="outline" onClick={onKeepDraft}>
													Meinen Entwurf behalten
												</Button>
											</div>
										)}
									</Alert>
								)}
							</FieldGroup>
						</div>
						<Separator />
						<div className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
							<div className="flex flex-col gap-2">
								<Button
									type="submit"
									className="w-full"
									disabled={formSaving || savingRecurringTemplate}
									aria-label={
										isEditingQueuedRecurring || editingTemplate
											? 'Fixkosten-Vorlage speichern'
											: 'Ausgabe speichern'
									}
								>
									{(formSaving || savingRecurringTemplate) && <Spinner data-icon="inline-start" />}
									{isEditingQueuedRecurring || editingTemplate
										? 'Vorlage speichern'
										: editingRecurringExpense
											? 'Als Ausgabe speichern'
											: 'Speichern'}
								</Button>
								<Button
									type="button"
									variant="ghost"
									className="w-full"
									onClick={requestClose}
									disabled={formSaving || savingRecurringTemplate}
								>
									Abbrechen
								</Button>
							</div>
							{editingTemplate && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="self-start"
									disabled={formSaving || savingRecurringTemplate}
									onClick={onSubmit}
								>
									Als Ausgabe speichern
								</Button>
							)}
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<AlertDialog open={replaceOpen} onOpenChange={setReplaceOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Entwurf verwerfen?</AlertDialogTitle>
						<AlertDialogDescription>
							Deine ungespeicherten Eingaben werden durch „{pendingPrefillDescription}“ ersetzt.
							Bereits gespeicherte Ausgaben bleiben erhalten.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter className="flex-col">
						<AlertDialogCancel className="min-h-11">Entwurf behalten</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							className="min-h-11"
							onClick={onReplacePrefill}
						>
							Entwurf verwerfen
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Entwurf behalten?</AlertDialogTitle>
						<AlertDialogDescription>
							Es wird keine Ausgabe gespeichert. Du kannst deinen Entwurf später weiterbearbeiten
							oder ausdrücklich verwerfen.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter className="flex-col">
						<AlertDialogCancel className="min-h-11">Weiterbearbeiten</AlertDialogCancel>
						<AlertDialogAction variant="destructive" className="min-h-11" onClick={onDiscard}>
							Entwurf verwerfen
						</AlertDialogAction>
						<AlertDialogAction className="min-h-11" onClick={onCancel}>
							Entwurf behalten
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
