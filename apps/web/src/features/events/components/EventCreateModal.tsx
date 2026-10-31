'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
} from '@/components/ui/drawer';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { EventFormFields, focusEventField } from '@/features/events/components/EventFormFields';
import { RecurrenceOptions } from '@/features/events/components/RecurrenceOptions';
import {
	formatRecurrenceRule,
	type RecurrenceFreq,
	toDatetimeLocalValue,
	validateEventForm,
} from '@/features/events/events';
import { type Message, useMessage } from '@/shared/i18n/message';

interface EventCreateModalProps {
	open: boolean;
	onClose: () => void;
	onSubmit: (payload: CreateEventPayload) => Promise<void>;
	defaultDate?: Date | undefined;
}

export interface CreateEventPayload {
	title: string;
	description: string | null;
	startsAt: string;
	endsAt: string | null;
	allDay: boolean;
	location: string | null;
	recurrence: string | null;
}

const QUICK_TEMPLATES: ReadonlyArray<{
	id: string;
	label: Message;
	title: Message;
	freq: RecurrenceFreq | '';
	allDay: boolean;
}> = [
	{
		id: 'birthday',
		label: { key: 'events.create.template.birthday.label' },
		title: { key: 'events.create.template.birthday.title' },
		freq: 'YEARLY',
		allDay: true,
	},
	{
		id: 'heating',
		label: { key: 'events.create.template.heating.label' },
		title: { key: 'events.create.template.heating.title' },
		freq: 'YEARLY',
		allDay: true,
	},
	{
		id: 'meter',
		label: { key: 'events.create.template.meter.label' },
		title: { key: 'events.create.template.meter.title' },
		freq: '',
		allDay: false,
	},
	// The form only knows the frequency; a BYDAY would have been silently dropped.
	{
		id: 'meeting',
		label: { key: 'events.create.template.meeting.label' },
		title: { key: 'events.create.template.meeting.title' },
		freq: 'WEEKLY',
		allDay: false,
	},
	{
		id: 'rubbish',
		label: { key: 'events.create.template.rubbish.label' },
		title: { key: 'events.create.template.rubbish.title' },
		freq: 'WEEKLY',
		allDay: false,
	},
];

