'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useWg } from '@/components/wg/WgContextProvider';
import {
	isPendingImageToken,
	readPendingImage,
	removePendingImage,
	storePendingImage,
	uploadPendingImageToken,
} from '@/core/offline/offline-images';
import { cn } from '@/shared/lib/cn';
import { AlertTriangle, ImagePlus, Maximize2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface Props {
	shareCode: string;
	purpose: 'expense' | 'announcement';
	value: string | null;
	onChange: (url: string | null) => void;
	disabled?: boolean;
	imageLabel?: string;
}

interface SignResponse {
	presignedUrl: string;
	publicUrl: string;
	maxFileSize: number;
	uploadHeaders?: Record<string, string>;
}

interface ErrorResponse {
	error?: string;
	code?: string;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/heic',
	'image/heif',
]);
const MISSING_PENDING_IMAGE_MESSAGE =
	'Bild konnte auf diesem Gerät nicht mehr gefunden werden. Entferne den Platzhalter und wähle es erneut aus.';

async function readUploadSignError(response: Response): Promise<string> {
	try {
		const body = (await response.clone().json()) as ErrorResponse;
		return body.error ?? body.code ?? '';
	} catch {
		return '';
	}
}

function uploadSignErrorMessage(status: number, error: string): string {
	if (status === 404 || error === 'wg_not_found') {
		return 'Bild konnte nicht hochgeladen werden: Öffne die WG über den aktuellen Link erneut.';
	}
	if (error === 'invalid_share_code') {
		return 'Bild konnte nicht hochgeladen werden: Der WG-Code ist ungültig.';
	}
	if (
		status === 401 ||
		error === 'not_a_member' ||
		error === 'member_id_required' ||
		error === 'member_id_invalid'
	) {
		return 'Bild konnte nicht hochgeladen werden: Tritt der WG erneut bei.';
	}
	if (error === 'invalid_file') {
		return 'Bild konnte nicht hochgeladen werden: Datei oder Dateityp ist ungültig.';
	}
	if (error === 'invalid_mime_type') {
		return 'Bild konnte nicht hochgeladen werden: Bitte JPG, PNG, WebP oder HEIC wählen.';
	}
	if (error === 'file_too_large') {
		return 'Bild konnte nicht hochgeladen werden: Das Bild ist zu groß.';
	}
	if (error === 'feature_disabled' || error === 'image_uploads_unavailable') {
		return 'Bild-Upload ist noch nicht konfiguriert.';
	}
	if (error === 'invalid_body' || error === 'invalid_json') {
		return 'Bild konnte nicht hochgeladen werden: Die Anfrage war ungültig.';
	}
	return 'Konnte Upload-Signatur nicht holen.';
}

function pendingUploadErrorMessage(error: unknown): string | null {
	if (!(error instanceof Error)) return null;
	const match = /^sign-failed:(\d+)(?::(.+))?$/.exec(error.message);
	if (!match) return null;
	const status = Number(match[1]);
	const message = uploadSignErrorMessage(status, match[2] ?? '');
	if (status >= 500 && message === 'Konnte Upload-Signatur nicht holen.') return null;
	return message;
}

