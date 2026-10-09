'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { type ActionNotice, ActionNoticeBanner } from '@/components/wg/ActionNoticeBanner';
import type { Member } from '@/components/wg/WgContextProvider';
import type { ReopenedShare } from '@/features/expenses/expense-split-input';
import { cn } from '@/shared/lib/cn';
import { useKeyboardOpen } from '@/shared/lib/use-keyboard-open';
import { ArrowLeft } from 'lucide-react';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { CloseDraftDialog, ReplaceDraftDialog } from './ExpenseDraftDialogs';
import { ExpenseExtras } from './ExpenseExtras';
import { ExpensePayerDateFields } from './ExpensePayerDateFields';
import { ExpenseSplitFieldset } from './ExpenseSplitFieldset';
import { TextField } from './TextField';
import { DESCRIPTION_MAX } from './constants';
import type { SplitMode } from './expense-form-draft';
import type { RecurringExpense } from './expense-types';
import { useExpenseFormDirty } from './use-expense-form-dirty';
import type { ExpenseFormExtras } from './use-expense-form-extras';

const EXPENSE_DESCRIPTION_FIELD_ID = 'expense-description';

export type ExpenseFormField = 'description' | 'amount' | 'date' | 'splits';
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
	extras: ExpenseFormExtras;
	reopenedShares: ReopenedShare[];
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
	recurringTemplateCount: number;
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
	/** Controlled from outside so the sheet can fade out before unmounting. */
	open: boolean;
	/** Fires after the exit animation; the form can unmount. */
	onExited: () => void;
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
	extras,
	reopenedShares,
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
	recurringTemplateCount,
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
	open,
	onExited,
}: ExpenseFormSectionProps): React.ReactElement {
	const keyboardOpen = useKeyboardOpen();
	const [confirmClose, setConfirmClose] = useState(false);
	const [replaceOpen, setReplaceOpen] = useState(false);
	const formRef = useRef<HTMLFormElement>(null);
	const formErrorRef = useRef<HTMLDivElement>(null);
	const editingTemplate = Boolean(
		editingRecurringExpense && !isEditingQueuedExpense && !isEditingQueuedRecurring,
	);
	const savesTemplate = isEditingQueuedRecurring || editingTemplate;
	const formModeKey = editingRecurringExpense
		? `recurring:${editingRecurringExpense.id}`
		: isEditingExpense
			? `expense:${editingExpenseId ?? 'invalid'}`
			: 'new';
	const isDirty = useExpenseFormDirty({
		description,
		amountStr,
		paidByMemberId,
		splitMode,
		manualSplits,
		imageUrl,
		...extras.draftFields,
		recurringIntervalMonths,
		identityMemberId,
		formModeKey,
		startsFromCurrentValues: isEditingExpense || editingRecurringExpense !== null,
	});

	useEffect(() => {
		if (validationAttempt === 0) return;
		formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
	}, [validationAttempt]);

	// The server error sits at the end of the scroll area, below the fold on small phones.
	useEffect(() => {
		if (formError) formErrorRef.current?.scrollIntoView({ block: 'nearest' });
	}, [formError]);

	function requestClose() {
		if (formSaving || savingRecurringTemplate) return;
		if (isDirty) setConfirmClose(true);
		else onCancel();
	}

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) requestClose();
				}}
				onOpenChangeComplete={(next) => {
					if (!next) onExited();
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
								onClick={requestClose}
								disabled={formSaving}
								aria-label="Ausgabe abbrechen"
							>
								<ArrowLeft />
							</Button>
							<DialogTitle>{title}</DialogTitle>
						</div>
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
										<AlertDescription className="text-foreground">
											Noch nicht synchronisiert. Die Änderung wird gesendet, sobald du online bist.
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
								<ExpensePayerDateFields
									paidByMemberId={paidByMemberId}
									setPaidByMemberId={setPaidByMemberId}
									payerOptions={payerOptions}
									identityMemberId={identityMemberId}
									isEditingExpense={isEditingExpense}
									occurredOn={extras.occurredOn}
									setOccurredOn={extras.setOccurredOn}
									dateError={fieldErrors.date}
									onClearDateError={() => onClearFieldError('date')}
									formSaving={formSaving}
								/>
								<ExpenseSplitFieldset
									members={members}
									splitCandidates={splitCandidates}
									splitMode={splitMode}
									setSplitMode={setSplitMode}
									manualSplits={manualSplits}
									setManualSplits={setManualSplits}
									participantIds={extras.participantIds}
									setParticipantIds={extras.setParticipantIds}
									reopenedShares={reopenedShares}
									splitsError={fieldErrors.splits}
									onClearSplitsError={() => onClearFieldError('splits')}
									amountStr={amountStr}
									currency={currency}
									paidByMemberId={paidByMemberId}
									previewSplits={previewSplits}
									isEditingExpense={isEditingExpense}
									formSaving={formSaving}
								/>
								<Separator />
								<ExpenseExtras
									shareCode={shareCode}
									imageUrl={imageUrl}
									setImageUrl={setImageUrl}
									recurringIntervalMonths={recurringIntervalMonths}
									setRecurringIntervalMonths={setRecurringIntervalMonths}
									editingRecurringExpense={editingRecurringExpense}
									isEditingQueuedExpense={isEditingQueuedExpense}
									isEditingQueuedRecurring={isEditingQueuedRecurring}
									savingRecurringTemplate={savingRecurringTemplate}
									onSaveRecurringTemplate={onSaveRecurringTemplate}
									recurringTemplateCount={recurringTemplateCount}
									formSaving={formSaving}
								/>
								{formError && (
									<Alert ref={formErrorRef} variant="destructive">
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
						<div
							className={cn(
								'flex shrink-0 flex-col gap-2 px-4',
								// With the keyboard open the safe area is irrelevant and the back arrow already cancels, so more of the form stays visible.
								keyboardOpen ? 'py-2' : 'pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
							)}
						>
							<div className="flex flex-col gap-2">
								<Button
									type="submit"
									className="w-full"
									disabled={formSaving || savingRecurringTemplate}
									aria-label={savesTemplate ? 'Fixkosten-Vorlage speichern' : 'Ausgabe speichern'}
								>
									{(formSaving || savingRecurringTemplate) && <Spinner data-icon="inline-start" />}
									{savesTemplate
										? 'Vorlage speichern'
										: editingRecurringExpense
											? 'Als Ausgabe speichern'
											: 'Speichern'}
								</Button>
								<Button
									type="button"
									variant="ghost"
									className={cn('w-full', keyboardOpen && 'hidden')}
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

			<ReplaceDraftDialog
				open={replaceOpen}
				onOpenChange={setReplaceOpen}
				prefillDescription={pendingPrefillDescription}
				onReplace={onReplacePrefill}
			/>
			<CloseDraftDialog
				open={confirmClose}
				onOpenChange={setConfirmClose}
				onDiscard={onDiscard}
				onKeep={onCancel}
			/>
		</>
	);
}
