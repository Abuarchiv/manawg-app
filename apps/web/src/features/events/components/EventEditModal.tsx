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
import { EventFormFields } from '@/features/events/components/EventFormFields';
import {
	RECURRENCE_OPTIONS,
	type RecurrenceFreq,
	eventDateForDisplay,
	formatRecurrenceRule,
	parseRecurrenceRule,
	validateEventForm,
} from '@/features/events/events';
import { CalendarPlus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

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
}

export interface UpdateEventPayload {
	title: string;
	description: string | null;
	startsAt: string;
	endsAt: string | null;
	allDay: boolean;
	location: string | null;
	recurrence: string | null;
}

interface EventEditModalProps {
	event: EditableEvent | null;
	onClose: () => void;
	onUpdate: (id: string, payload: UpdateEventPayload) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
	actionError?: string | null;
	/** Exportiert den gewählten Termin als .ics für die eigene Kalender-App. */
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
		if (!event || saving || deleting) return;
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
		if (saving || deleting) return;
		setError(null);
		setErrorField(null);
		if (!event) return;
		const validation = validateEventForm({ title, startsAt, endsAt, allDay, original: event });
		if (!validation.ok) {
			setError(validation.error);
			setErrorField(validation.field);
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
			setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
			setErrorField(null);
		} finally {
			setSaving(false);
		}
	}

	async function handleDelete(): Promise<void> {
		if (!event) return;
		setDeleting(true);
		try {
			await onDelete(event.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.');
		} finally {
			setDeleting(false);
			setConfirmingDelete(false);
		}
	}

	return (
		<Drawer
			open={event !== null}
			onOpenChange={(open) => {
				if (!open && !confirmingDelete && !confirmingDiscard) requestClose();
			}}
		>
			<DrawerContent className="mx-auto w-full max-w-md">
				<DrawerHeader>
					<DrawerTitle>Termin bearbeiten</DrawerTitle>
					<DrawerDescription>
						{event.recurrence
							? 'Änderungen gelten für die gesamte Terminserie.'
							: 'Änderungen gelten für diesen WG-Termin.'}
					</DrawerDescription>
				</DrawerHeader>
				<form onSubmit={handleSave} className="flex min-h-0 flex-col">
					<div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
						<EventFormFields
							idPrefix="event-edit"
							title={title}
							onTitleChange={setTitle}
							startsAt={startsAt}
							onStartsAtChange={setStartsAt}
							endsAt={endsAt}
							onEndsAtChange={setEndsAt}
							allDay={allDay}
							onAllDayChange={setAllDay}
							location={location}
							onLocationChange={setLocation}
							description={description}
							onDescriptionChange={setDescription}
							disabled={saving || deleting}
							errorField={errorField}
							errorId="event-edit-error"
							recurrenceField={
								<Field data-disabled={saving || deleting}>
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
										disabled={saving || deleting}
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
						<Button type="submit" disabled={saving || deleting}>
							{saving && <Spinner data-icon="inline-start" aria-hidden />}
							{saving ? 'Speichert…' : 'Speichern'}
						</Button>
						<Button
							type="button"
							variant="outline"
							onClick={requestClose}
							disabled={saving || deleting}
						>
							Abbrechen
						</Button>
						{onExportIcs && (
							<Button type="button" variant="outline" onClick={onExportIcs}>
								<CalendarPlus data-icon="inline-start" aria-hidden />
								In Kalender-App übernehmen
							</Button>
						)}
						<Button
							type="button"
							variant="destructive"
							onClick={() => setConfirmingDelete(true)}
							disabled={saving || deleting}
							aria-label="Termin löschen"
						>
							<Trash2 data-icon="inline-start" aria-hidden />
							Termin löschen
						</Button>
					</DrawerFooter>
				</form>
				<AlertDialog
					open={confirmingDelete}
					onOpenChange={(open) => {
						if (!deleting) setConfirmingDelete(open);
					}}
				>
					<AlertDialogContent className="w-[calc(100%-2rem)]">
						<AlertDialogHeader>
							<AlertDialogTitle>Termin löschen?</AlertDialogTitle>
							<AlertDialogDescription>
								{event.recurrence
									? `„${event.title}“ wird unwiderruflich entfernt – die gesamte Serie inklusive aller zukünftigen Termine.`
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
				<AlertDialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
					<AlertDialogContent className="w-[calc(100%-2rem)]">
						<AlertDialogHeader>
							<AlertDialogTitle>Änderungen verwerfen?</AlertDialogTitle>
							<AlertDialogDescription>
								Deine Eingaben sind noch nicht gespeichert.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel className="min-h-11">Weiter bearbeiten</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								className="min-h-11"
								onClick={() => {
									setConfirmingDiscard(false);
									onClose();
								}}
							>
								Verwerfen
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</DrawerContent>
		</Drawer>
	);
}