export function ImageUploader({
	shareCode,
	purpose,
	value,
	onChange,
	disabled = false,
	imageLabel,
}: Props) {
	const { identity } = useWg();
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [featureDisabled, setFeatureDisabled] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	const [localPreview, setLocalPreview] = useState<string | null>(null);
	const uploadPendingRef = useRef(false);
	const syncPendingRef = useRef<string | null>(null);
	const previewDialogRef = useRef<HTMLDialogElement>(null);
	const previewCloseButtonRef = useRef<HTMLButtonElement>(null);
	const accessibleImageLabel = imageLabel ?? (purpose === 'expense' ? 'Belegbild' : 'Beitragsbild');

	useEffect(() => {
		let cancelled = false;
		let objectUrl: string | null = null;

		async function loadPendingPreview(): Promise<void> {
			if (!isPendingImageToken(value)) {
				setLocalPreview(null);
				return;
			}
			try {
				const record = await readPendingImage(value, identity.memberId);
				if (cancelled) return;
				if (!record) {
					setLocalPreview(null);
					setNotice(null);
					setError(MISSING_PENDING_IMAGE_MESSAGE);
					onChange(null);
					return;
				}
				objectUrl = URL.createObjectURL(record.file);
				setLocalPreview(objectUrl);
			} catch {
				if (!cancelled) {
					setLocalPreview(null);
					setNotice(null);
					setError(MISSING_PENDING_IMAGE_MESSAGE);
					onChange(null);
				}
			}
		}

		void loadPendingPreview();
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [identity.memberId, onChange, value]);

	useEffect(() => {
		if (!isPendingImageToken(value)) return;

		async function syncPending(): Promise<void> {
			if (!navigator.onLine || !value) return;
			if (syncPendingRef.current === value) return;
			syncPendingRef.current = value;
			setUploading(true);
			setError(null);
			setNotice(null);
			try {
				const publicUrl = await uploadPendingImageToken(value, identity.memberId);
				onChange(publicUrl);
			} catch (err) {
				if (err instanceof Error && err.message === 'pending-image-missing') {
					setNotice(null);
					setError(MISSING_PENDING_IMAGE_MESSAGE);
					onChange(null);
					return;
				}
				const actionableMessage = pendingUploadErrorMessage(err);
				if (actionableMessage) {
					setNotice(null);
					setError(actionableMessage);
					return;
				}
				setNotice('Bild ist vorbereitet und wird erneut hochgeladen, sobald das Netz stabil ist.');
			} finally {
				syncPendingRef.current = null;
				setUploading(false);
			}
		}

		void syncPending();
		window.addEventListener('online', syncPending);
		return () => window.removeEventListener('online', syncPending);
	}, [identity.memberId, onChange, value]);

	useEffect(() => {
		if (!previewOpen || !value) return;
		const dialog = previewDialogRef.current;
		if (!dialog) return;

		if (!dialog.open) {
			if (typeof dialog.showModal === 'function') {
				dialog.showModal();
			} else {
				dialog.setAttribute('open', '');
			}
		}
		requestAnimationFrame(() => previewCloseButtonRef.current?.focus());

		return () => {
			if (dialog.open && typeof dialog.close === 'function') dialog.close();
		};
	}, [previewOpen, value]);

	async function handleFile(file: File): Promise<void> {
		if (disabled) return;
		if (uploadPendingRef.current) return;
		if (!file.type.startsWith('image/')) {
			setNotice(null);
			setError('Bitte ein Bild auswählen.');
			return;
		}
		if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
			setNotice(null);
			setError('Bitte JPG, PNG, WebP oder HEIC wählen.');
			return;
		}
		if (file.size > MAX_FILE_BYTES) {
			setNotice(null);
			setError('Bild zu groß (max 8 MB).');
			return;
		}
		uploadPendingRef.current = true;
		async function keepPending(message: string): Promise<boolean> {
			try {
				const token = await storePendingImage({
					file,
					shareCode,
					memberId: identity.memberId,
					purpose,
				});
				onChange(token);
				setError(null);
				setNotice(message);
				return true;
			} catch {
				setNotice(null);
				setError('Bild konnte nicht zwischengespeichert werden. Versuche es später erneut.');
				return false;
			}
		}
		if (typeof navigator !== 'undefined' && !navigator.onLine) {
			try {
				await keepPending(
					'Bild vorbereitet. Der Upload startet automatisch, sobald du wieder online bist.',
				);
			} finally {
				uploadPendingRef.current = false;
			}
			return;
		}
		setUploading(true);
		setError(null);
		setNotice(null);
		try {
			const sigRes = await fetch('/api/upload/sign', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
				},
				body: JSON.stringify({ shareCode, purpose, mimeType: file.type, fileSize: file.size }),
			});
			const signError = sigRes.ok ? '' : await readUploadSignError(sigRes);
			if (
				sigRes.status === 503 &&
				(signError === '' ||
					signError === 'feature_disabled' ||
					signError === 'image_uploads_unavailable')
			) {
				setNotice(null);
				setFeatureDisabled(true);
				return;
			}
			if (sigRes.status >= 500) {
				await keepPending(
					'Bild vorbereitet. Der Upload startet automatisch, sobald das Netz wieder stabil ist.',
				);
				return;
			}
			if (!sigRes.ok) {
				setNotice(null);
				setError(uploadSignErrorMessage(sigRes.status, signError));
				return;
			}
			const sig = (await sigRes.json()) as SignResponse;

			const uploadRes = await fetch(sig.presignedUrl, {
				method: 'PUT',
				body: file,
				headers: { ...sig.uploadHeaders, 'Content-Type': file.type },
			});
			if (!uploadRes.ok) {
				await keepPending(
					'Bild vorbereitet. Der Upload startet automatisch, sobald das Netz wieder stabil ist.',
				);
				return;
			}
			setNotice(null);
			onChange(sig.publicUrl);
		} catch {
			await keepPending(
				'Bild vorbereitet. Der Upload startet automatisch, sobald das Netz wieder stabil ist.',
			);
		} finally {
			uploadPendingRef.current = false;
			setUploading(false);
		}
	}

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
						<div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
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
							onClick={() => {
								if (disabled) return;
								if (uploading) return;
								if (pending) void removePendingImage(value, identity.memberId);
								setNotice(null);
								setError(null);
								onChange(null);
							}}
							aria-label={`${accessibleImageLabel} entfernen`}
							disabled={disabled || uploading}
						>
							<X aria-hidden />
						</Button>
					</div>
				</div>
				{previewOpen && previewSrc && (
					<dialog
						ref={previewDialogRef}
						aria-label={`${accessibleImageLabel}-Vorschau`}
						onCancel={(event) => {
							event.preventDefault();
							setPreviewOpen(false);
						}}
						onMouseDown={(event) => {
							if (event.target === event.currentTarget) setPreviewOpen(false);
						}}
						className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
					>
						<Button
							variant="secondary"
							size="icon-lg"
							ref={previewCloseButtonRef}
							type="button"
							onClick={() => setPreviewOpen(false)}
							aria-label={`${accessibleImageLabel}-Vorschau schließen`}
							className="absolute right-4 top-4"
						>
							<X aria-hidden />
						</Button>
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img
							src={previewSrc}
							alt={`${accessibleImageLabel} groß`}
							className="max-h-full max-w-full rounded-lg object-contain"
						/>
					</dialog>
				)}
				{error && (
					<Alert variant="destructive" className="mt-2">
						<AlertDescription className="text-current">{error}</AlertDescription>
					</Alert>
				)}
				{notice && (
					<output className="mt-2 block text-[12px] text-muted-foreground" aria-live="polite">
						{notice}
					</output>
				)}
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
					'flex h-32 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-background text-sm text-muted-foreground transition-colors focus-within:ring-2 focus-within:ring-ring/50',
					disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/50',
				)}
			>
				{uploading ? (
					<Spinner className="size-6" aria-hidden="true" />
				) : (
					<ImagePlus className="size-6" aria-hidden="true" />
				)}
				<span aria-live="polite">{uploading ? 'Lade hoch…' : 'Bild hinzufügen'}</span>
				<span className="text-xs text-muted-foreground">JPG, PNG, WebP, HEIC · max. 8 MB</span>
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
			{error && (
				<Alert variant="destructive" className="mt-2">
					<AlertDescription className="text-current">{error}</AlertDescription>
				</Alert>
			)}
			{notice && (
				<output className="mt-2 block text-[12px] text-muted-foreground" aria-live="polite">
					{notice}
				</output>
			)}
		</div>
	);
}
