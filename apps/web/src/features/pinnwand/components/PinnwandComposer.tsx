'use client';
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ImageUploader } from '@/components/wg/ImageUploader';
import { memberTint } from '@/components/wg/MemberAvatar';
import type { AnnouncementKind } from '@/features/pinnwand/components/announcement-types';
import { CONTENT_MAX, KIND_OPTIONS } from '@/features/pinnwand/components/constants';
import { ChevronDown, ImagePlus, Send, X } from 'lucide-react';
import { type ReactElement, type RefObject, useState } from 'react';

interface PinnwandComposerProps {
	authorName: string;
	submitting: boolean;
	kind: AnnouncementKind;
	onKindChange: (kind: AnnouncementKind) => void;
	content: string;
	onContentChange: (value: string) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	imageUrl: string | null;
	onImageUrlChange: (value: string | null) => void;
	shareCode: string;
	error: string | null;
	onClose: () => void;
	onSubmit: () => void;
}

export function PinnwandComposer({
	authorName,
	submitting,
	kind,
	onKindChange,
	content,
	onContentChange,
	textareaRef,
	imageUrl,
	onImageUrlChange,
	shareCode,
	error,
	onClose,
	onSubmit,
}: PinnwandComposerProps): ReactElement {
	const [attachmentOpen, setAttachmentOpen] = useState(Boolean(imageUrl));
	return (
		<Card id="announcement-composer" aria-busy={submitting}>
			<CardHeader>
				<CardTitle className="flex min-w-0 items-center gap-2">
					<Avatar>
						<AvatarFallback style={memberTint(authorName)}>
							{authorName.slice(0, 2).toLocaleUpperCase('de-DE')}
						</AvatarFallback>
					</Avatar>
					<h2>Neuer Beitrag</h2>
				</CardTitle>
				<CardDescription>Von {authorName}</CardDescription>
				<CardAction>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						onClick={onClose}
						disabled={submitting}
						className="shrink-0"
						aria-label="Beitrag abbrechen"
					>
						<X aria-hidden />
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<FieldGroup>
					<Field>
						<FieldLabel id="announcement-kind-label">Beitragstyp</FieldLabel>
						<ToggleGroup
							value={[kind]}
							onValueChange={(values) => {
								const selected = KIND_OPTIONS.find((option) => option.value === values[0]);
								if (selected) onKindChange(selected.value);
							}}
							disabled={submitting}
							spacing={1}
							variant="outline"
							className="flex-wrap"
							aria-labelledby="announcement-kind-label"
						>
							{KIND_OPTIONS.map((option) => (
								<ToggleGroupItem key={option.value} value={option.value}>
									{option.label}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</Field>
					<Field data-invalid={Boolean(error)}>
						<FieldLabel htmlFor="announcement-content">Beitragstext</FieldLabel>
						<Textarea
							ref={textareaRef}
							id="announcement-content"
							value={content}
							onChange={(e) => onContentChange(e.target.value)}
							disabled={submitting}
							maxLength={CONTENT_MAX}
							rows={4}
							aria-label="Beitragstext"
							aria-invalid={Boolean(error)}
							aria-describedby={error ? 'announcement-error' : 'announcement-count'}
							placeholder={`Was gibt es Neues, ${authorName}?`}
							className="min-h-32 text-base"
						/>
					</Field>
				</FieldGroup>
				<Collapsible open={attachmentOpen || Boolean(imageUrl)} onOpenChange={setAttachmentOpen}>
					<CollapsibleTrigger render={<Button variant="outline" />} disabled={submitting}>
						<ImagePlus data-icon="inline-start" aria-hidden />
						{imageUrl ? 'Bild angehängt' : 'Bild anhängen'}
						<ChevronDown data-icon="inline-end" aria-hidden />
					</CollapsibleTrigger>
					<CollapsiblePanel keepRendered inert={!attachmentOpen && !imageUrl}>
						<div className="pt-3">
							<ImageUploader
								shareCode={shareCode}
								purpose="announcement"
								value={imageUrl}
								onChange={onImageUrlChange}
								disabled={submitting}
								imageLabel="Beitragsbild"
							/>
						</div>
					</CollapsiblePanel>
				</Collapsible>
				{error && (
					<Alert id="announcement-error" variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
			</CardContent>
			<CardFooter className="flex-wrap justify-between gap-3">
				<span id="announcement-count" className="text-xs tabular-nums text-muted-foreground">
					{content.length}/{CONTENT_MAX}
				</span>
				<Button
					type="button"
					onClick={onSubmit}
					disabled={submitting || content.trim().length === 0}
				>
					{submitting ? (
						<Spinner data-icon="inline-start" aria-hidden />
					) : (
						<Send data-icon="inline-start" aria-hidden />
					)}
					{submitting ? 'Wird gepostet…' : 'Posten'}
				</Button>
			</CardFooter>
		</Card>
	);
}
