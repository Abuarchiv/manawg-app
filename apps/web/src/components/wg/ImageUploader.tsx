'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { isPendingImageToken } from '@/core/offline/offline-images';
import { cn } from '@/shared/lib/cn';
import { AlertTriangle, ImagePlus, Maximize2, X } from 'lucide-react';
import { useState } from 'react';
import { ImagePreviewDialog } from './ImagePreviewDialog';
import { useImageUpload } from './use-image-upload';

interface Props {
	shareCode: string;
	purpose: 'expense' | 'announcement' | 'chat';
	value: string | null;
	onChange: (url: string | null) => void;
	disabled?: boolean;
	imageLabel?: string;
}

function UploadFeedback({ error, notice }: { error: string | null; notice: string | null }) {
	return (
		<>
			{error && (
				<Alert variant="destructive" className="mt-2">
					<AlertDescription className="text-current">{error}</AlertDescription>
				</Alert>
			)}
			{notice && (
				<output className="mt-2 block text-meta text-muted-foreground" aria-live="polite">
					{notice}
				</output>
			)}
		</>
	);
}

export function ImageUploader({
	shareCode,
	purpose,
	value,
	onChange,
	disabled = false,
	imageLabel,
}: Props) {
	const { uploading, error, notice, featureDisabled, localPreview, handleFile, remove } =
		useImageUpload({ shareCode, purpose, value, onChange, disabled });
	const [previewOpen, setPreviewOpen] = useState(false);
	const accessibleImageLabel = imageLabel ?? (purpose === 'expense' ? 'Belegbild' : 'Beitragsbild');

	if (value) {
		const pending = isPendingImageToken(value);
		const previewSrc = pending ? localPreview : value;
		return (
			<>
				<div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg border border-border bg-card">
					{previewSrc ? (
						// eslint-disable-next-line @next/next/no-img-element
						<img
							src={previewSrc}
							alt={
								pending
									? `${accessibleImageLabel} vorbereitet`
									: `${accessibleImageLabel} hochgeladen`
							}
							className="h-full w-full object-cover"
							loading="lazy"
						/>
					) : (
						<div className="flex h-full items-center justify-center text-meta text-muted-foreground">
							Bild wird vorbereitet…
						</div>
					)}
					{pending && (
						<Badge
							variant="secondary"
							className="absolute left-2 top-2 bg-background/90 text-foreground"
						>
							Offline bereit
						</Badge>
					)}
					<div className="absolute right-2 top-2 flex gap-1.5">
						<Button
							variant="secondary"
							size="icon-lg"
							type="button"
							onClick={() => setPreviewOpen(true)}
							aria-label={`${accessibleImageLabel} groß anzeigen`}
							disabled={!previewSrc}
						>
							<Maximize2 aria-hidden />
						</Button>
						<Button
							variant="secondary"
							size="icon-lg"
							type="button"
							onClick={remove}
							aria-label={`${accessibleImageLabel} entfernen`}
							disabled={disabled || uploading}
						>
							<X aria-hidden />
						</Button>
					</div>
				</div>
				{previewOpen && previewSrc && (
					<ImagePreviewDialog
						src={previewSrc}
						label={accessibleImageLabel}
						onClose={() => setPreviewOpen(false)}
					/>
				)}
				<UploadFeedback error={error} notice={notice} />
			</>
		);
	}

	if (featureDisabled) {
		return (
			<Alert>
				<AlertTriangle aria-hidden />
				<AlertDescription>Bild-Upload ist noch nicht konfiguriert.</AlertDescription>
			</Alert>
		);
	}

	return (
		<div>
			<label
				className={cn(
					'flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg px-3 py-3 border-2 border-dashed border-border bg-background text-sm text-muted-foreground transition-colors focus-within:ring-2 focus-within:ring-ring/50',
					disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/50',
				)}
			>
				{uploading ? (
					<Spinner className="size-6" aria-hidden="true" />
				) : (
					<ImagePlus className="size-6" aria-hidden="true" />
				)}
				<span aria-live="polite">{uploading ? 'Lädt hoch…' : 'Bild hinzufügen'}</span>
				<span className="text-center text-xs text-muted-foreground">
					JPG, PNG, WebP, HEIC · max. 8 MB
				</span>
				<input
					type="file"
					accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
					className="sr-only"
					aria-label="Bild auswählen"
					disabled={disabled || uploading}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) void handleFile(file);
						e.currentTarget.value = '';
					}}
				/>
			</label>
			<UploadFeedback error={error} notice={notice} />
		</div>
	);
}
