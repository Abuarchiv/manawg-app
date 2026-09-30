'use client';

import { Collapsible, CollapsiblePanel } from '@/components/animate-ui/primitives/base/collapsible';
import { Button, buttonVariants } from '@/components/ui/button';
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@/components/ui/item';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmDelete } from '@/core/hooks/useConfirmDelete';
import { type AbsenceInput, formatAbsenceRange } from '@/features/chores/absence';
import type { ChoreMember } from '@/features/chores/components/chore-types';
import { cn } from '@/shared/lib/cn';
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface AbsencePanelProps {
	active: boolean;
	absentCount: number;
	members: ChoreMember[];
	memberId: string;
	onMemberIdChange: (value: string) => void;
	start: string;
	onStartChange: (value: string) => void;
	end: string;
	onEndChange: (value: string) => void;
	reason: string;
	onReasonChange: (value: string) => void;
	pending: boolean;
	onAdd: () => void;
	hiddenCount: number;
	totalCount: number;
	allAbsencesHref: string;
	visibleAbsences: AbsenceInput[];
	highlightedAbsenceId: string | null;
	onRemove: (id: string) => void;
	isPending: (key: string) => boolean;
}

export function AbsencePanel({
	active,
	absentCount,
	members,
	memberId,
	onMemberIdChange,
	start,
	onStartChange,
	end,
	onEndChange,
	reason,
	onReasonChange,
	pending,
	onAdd,
	hiddenCount,
	totalCount,
	allAbsencesHref,
	visibleAbsences,
	highlightedAbsenceId,
	onRemove,
	isPending,
}: AbsencePanelProps) {
	const [formOpen, setFormOpen] = useState(active || Boolean(start || end || reason));
	const { confirmId, request: requestRemove, cancel: cancelRemove } = useConfirmDelete();
	useEffect(() => {
		if (active || start || end || reason) setFormOpen(true);
	}, [active, start, end, reason]);

	return (
		<Card id="absences-panel" className={cn('scroll-mt-28', active && 'ring-2 ring-ring')}>
			<CardHeader>
				<CardTitle className="break-normal">Abwesenheiten</CardTitle>
				<CardDescription className="break-normal">
					{active
						? 'Abwesenheits-Fokus: wer nicht da ist, wird bei der Rotation übersprungen.'
						: 'Wer nicht da ist, wird bei der Rotation übersprungen.'}
				</CardDescription>
				<CardAction>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setFormOpen((open) => !open)}
						aria-label={formOpen ? 'Abwesenheitsformular schließen' : 'Abwesenheit eintragen'}
						aria-expanded={formOpen}
						aria-controls="absence-form"
					>
						{formOpen ? 'Schließen' : 'Eintragen'}
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{absentCount > 0 && (
					<p className="text-sm text-muted-foreground tabular-nums">
						{absentCount} aktuell abwesend
					</p>
				)}
				<Collapsible open={formOpen}>
					<CollapsiblePanel>
						<form
							id="absence-form"
							onSubmit={(event) => {
								event.preventDefault();
								onAdd();
							}}
							className="flex flex-col gap-3 pb-1"
						>
							<FieldGroup>
								<Field data-disabled={pending}>
									<FieldLabel htmlFor="absence-member">Abwesendes Mitglied</FieldLabel>
									<NativeSelect
										id="absence-member"
										value={memberId}
										onChange={(event) => onMemberIdChange(event.target.value)}
										disabled={pending}
										className="w-full [&_select]:min-h-11 [&_select]:text-base"
									>
										{members.map((member) => (
											<NativeSelectOption key={member.id} value={member.id}>
												{member.name}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</Field>
								<FieldGroup className="grid grid-cols-1 gap-2">
									<Field data-disabled={pending} className="min-w-0">
										<FieldLabel htmlFor="absence-start">Von</FieldLabel>
										<Input
											id="absence-start"
											type="date"
											value={start}
											onChange={(event) => onStartChange(event.target.value)}
											disabled={pending}
											aria-label="Abwesenheit von"
											className="min-w-0 text-base"
										/>
									</Field>
									<Field data-disabled={pending} className="min-w-0">
										<FieldLabel htmlFor="absence-end">Bis</FieldLabel>
										<Input
											id="absence-end"
											type="date"
											value={end}
											onChange={(event) => onEndChange(event.target.value)}
											disabled={pending}
											aria-label="Abwesenheit bis"
											className="min-w-0 text-base"
										/>
									</Field>
								</FieldGroup>
								<Field data-disabled={pending}>
									<FieldLabel htmlFor="absence-reason">Grund (optional)</FieldLabel>
									<Input
										id="absence-reason"
										value={reason}
										onChange={(event) => onReasonChange(event.target.value)}
										maxLength={120}
										placeholder="Grund optional"
										disabled={pending}
										enterKeyHint="done"
										aria-label="Abwesenheitsgrund"
										className="text-base"
									/>
								</Field>
							</FieldGroup>
							<Button
								type="submit"
								disabled={!start || !end || pending}
								aria-label="Abwesenheit speichern"
							>
								{pending && <Spinner data-icon="inline-start" aria-hidden />}
								{pending ? 'Speichert…' : 'Abwesenheit speichern'}
							</Button>
						</form>
					</CollapsiblePanel>
				</Collapsible>
				{totalCount > 0 && (
					<ItemGroup className="gap-2">
						{visibleAbsences.map((absence) => {
							const removing = isPending(`absence:${absence.id}:remove`);
							const armed = confirmId === absence.id;
							return (
								<Item
									key={absence.id}
									id={`absence-${absence.id}`}
									variant="outline"
									className={cn(
										'scroll-mt-28',
										absence.id === highlightedAbsenceId && 'ring-2 ring-inset ring-ring',
									)}
								>
									<ItemContent className="min-w-0 basis-36">
										<ItemTitle className="line-clamp-none break-words">
											{absence.memberName}
										</ItemTitle>
										<ItemDescription className="line-clamp-none">
											{formatAbsenceRange(absence.startDate, absence.endDate)}
										</ItemDescription>
										{absence.reason && (
											<ItemDescription className="line-clamp-none break-words">
												{absence.reason}
											</ItemDescription>
										)}
									</ItemContent>
									<ItemActions className="ml-auto gap-2">
										<Button
											variant={armed ? 'destructive' : 'outline'}
											disabled={removing}
											onClick={() => {
												if (requestRemove(absence.id)) onRemove(absence.id);
											}}
											aria-label={`Abwesenheit von ${absence.memberName} (${formatAbsenceRange(absence.startDate, absence.endDate)}) ${armed ? 'endgültig entfernen' : 'entfernen'}`}
										>
											{removing && <Spinner data-icon="inline-start" aria-hidden />}
											{armed ? 'Wirklich entfernen?' : 'Entfernen'}
										</Button>
										{armed && (
											<Button
												variant="outline"
												disabled={removing}
												onClick={() => cancelRemove()}
												aria-label={`Entfernen von Abwesenheit ${absence.memberName} abbrechen`}
											>
												Abbrechen
											</Button>
										)}
									</ItemActions>
								</Item>
							);
						})}
					</ItemGroup>
				)}
				{hiddenCount > 0 && (
					<Link
						href={allAbsencesHref}
						className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
					>
						Alle {totalCount} Abwesenheiten anzeigen
					</Link>
				)}
			</CardContent>
		</Card>
	);
}
