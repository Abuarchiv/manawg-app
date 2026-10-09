'use client';

import { useWg } from '@/components/wg/WgContextProvider';
import { subscribeOnline } from '@/core/hooks/use-online-status';
import { REQUEST_TIMEOUT_MS } from '@/core/infra/api-client';
import {
	UPLOAD_TIMEOUT_MS,
	isPendingImageToken,
	readPendingImage,
	readUploadSignError,
	removePendingImage,
	storePendingImage,
	uploadPendingImageToken,
} from '@/core/offline/offline-images';
import { useEffect, useRef, useState } from 'react';
import {
	MISSING_PENDING_IMAGE_MESSAGE,
	isRejectedPendingUpload,
	pendingUploadErrorMessage,
	uploadSignErrorMessage,
} from './image-upload-errors';
import { prepareUploadImage } from './prepare-upload-image';

interface SignResponse {
	presignedUrl: string;
	publicUrl: string;
	maxFileSize: number;
	uploadHeaders?: Record<string, string>;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/heic',
	'image/heif',
]);

interface ImageUploadInput {
	shareCode: string;
	purpose: 'expense' | 'announcement' | 'chat';
	value: string | null;
	onChange: (url: string | null) => void;
	disabled: boolean;
}

/**
 * Uploads an image through a presigned URL. Offline or on a failing network the file is kept
 * on the device as a pending token and uploaded once the connection is back.
 */
export function useImageUpload({
	shareCode,
	purpose,
	value,
	onChange,
	disabled,
}: ImageUploadInput) {
	const { identity } = useWg();
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [featureDisabled, setFeatureDisabled] = useState(false);
	const [localPreview, setLocalPreview] = useState<string | null>(null);
	const uploadPendingRef = useRef(false);
	const syncPendingRef = useRef<string | null>(null);
	// Callers pass a fresh onChange on every render (the chat composer); effects must not restart for that.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

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
					onChangeRef.current(null);
					return;
				}
				objectUrl = URL.createObjectURL(record.file);
				setLocalPreview(objectUrl);
			} catch {
				if (!cancelled) {
					setLocalPreview(null);
					setNotice(null);
					setError(MISSING_PENDING_IMAGE_MESSAGE);
					onChangeRef.current(null);
				}
			}
		}

		void loadPendingPreview();
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [identity.memberId, value]);

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
				onChangeRef.current(publicUrl);
			} catch (err) {
				if (err instanceof Error && err.message === 'pending-image-missing') {
					setNotice(null);
					setError(MISSING_PENDING_IMAGE_MESSAGE);
					onChangeRef.current(null);
					return;
				}
				const actionableMessage = pendingUploadErrorMessage(err);
				if (actionableMessage) {
					setNotice(null);
					setError(actionableMessage);
					// The storage refused the file for good; retrying would only burn upload signatures.
					if (isRejectedPendingUpload(err)) {
						void removePendingImage(value, identity.memberId).catch(() => undefined);
						onChangeRef.current(null);
					}
					return;
				}
				setNotice('Bild ist vorbereitet und wird erneut hochgeladen, sobald das Netz stabil ist.');
			} finally {
				syncPendingRef.current = null;
				setUploading(false);
			}
		}

		void syncPending();
		return subscribeOnline(() => void syncPending());
	}, [identity.memberId, value]);

	async function handleFile(original: File): Promise<void> {
		if (disabled) return;
		if (uploadPendingRef.current) return;
		if (!original.type.startsWith('image/')) {
			setNotice(null);
			setError('Bitte ein Bild auswählen.');
			return;
		}
		if (!ALLOWED_IMAGE_TYPES.has(original.type)) {
			setNotice(null);
			setError('Bitte JPG, PNG, WebP oder HEIC wählen.');
			return;
		}
		uploadPendingRef.current = true;
		setUploading(true);
		setError(null);
		setNotice(null);
		let file = original;
		try {
			file = await prepareUploadImage(original);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Bild konnte nicht verarbeitet werden.');
			uploadPendingRef.current = false;
			setUploading(false);
			return;
		}
		if (file.size > MAX_FILE_BYTES) {
			setError('Bild zu groß (max. 8 MB). Wähle ein kleineres Bild.');
			uploadPendingRef.current = false;
			setUploading(false);
			return;
		}
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
				setUploading(false);
			}
			return;
		}
		try {
			const sigRes = await fetch('/api/upload/sign', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
				},
				body: JSON.stringify({ shareCode, purpose, mimeType: file.type, fileSize: file.size }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
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

	function remove(): void {
		if (disabled || uploading || !value) return;
		if (isPendingImageToken(value)) void removePendingImage(value, identity.memberId);
		setNotice(null);
		setError(null);
		onChange(null);
	}

	return { uploading, error, notice, featureDisabled, localPreview, handleFile, remove };
}
