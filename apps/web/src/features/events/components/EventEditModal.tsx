'use client';

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
import { Button } from '@/components/ui/button';
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
} from '@/components/ui/drawer';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { DiscardChangesDialog } from '@/features/events/components/DiscardChangesDialog';
import { EventFormFields, focusEventField } from '@/features/events/components/EventFormFields';
import {
	RECURRENCE_OPTIONS,
	type RecurrenceFreq,
	eventDateForDisplay,
	formatRecurrenceRule,
	parseRecurrenceRule,
	validateEventForm,
} from '@/features/events/events';
import { CalendarPlus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const KEEP_EXISTING_RECURRENCE = '__keep__';

export interface EditableEvent {
	id: string;
	title: string;
	description: string | null;
	startsAt: string;
	endsAt: string | null;
	allDay: boolean;
	location: string | null;
	recurrence: string | null;
	createdByMemberId?: string | null;
}

export type UpdateEventPayload = Omit<EditableEvent, 'id' | 'createdByMemberId'>;

interface EventEditModalProps {
	event: EditableEvent | null;
	onClose: () => void;
	onUpdate: (id: string, payload: UpdateEventPayload) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
	actionError?: string | null;
	/** The API only lets the creator and WG admins change an event; others get a read-only view. */
	readOnly?: boolean;
	/** Exports the chosen event as .ics for the user's own calendar app. */
	onExportIcs?: (() => void) | undefined;
}

function toLocalInputValue(iso: string, allDay: boolean): string {
	const d = eventDateForDisplay(iso, allDay);
	const pad = (n: number) => n.toString().padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function EventEditModal({
	event,
	onClose,
	onUpdate,
	onDelete,
	actionError,
	readOnly = false,
	onExportIcs,
}: EventEditModalProps) {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [startsAt, setStartsAt] = useState('');
	const [endsAt, setEndsAt] = useState('');
	const [allDay, setAllDay] = useState(false);
	const [location, setLocation] = useState('');
	const [recurrence, setRecurrence] = useState('');
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [errorField, setErrorField] = useState<'title' | 'startsAt' | 'endsAt' | null>(null);
	// Set synchronously: state would come too late for the confirm dialog's close-on-click.
	const deletingRef = useRef(false);
	function clearErrorFor(...fields: Array<'title' | 'startsAt' | 'endsAt'>): void {
		if (errorField && fields.includes(errorField)) {
			setErrorField(null);
			setError(null);
		}
	}
	// The message sits below the fields, the save button is pinned. On field errors
	// the focused field stays in view, the message is announced.
	const shownError = error || actionError;
	useEffect(() => {
		if (shownError && !errorField)
			document.getElementById('event-edit-error')?.scrollIntoView({ block: 'nearest' });
	}, [shownError, errorField]);

	useEffect(() => {
		if (!event) return;
		setTitle(event.title);
		setDescription(event.description ?? '');
		setStartsAt(toLocalInputValue(event.startsAt, event.allDay));
		setEndsAt(event.endsAt ? toLocalInputValue(event.endsAt, event.allDay) : '');
		setAllDay(event.allDay);
		setLocation(event.location ?? '');
		setRecurrence(event.recurrence ?? '');
		setError(null);
		setErrorField(null);
		setConfirmingDelete(false);
		setConfirmingDiscard(false);
	}, [event]);

	const busy = saving || deleting;
	const locked = busy || readOnly;
	if (!event) return null;
	const parsedRecurrence = parseRecurrenceRule(recurrence);
	const isSimpleRecurrence =
		parsedRecurrence !== null &&
		parsedRecurrence.interval === 1 &&
		parsedRecurrence.byDay === undefined &&
		parsedRecurrence.count === undefined &&
		parsedRecurrence.until === undefined;
	const recurrenceOption = recurrence
		? isSimpleRecurrence
			? parsedRecurrence.freq
			: KEEP_EXISTING_RECURRENCE
		: '';

	function requestClose(): void {
		if (!event || busy) return;
		const dirty =
			title !== event.title ||
			description !== (event.description ?? '') ||
			startsAt !== toLocalInputValue(event.startsAt, event.allDay) ||
			endsAt !== (event.endsAt ? toLocalInputValue(event.endsAt, event.allDay) : '') ||
			allDay !== event.allDay ||
			location !== (event.location ?? '') ||
			recurrence !== (event.recurrence ?? '');
		if (dirty) setConfirmingDiscard(true);
		else onClose();
	}

	async function handleSave(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		if (locked) return;
		setError(null);
		setErrorField(null);
		if (!event) return;
		const validation = validateEventForm({ title, startsAt, endsAt, allDay, original: event });
		if (!validation.ok) {
			setError(validation.error);
			setErrorField(validation.field);
			focusEventField('event-edit', validation.field);
			return;
		}
		const trimmedTitle = title.trim();
		const startDate = validation.startsAt;
		const endDate = validation.endsAt;
		setSaving(true);
		try {
			await onUpdate(event.id, {
				title: trimmedTitle,
				description: description.trim() || null,
				startsAt: startDate.toISOString(),
				endsAt: endDate ? endDate.toISOString() : null,
				allDay,
				location: location.trim() || null,
				recurrence: recurrence.trim() || null,
			});
		} catch (err) {
			setError(
				err instanceof Error ? err.message : 'Speichern fehlgeschlagen. Versuche es erneut.',
			);
			setErrorField(null);
		} finally {
			setSaving(false);
		}
	}

	async function handleDelete(): Promise<void> {
		if (!event) return;
		setError(null);
		setErrorField(null);
		deletingRef.current = true;
		setDeleting(true);
		try {
			await onDelete(event.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen. Versuche es erneut.');
		} finally {
			deletingRef.current = false;
			setDeleting(false);
			setConfirmingDelete(false);
		}
	}

	return (
		<>
			<Drawer
				open={event !== null}
				onOpenChange={(open, details) => {
					// The confirm dialogs are siblings of the drawer: their clicks and Esc count here
					// as "outside" and must not close the drawer.
					const target = details?.event?.target;
					if (target instanceof Element && target.closest('[data-slot^="alert-dialog"]')) return;
					if (!open && !confirmingDelete && !confirmingDiscard) requestClose();
				}}
			>
				<DrawerContent className="mx-auto w-full max-w-md">
					<DrawerHeader className="border-b pb-3">
						<DrawerTitle>{readOnly ? 'Termin' : 'Termin bearbeiten'}</DrawerTitle>
						{readOnly ? (
							<DrawerDescription>
								Nur wer den Termin angelegt hat und WG-Admins können ihn ändern.
							</DrawerDescription>
						) : (
							event.recurrence && (
								<DrawerDescription>
									Änderungen gelten für die gesamte Terminserie.
								</DrawerDescription>
							)
						)}
					</DrawerHeader>
					<form noValidate onSubmit={handleSave} className="flex min-h-0 flex-col">
						<div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
							<EventFormFields
								idPrefix="event-edit"
								title={title}
								onTitleChange={(value) => {
									setTitle(value);
									clearErrorFor('title');
								}}
								startsAt={startsAt}
								onStartsAtChange={(value) => {
									setStartsAt(value);
									clearErrorFor('startsAt', 'endsAt');
								}}
								endsAt={endsAt}
								onEndsAtChange={(value) => {
									setEndsAt(value);
									clearErrorFor('startsAt', 'endsAt');
								}}
								allDay={allDay}
								onAllDayChange={(value) => {
									setAllDay(value);
									clearErrorFor('startsAt', 'endsAt');
								}}
								location={location}
								onLocationChange={setLocation}
								description={description}
								onDescriptionChange={setDescription}
								disabled={locked}
								errorField={errorField}
								errorId="event-edit-error"
								recurrenceField={
									<Field data-disabled={locked}>
										<FieldLabel htmlFor="event-edit-recurrence">Wiederholung</FieldLabel>
										<NativeSelect
											id="event-edit-recurrence"
											value={recurrenceOption}
											onChange={(event) =>
												event.target.value === KEEP_EXISTING_RECURRENCE
													? undefined
													: setRecurrence(
															event.target.value
																? formatRecurrenceRule({
																		freq: event.target.value as RecurrenceFreq,
																		interval: 1,
																	})
																: '',
														)
											}
											disabled={locked}
											className="w-full [&_select]:min-h-11 [&_select]:text-base"
										>
											{recurrence && !isSimpleRecurrence && (
												<NativeSelectOption value={KEEP_EXISTING_RECURRENCE}>
													Bestehende Serie
												</NativeSelectOption>
											)}
											{RECURRENCE_OPTIONS.map((option) => (
												<NativeSelectOption key={option.value} value={option.value}>
													{option.label}
												</NativeSelectOption>
											))}
										</NativeSelect>
									</Field>
								}
							/>
							{(error || actionError) && (
								<Alert variant="destructive">
									<AlertDescription id="event-edit-error">{error || actionError}</AlertDescription>
								</Alert>
							)}
						</div>
						<DrawerFooter className="border-t pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
							<div className="flex flex-wrap gap-2">
								{!readOnly && (
									<Button type="submit" className="min-w-fit flex-1" disabled={busy}>
										{saving && <Spinner data-icon="inline-start" aria-hidden />}
										{saving ? 'Speichert…' : 'Speichern'}
									</Button>
								)}
								<Button
									type="button"
									variant="outline"
									className="min-w-fit flex-1"
									onClick={requestClose}
									disabled={busy}
								>
									{readOnly ? 'Schließen' : 'Abbrechen'}
								</Button>
							</div>
							<div className="flex flex-wrap gap-2">
								{onExportIcs && (
									<Button
										type="button"
										variant="outline"
										className="h-auto min-h-8 min-w-fit flex-1 py-1.5"
										onClick={onExportIcs}
										aria-label="In Kalender-App übernehmen"
									>
										<CalendarPlus data-icon="inline-start" aria-hidden />
										In Kalender
									</Button>
								)}
								{!readOnly && (
									<Button
										type="button"
										variant="destructive"
										className="h-auto min-h-8 min-w-fit flex-1 py-1.5"
										onClick={() => setConfirmingDelete(true)}
										disabled={busy}
										aria-label="Termin löschen"
									>
										<Trash2 data-icon="inline-start" aria-hidden />
										Termin löschen
									</Button>
								)}
							</div>
						</DrawerFooter>
					</form>
				</DrawerContent>
			</Drawer>
			<AlertDialog
				open={confirmingDelete}
				onOpenChange={(open) => {
					if (!deletingRef.current) setConfirmingDelete(open);
				}}
			>
				<AlertDialogContent className="w-[calc(100%-2rem)]">
					<AlertDialogHeader>
						<AlertDialogTitle>Termin löschen?</AlertDialogTitle>
						<AlertDialogDescription>
							{event.recurrence
								? `„${event.title}“ wird unwiderruflich entfernt, mit allen zukünftigen Terminen der Serie.`
								: `„${event.title}“ wird unwiderruflich entfernt.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deleting} className="min-h-11">
							Abbrechen
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => void handleDelete()}
							disabled={deleting}
							className="min-h-11"
						>
							{deleting && <Spinner data-icon="inline-start" aria-hidden />}
							{deleting ? 'Löscht…' : 'Löschen'}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<DiscardChangesDialog
				open={confirmingDiscard}
				onOpenChange={setConfirmingDiscard}
				onDiscard={() => {
					setConfirmingDiscard(false);
					onClose();
				}}
			/>
		</>
	);
}
