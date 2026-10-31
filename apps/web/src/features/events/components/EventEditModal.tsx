'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerHeader,
	DrawerTitle,
} from '@/components/ui/drawer';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { EventEditDialogs } from '@/features/events/components/EventEditDialogs';
import { EventEditFooter } from '@/features/events/components/EventEditFooter';
import { EventFormFields, focusEventField } from '@/features/events/components/EventFormFields';
import { type EventScope, EventScopeSwitch } from '@/features/events/components/EventScopeSwitch';
import { RecurrenceOptions } from '@/features/events/components/RecurrenceOptions';
import {
	type EventOccurrence,
	eventDateForDisplay,
	parseRecurrenceRule,
	toDatetimeLocalValue,
	validateEventForm,
} from '@/features/events/events';
import { shiftedSeriesRule } from '@/features/events/recurrence-shift';
import { dateTimeFormat } from '@/shared/i18n/intl';
import type { Locale } from '@/shared/i18n/locale';
import { useMessage } from '@/shared/i18n/message';

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
	updatedAt?: string | undefined;
}

export type UpdateEventPayload = Omit<EditableEvent, 'id' | 'createdByMemberId' | 'updatedAt'> & {
	expectedUpdatedAt?: string | undefined;
};

interface EventEditModalProps {
	event: EditableEvent | null;
	onClose: () => void;
	onUpdate: (id: string, payload: UpdateEventPayload) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
	/** The opened date of a series; with the two handlers below a change can apply to just it. */
	occurrence?: EventOccurrence | null | undefined;
	onUpdateOccurrence?:
		| ((id: string, occurrenceStartsAt: string, payload: UpdateEventPayload) => Promise<void>)
		| undefined;
	onDeleteOccurrence?: ((id: string, occurrenceStartsAt: string) => Promise<void>) | undefined;
	actionError?: string | null;
	/** Exports the chosen event as .ics for the user's own calendar app. */
	onExportIcs?: (() => void) | undefined;
	/** The API only lets the creator and WG admins change an event; others get a read-only view. */
	readOnly?: boolean;
}

function toLocalInputValue(iso: string, allDay: boolean): string {
	return toDatetimeLocalValue(eventDateForDisplay(iso, allDay));
}