export function EventCreateModal({ open, onClose, onSubmit, defaultDate }: EventCreateModalProps) {
	const t = useTranslations('events');
	const render = useMessage();
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [startsAt, setStartsAt] = useState('');
	const [endsAt, setEndsAt] = useState('');
	const [allDay, setAllDay] = useState(false);
	const [location, setLocation] = useState('');
	const [recurrenceFreq, setRecurrenceFreq] = useState<string>('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [errorField, setErrorField] = useState<'title' | 'startsAt' | 'endsAt' | null>(null);
	// Most recently tapped template; while set, another template may replace the title.
	const [activeTemplate, setActiveTemplate] = useState<string | null>(null);
	function clearErrorFor(...fields: Array<'title' | 'startsAt' | 'endsAt'>): void {
		if (errorField && fields.includes(errorField)) {
			setErrorField(null);
			setError(null);
		}
	}
	const draftInitializedRef = useRef(false);
	// Day the draft was last prefilled with.
	const lastSeedDayRef = useRef('');

	// biome-ignore lint/correctness/useExhaustiveDependencies: prefill only on open or a new day, not on every keystroke.
	useEffect(() => {
		if (!open) return;
		const day = defaultDate?.toDateString() ?? '';
		// An untouched draft follows the newly chosen day, a started one is kept.
		const pristine = !title && !description && !location && !endsAt && !allDay && !recurrenceFreq;
		if (draftInitializedRef.current && !(pristine && day !== lastSeedDayRef.current)) return;
		draftInitializedRef.current = true;
		lastSeedDayRef.current = day;
		setActiveTemplate(null);
		setError(null);
		setErrorField(null);
		// Start at the next full hour; a picked day keeps that time of day
		// (including a day picked in the past — the calendar lets you select
		// one, so silently discarding it back to "today" would be confusing).
		const nextHour = new Date();
		nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
		const seeded = new Date(defaultDate ?? nextHour);
		seeded.setHours(nextHour.getHours(), 0, 0, 0);
		// Today after 23:00 would seed 00:00 of today, which has already passed.
		const pickedToday = seeded.toDateString() === new Date().toDateString();
		setStartsAt(toDatetimeLocalValue(pickedToday && seeded < nextHour ? nextHour : seeded));
		setEndsAt('');
	}, [open, defaultDate]);

	function applyTemplate(template: (typeof QUICK_TEMPLATES)[number]): void {
		// A self-typed title is kept; only empty titles or ones from a template are replaced.
		const previous = QUICK_TEMPLATES.find((candidate) => candidate.id === activeTemplate);
		if (!title || (previous && title === render(previous.title))) setTitle(render(template.title));
		setActiveTemplate(template.id);
		clearErrorFor('title');
		setAllDay(template.allDay);
		setRecurrenceFreq(template.freq);
	}

	async function handleSubmit(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		if (submitting) return;
		setError(null);
		setErrorField(null);
		const validation = validateEventForm({ title, startsAt, endsAt, allDay });
		if (!validation.ok) {
			setError(render(validation.error));
			setErrorField(validation.field);
			focusEventField('event-create', validation.field);
			return;
		}
		const trimmedTitle = title.trim();
		const startDate = validation.startsAt;
		const endDate = validation.endsAt;
		const recurrence = recurrenceFreq
			? formatRecurrenceRule({ freq: recurrenceFreq as RecurrenceFreq, interval: 1 })
			: null;
		setSubmitting(true);
		try {
			await onSubmit({
				title: trimmedTitle,
				description: description.trim() || null,
				startsAt: startDate.toISOString(),
				endsAt: endDate ? endDate.toISOString() : null,
				allDay,
				location: location.trim() || null,
				recurrence,
			});
			draftInitializedRef.current = false;
			lastSeedDayRef.current = '';
			setActiveTemplate(null);
			setStartsAt('');
			setEndsAt('');
			setTitle('');
			setDescription('');
			setLocation('');
			setAllDay(false);
			setRecurrenceFreq('');
		} catch (err) {
			setError(err instanceof Error ? err.message : t('create.saveFailed'));
			setErrorField(null);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Drawer
			open={open}
			onOpenChange={(next) => {
				if (!next && !submitting) onClose();
			}}
		>
			<DrawerContent className="mx-auto w-full max-w-md">
				<DrawerHeader className="border-b pb-3">
					<DrawerTitle>{t('create.title')}</DrawerTitle>
					<DrawerDescription className="sr-only">{t('create.description')}</DrawerDescription>
				</DrawerHeader>
				<form noValidate onSubmit={handleSubmit} className="flex min-h-0 flex-col">
					<div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
						<FieldSet disabled={submitting}>
							<FieldLegend variant="label">{t('create.templates')}</FieldLegend>
							<div className="flex flex-wrap gap-2">
								{QUICK_TEMPLATES.map((template) => (
									<Button
										key={template.id}
										type="button"
										variant={activeTemplate === template.id ? 'secondary' : 'outline'}
										aria-pressed={activeTemplate === template.id}
										className="shrink-0"
										onClick={() => applyTemplate(template)}
										disabled={submitting}
									>
										{render(template.label)}
									</Button>
								))}
							</div>
						</FieldSet>
						<EventFormFields
							idPrefix="event-create"
							title={title}
							onTitleChange={(value) => {
								setTitle(value);
								setActiveTemplate(null);
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
							disabled={submitting}
							errorField={errorField}
							errorId="event-create-error"
							recurrenceField={
								<Field data-disabled={submitting}>
									<FieldLabel htmlFor="event-recurrence">{t('recurrence.label')}</FieldLabel>
									<NativeSelect
										id="event-recurrence"
										value={recurrenceFreq}
										onChange={(event) => setRecurrenceFreq(event.target.value)}
										disabled={submitting}
										className="w-full [&_select]:min-h-11 [&_select]:text-base"
									>
										<RecurrenceOptions />
									</NativeSelect>
								</Field>
							}
						/>
					</div>
					{error && (
						<div className="max-h-[35dvh] shrink-0 overflow-y-auto px-4 pb-3">
							<Alert variant="destructive" id="event-create-error">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						</div>
					)}
					<DrawerFooter className="border-t pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
						<Button type="submit" disabled={submitting}>
							{submitting && <Spinner data-icon="inline-start" aria-hidden />}
							{submitting ? t('actions.saving') : t('create.submit')}
						</Button>
						<Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
							{t('actions.cancel')}
						</Button>
					</DrawerFooter>
				</form>
			</DrawerContent>
		</Drawer>
	);
}
