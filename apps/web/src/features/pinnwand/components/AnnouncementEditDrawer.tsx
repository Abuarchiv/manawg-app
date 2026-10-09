'use client';

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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type {
	Announcement,
	AnnouncementKind,
} from '@/features/pinnwand/components/announcement-types';
import { CONTENT_MAX, KIND_OPTIONS } from '@/features/pinnwand/components/constants';
import { Check } from 'lucide-react';
import { type ReactElement, useRef, useState } from 'react';

interface AnnouncementEditDrawerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	announcement: Announcement;
	/** Resolves true when saved; on false the drawer stays open and the page shows the error. */
	onSave: (next: { content: string; kind: AnnouncementKind }) => Promise<boolean>;
}

/** Edit text and type of an own post. Mounted per open, so the fields always start from the current post. */
export function AnnouncementEditDrawer({
	open,
	onOpenChange,
	announcement,
	onSave,
}: AnnouncementEditDrawerProps): ReactElement {
	const [content, setContent] = useState(announcement.content);
	const [kind, setKind] = useState<AnnouncementKind>(announcement.kind);
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const trimmed = content.trim();
	const unchanged = trimmed === announcement.content.trim() && kind === announcement.kind;

	async function save() {
		if (savingRef.current || !trimmed) return;
		if (unchanged) {
			onOpenChange(false);
			return;
		}
		savingRef.current = true;
		setSaving(true);
		try {
			if (await onSave({ content: trimmed, kind })) onOpenChange(false);
		} finally {
			savingRef.current = false;
			setSaving(false);
		}
	}

	return (
		<Drawer
			open={open}
			onOpenChange={(next) => {
				if (!saving) onOpenChange(next);
			}}
		>
			<DrawerContent
				className="mx-auto w-full max-w-md"
				initialFocus={textareaRef}
				aria-busy={saving}
			>
				<DrawerHeader>
					<DrawerTitle>Beitrag bearbeiten</DrawerTitle>
					<DrawerDescription className="sr-only">
						Text und Art deines Beitrags ändern.
					</DrawerDescription>
				</DrawerHeader>
				<div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
					<FieldGroup>
						<Field>
							<FieldLabel id={`edit-kind-label-${announcement.id}`} className="sr-only">
								Beitragstyp
							</FieldLabel>
							<ToggleGroup
								value={[kind]}
								onValueChange={(values) => {
									const selected = KIND_OPTIONS.find((option) => option.value === values[0]);
									if (selected) setKind(selected.value);
								}}
								disabled={saving}
								spacing={1}
								variant="outline"
								className="flex-wrap"
								aria-labelledby={`edit-kind-label-${announcement.id}`}
							>
								{KIND_OPTIONS.map((option) => (
									<ToggleGroupItem key={option.value} value={option.value} className="px-2">
										{option.label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</Field>
						<Field>
							<FieldLabel htmlFor={`edit-content-${announcement.id}`} className="sr-only">
								Beitragstext
							</FieldLabel>
							<Textarea
								ref={textareaRef}
								id={`edit-content-${announcement.id}`}
								value={content}
								onChange={(event) => setContent(event.target.value)}
								readOnly={saving}
								aria-busy={saving}
								maxLength={CONTENT_MAX}
								rows={4}
								className="min-h-24 text-base read-only:opacity-60"
							/>
						</Field>
					</FieldGroup>
					{announcement.imageUrl && (
						<Alert>
							<AlertDescription>Das angehängte Bild bleibt unverändert.</AlertDescription>
						</Alert>
					)}
				</div>
				<DrawerFooter className="border-t pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
					<Button
						type="button"
						className="w-full"
						onClick={() => void save()}
						disabled={saving || !trimmed}
					>
						{saving ? (
							<Spinner data-icon="inline-start" aria-hidden />
						) : (
							<Check data-icon="inline-start" aria-hidden />
						)}
						{saving ? 'Wird gespeichert…' : 'Speichern'}
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={saving}
					>
						Abbrechen
					</Button>
				</DrawerFooter>
			</DrawerContent>
		</Drawer>
	);
}