export function EventEditModal({
	event,
	onClose,
	onUpdate,
	onDelete,
	occurrence,
	onUpdateOccurrence,
	onDeleteOccurrence,
	actionError,
	onExportIcs,
	readOnly = false,
}: EventEditModalProps) {
	const t = useTranslations('events');
	const render = useMessage();
	const locale = useLocale() as Locale;
	const [scope, setScope] = useState<EventScope>('series');
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
	const shownError = error || actionError;

	const showValues = useCallback((source: EditableEvent | EventOccurrence, rule: string | null) => {
		setTitle(source.title);
		setDescription(source.description ?? '');
		setStartsAt(toLocalInputValue(source.startsAt, source.allDay));
		setEndsAt(source.endsAt ? toLocalInputValue(source.endsAt, source.allDay) : '');
		setAllDay(source.allDay);
		setLocation(source.location ?? '');
		setRecurrence(rule ?? '');
	}, []);

	useEffect(() => {
		if (!event) return;
		setScope('series');
		showValues(event, event.recurrence);
		setError(null);
		setErrorField(null);
		setConfirmingDelete(false);
		setConfirmingDiscard(false);
	}, [event, showValues]);

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

	const onlyThis =
		scope === 'occurrence' &&
		Boolean(occurrence && event.recurrence && onUpdateOccurrence && onDeleteOccurrence);
	const canSwitchScope = Boolean(
		!readOnly && occurrence && event.recurrence && onUpdateOccurrence && onDeleteOccurrence,
	);
	// What the form started from: the series, or the opened date when only that one is edited.
	const baseline: EditableEvent | EventOccurrence = onlyThis && occurrence ? occurrence : event;
	const baselineRule = onlyThis ? '' : (event.recurrence ?? '');

	function chooseScope(next: EventScope): void {
		setScope(next);
		setError(null);
		setErrorField(null);
		if (next === 'occurrence' && occurrence) showValues(occurrence, null);
		else if (event) showValues(event, event.recurrence);
	}

	function requestClose(): void {
		if (!event || busy) return;
		const dirty =
			title !== baseline.title ||
			description !== (baseline.description ?? '') ||
			startsAt !== toLocalInputValue(baseline.startsAt, baseline.allDay) ||
			endsAt !== (baseline.endsAt ? toLocalInputValue(baseline.endsAt, baseline.allDay) : '') ||
			allDay !== baseline.allDay ||
			location !== (baseline.location ?? '') ||
			recurrence !== baselineRule;
		if (dirty) setConfirmingDiscard(true);
		else onClose();
	}

	async function handleSave(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		if (locked) return;
		setError(null);
		setErrorField(null);
		if (!event) return;
		const validation = validateEventForm({ title, startsAt, endsAt, allDay });
		if (!validation.ok) {
			setError(render(validation.error));
			setErrorField(validation.field);
			focusEventField('event-edit', validation.field);
			return;
		}
		const trimmedTitle = title.trim();
		const startDate = validation.startsAt;
		const endDate = validation.endsAt;
		setSaving(true);
		try {
			const payload: UpdateEventPayload = {
				title: trimmedTitle,
				description: description.trim() || null,
				startsAt: startDate.toISOString(),
				endsAt: endDate ? endDate.toISOString() : null,
				allDay,
				location: location.trim() || null,
				recurrence: onlyThis
					? null
					: shiftedSeriesRule(recurrence.trim(), event.startsAt, startDate, allDay, event.allDay),
				...(event.updatedAt ? { expectedUpdatedAt: event.updatedAt } : {}),
			};
			if (onlyThis && occurrence && onUpdateOccurrence) {
				await onUpdateOccurrence(event.id, occurrence.startsAt, payload);
			} else {
				await onUpdate(event.id, payload);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t('edit.saveFailed'));
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
			if (onlyThis && occurrence && onDeleteOccurrence) {
				await onDeleteOccurrence(event.id, occurrence.startsAt);
			} else {
				await onDelete(event.id);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t('edit.deleteFailed'));
		} finally {
			deletingRef.current = false;
			setDeleting(false);
			setConfirmingDelete(false);
		}
	}

	return (
		<>
			<Drawer
				open
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
						<DrawerTitle>{readOnly ? t('edit.titleEvent') : t('edit.titleEdit')}</DrawerTitle>
						{readOnly && <DrawerDescription>{t('edit.readOnly')}</DrawerDescription>}
						{!readOnly && event.recurrence && !canSwitchScope && (
							<DrawerDescription>{t('edit.wholeSeries')}</DrawerDescription>
						)}
					</DrawerHeader>
					<form noValidate onSubmit={handleSave} className="flex min-h-0 flex-col">
						<div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
							{canSwitchScope && occurrence && (
								<EventScopeSwitch
									scope={scope}
									dateLabel={dateTimeFormat(locale, {
										weekday: 'short',
										...(locale === 'de'
											? { day: '2-digit', month: '2-digit' }
											: { day: 'numeric', month: 'short' }),
										...(occurrence.allDay ? { timeZone: 'UTC' } : {}),
									}).format(new Date(occurrence.startsAt))}
									disabled={busy}
									onChange={chooseScope}
								/>
							)}
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
									onlyThis ? null : (
										<Field data-disabled={locked}>
											<FieldLabel htmlFor="event-edit-recurrence">
												{t('recurrence.label')}
											</FieldLabel>
											<NativeSelect
												id="event-edit-recurrence"
												value={recurrenceOption}
												onChange={(changed) => {
													const value = changed.target.value;
													if (value !== KEEP_EXISTING_RECURRENCE)
														setRecurrence(value && `FREQ=${value}`);
												}}
												disabled={locked}
												className="w-full [&_select]:min-h-11 [&_select]:text-base"
											>
												{recurrence && !isSimpleRecurrence && (
													<NativeSelectOption value={KEEP_EXISTING_RECURRENCE}>
														{t('recurrence.existing')}
													</NativeSelectOption>
												)}
												<RecurrenceOptions />
											</NativeSelect>
										</Field>
									)
								}
							/>
						</div>
						{shownError && (
							<div className="max-h-[35dvh] shrink-0 overflow-y-auto px-4 pb-3">
								<Alert variant="destructive">
									<AlertDescription id="event-edit-error">{shownError}</AlertDescription>
								</Alert>
							</div>
						)}
						<EventEditFooter
							readOnly={readOnly}
							busy={busy}
							saving={saving}
							onCancel={requestClose}
							onDelete={() => setConfirmingDelete(true)}
							deleteLabel={onlyThis ? t('edit.deleteOccurrence') : t('edit.deleteEvent')}
							onExportIcs={onExportIcs}
						/>
					</form>
				</DrawerContent>
			</Drawer>
			<EventEditDialogs
				title={event.title}
				recurring={Boolean(event.recurrence)}
				onlyThis={onlyThis}
				confirmingDelete={confirmingDelete}
				onConfirmingDeleteChange={(open) => {
					if (!deletingRef.current) setConfirmingDelete(open);
				}}
				deleting={deleting}
				onDelete={() => void handleDelete()}
				confirmingDiscard={confirmingDiscard}
				onConfirmingDiscardChange={setConfirmingDiscard}
				onDiscard={() => {
					setConfirmingDiscard(false);
					onClose();
				}}
			/>
		</>
	);
}
