'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
	Drawer,
	DrawerContent,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
} from '@/components/ui/drawer';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { berlinDayKey } from '@/core/utils/berlin-day';
import type { ChoreMember, RecurrenceType } from '@/features/chores/components/chore-types';
import {
	INTERVAL_PRESETS_DAYS,
	INTERVAL_PRESETS_MONTHS,
	TITLE_MAX,
} from '@/features/chores/components/constants';
import type React from 'react';

interface ChoreFormProps {
	open: boolean;
	onClose: () => void;
	error: string | null;
	title: string;
	onTitleChange: (value: string) => void;
	titleInputRef: React.RefObject<HTMLInputElement | null>;
	interval: number;
	recurrenceType: RecurrenceType;
	onRecurrenceUnitToggle: (unit: RecurrenceType) => void;
	onIntervalPresetSelect: (interval: number, unit: RecurrenceType) => void;
	firstDueDate: string;
	onFirstDueDateChange: (value: string) => void;
	assignedMemberId: string;
	onAssignedMemberIdChange: (value: string) => void;
	members: ChoreMember[];
	pending: boolean;
	onSubmit: () => void;
	children?: React.ReactNode;
}

export function ChoreForm({
	open,
	onClose,
	error,
	title,
	onTitleChange,
	titleInputRef,
	interval,
	recurrenceType,
	onRecurrenceUnitToggle,
	onIntervalPresetSelect,
	firstDueDate,
	onFirstDueDateChange,
	assignedMemberId,
	onAssignedMemberIdChange,
	members,
	pending,
	onSubmit,
	children,
}: ChoreFormProps): React.ReactElement {
	const presets = recurrenceType === 'months' ? INTERVAL_PRESETS_MONTHS : INTERVAL_PRESETS_DAYS;
	const firstDue =
		recurrenceType === 'months'
			? `in ${interval} ${interval === 1 ? 'Monat' : 'Monaten'}`
			: `in ${interval} ${interval === 1 ? 'Tag' : 'Tagen'}`;
	return (
		<Drawer
			open={open}
			onOpenChange={(next) => {
				if (!next && !pending) onClose();
			}}
		>
			<DrawerContent className="mx-auto w-full max-w-md">
				<DrawerHeader>
					<DrawerTitle>Neue Putzaufgabe</DrawerTitle>
				</DrawerHeader>
				<form
					id="add-chore-form"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit();
					}}
					className="flex min-h-0 flex-col"
				>
					<div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
						{children}
						<FieldGroup>
							<Field data-disabled={pending}>
								<FieldLabel htmlFor="chore-title">Aufgabe</FieldLabel>
								<Input
									id="chore-title"
									ref={titleInputRef}
									value={title}
									onChange={(event) => onTitleChange(event.target.value)}
									maxLength={TITLE_MAX}
									placeholder="z. B. Müll rausbringen"
									disabled={pending}
									enterKeyHint="done"
									className="text-base"
								/>
							</Field>
							<Field data-disabled={pending}>
								<FieldLabel id="chore-rhythm-label">Rhythmus</FieldLabel>
								<ToggleGroup
									variant="segmented"
									value={[recurrenceType]}
									onValueChange={(values) => {
										const unit = values[0];
										if (unit === 'days' || unit === 'months') onRecurrenceUnitToggle(unit);
									}}
									aria-labelledby="chore-rhythm-label"
									className="w-full"
								>
									<ToggleGroupItem value="days" disabled={pending} className="flex-1">
										Tage
									</ToggleGroupItem>
									<ToggleGroupItem value="months" disabled={pending} className="flex-1">
										Monate
									</ToggleGroupItem>
								</ToggleGroup>
								<ToggleGroup
									value={[String(interval)]}
									onValueChange={(values) => {
										const preset = presets.find((entry) => String(entry.interval) === values[0]);
										if (preset) onIntervalPresetSelect(preset.interval, preset.unit);
									}}
									variant="outline"
									aria-label="Intervall wählen"
									className="w-full flex-wrap"
								>
									{presets.map((preset) => (
										<ToggleGroupItem
											key={preset.interval}
											value={String(preset.interval)}
											disabled={pending}
										>
											{preset.label}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							</Field>
							<Field data-disabled={pending}>
								<FieldLabel htmlFor="chore-first-due">Erste Fälligkeit (optional)</FieldLabel>
								<Input
									id="chore-first-due"
									type="date"
									value={firstDueDate}
									onChange={(event) => onFirstDueDateChange(event.target.value)}
									min={berlinDayKey(new Date())}
									disabled={pending}
									className="min-w-0 text-base"
								/>
								<FieldDescription>
									{firstDueDate
										? 'Die Aufgabe ist an diesem Tag fällig.'
										: `Ohne Datum wird sie ${firstDue} fällig. Für heute wähle das heutige Datum.`}
								</FieldDescription>
							</Field>
							<Field data-disabled={pending}>
								<FieldLabel htmlFor="chore-assigned">Zuständig</FieldLabel>
								<NativeSelect
									id="chore-assigned"
									value={assignedMemberId}
									onChange={(event) => onAssignedMemberIdChange(event.target.value)}
									disabled={pending}
									className="w-full [&_select]:min-h-11 [&_select]:text-base"
								>
									<NativeSelectOption value="">Niemand</NativeSelectOption>
									{members.map((member) => (
										<NativeSelectOption key={member.id} value={member.id}>
											{member.name}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</Field>
						</FieldGroup>
					</div>
					{/* Outside the scroll area so the error is always in view after submitting. */}
					{error && (
						<div className="max-h-[35dvh] shrink-0 overflow-y-auto px-4 pb-3">
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						</div>
					)}
					<DrawerFooter className="flex-row flex-wrap border-t pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
						<Button
							type="submit"
							disabled={!title.trim() || pending}
							aria-label="Aufgabe speichern"
							className="flex-1"
						>
							{pending && <Spinner data-icon="inline-start" aria-hidden />}
							{pending ? 'Speichert…' : 'Speichern'}
						</Button>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
							disabled={pending}
							className="flex-1"
						>
							Abbrechen
						</Button>
					</DrawerFooter>
				</form>
			</DrawerContent>
		</Drawer>
	);
}
