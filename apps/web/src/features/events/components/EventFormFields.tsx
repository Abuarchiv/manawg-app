'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { normalizeEventDateTime } from '@/features/events/events';
import type { ReactNode } from 'react';

const TITLE_MAX = 200;
const LOCATION_MAX = 200;
const DESCRIPTION_MAX = 2_000;

interface EventFormFieldsProps {
	idPrefix: string;
	title: string;
	onTitleChange: (value: string) => void;
	startsAt: string;
	onStartsAtChange: (value: string) => void;
	endsAt: string;
	onEndsAtChange: (value: string) => void;
	allDay: boolean;
	onAllDayChange: (value: boolean) => void;
	location: string;
	onLocationChange: (value: string) => void;
	description: string;
	onDescriptionChange: (value: string) => void;
	recurrenceField: ReactNode;
	disabled?: boolean;
	/** Field the current form error belongs to, if any (from `validateEventForm`). */
	errorField?: 'title' | 'startsAt' | 'endsAt' | null;
	/** id of the element rendering the error message, for `aria-describedby`. */
	errorId?: string;
}

export function EventFormFields({
	idPrefix,
	title,
	onTitleChange,
	startsAt,
	onStartsAtChange,
	endsAt,
	onEndsAtChange,
	allDay,
	onAllDayChange,
	location,
	onLocationChange,
	description,
	onDescriptionChange,
	recurrenceField,
	disabled = false,
	errorField = null,
	errorId,
}: EventFormFieldsProps) {
	return (
		<FieldGroup>
			<Field data-disabled={disabled}>
				<FieldLabel htmlFor={`${idPrefix}-title`}>Titel</FieldLabel>
				<Input
					id={`${idPrefix}-title`}
					value={title}
					onChange={(event) => onTitleChange(event.target.value)}
					maxLength={TITLE_MAX}
					placeholder="z. B. WG-Meeting"
					required
					disabled={disabled}
					enterKeyHint="next"
					aria-invalid={errorField === 'title' ? true : undefined}
					aria-describedby={errorField === 'title' ? errorId : undefined}
					className="text-base"
				/>
			</Field>
			<Field orientation="horizontal" data-disabled={disabled} className="min-h-11">
				<Checkbox
					id={`${idPrefix}-all-day`}
					checked={allDay}
					onCheckedChange={(checked) => {
						const nextAllDay = checked === true;
						onAllDayChange(nextAllDay);
						if (nextAllDay) {
							onStartsAtChange(normalizeEventDateTime(startsAt, true));
							onEndsAtChange(normalizeEventDateTime(endsAt, true));
						}
					}}
					disabled={disabled}
					className="relative after:absolute after:-inset-3"
				/>
				<FieldLabel htmlFor={`${idPrefix}-all-day`} className="min-h-11">
					Ganztägig
				</FieldLabel>
			</Field>
			<Field data-disabled={disabled} className="min-w-0">
				<FieldLabel htmlFor={`${idPrefix}-start`}>Beginn</FieldLabel>
				<Input
					id={`${idPrefix}-start`}
					type={allDay ? 'date' : 'datetime-local'}
					value={allDay ? startsAt.slice(0, 10) : startsAt}
					onChange={(event) =>
						onStartsAtChange(
							allDay && event.target.value ? `${event.target.value}T00:00` : event.target.value,
						)
					}
					required
					disabled={disabled}
					aria-invalid={errorField === 'startsAt' ? true : undefined}
					aria-describedby={errorField === 'startsAt' ? errorId : undefined}
					className="min-w-0 text-base"
				/>
			</Field>
			<Field data-disabled={disabled} className="min-w-0">
				<FieldLabel htmlFor={`${idPrefix}-end`}>Ende (optional)</FieldLabel>
				<Input
					id={`${idPrefix}-end`}
					type={allDay ? 'date' : 'datetime-local'}
					value={allDay ? endsAt.slice(0, 10) : endsAt}
					onChange={(event) =>
						onEndsAtChange(
							allDay && event.target.value ? `${event.target.value}T00:00` : event.target.value,
						)
					}
					disabled={disabled}
					aria-invalid={errorField === 'endsAt' ? true : undefined}
					aria-describedby={errorField === 'endsAt' ? errorId : undefined}
					className="min-w-0 text-base"
				/>
			</Field>
			<Field data-disabled={disabled}>
				<FieldLabel htmlFor={`${idPrefix}-location`}>Ort (optional)</FieldLabel>
				<Input
					id={`${idPrefix}-location`}
					value={location}
					onChange={(event) => onLocationChange(event.target.value)}
					maxLength={LOCATION_MAX}
					placeholder="z. B. Küche"
					disabled={disabled}
					enterKeyHint="next"
					className="text-base"
				/>
			</Field>
			{recurrenceField}
			<Field data-disabled={disabled}>
				<FieldLabel htmlFor={`${idPrefix}-description`}>Notiz (optional)</FieldLabel>
				<Textarea
					id={`${idPrefix}-description`}
					value={description}
					onChange={(event) => onDescriptionChange(event.target.value)}
					maxLength={DESCRIPTION_MAX}
					rows={3}
					disabled={disabled}
					className="text-base"
				/>
			</Field>
		</FieldGroup>
	);
}
