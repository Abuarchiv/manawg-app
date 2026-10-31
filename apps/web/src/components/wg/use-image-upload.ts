'use client';

import { useEffect, useRef, useState } from 'react';
import { useWg } from '@/components/wg/WgContextProvider';
import { getLocalAccount } from '@/core/auth/local-account';
import { subscribeOnline } from '@/core/hooks/use-online-status';
import {
	isAllowedPrivateImageMimeType,
	PRIVATE_IMAGE_MAX_BYTES,
} from '@/core/infra/private-image-policy';
import {
	type ImageUploadPurpose,
	isPendingImageToken,
	PendingImageMissingError,
	readPendingImage,
	removePendingImage,
	signAndPut,
	storePendingImage,
	uploadPendingImageToken,
} from '@/core/offline/offline-images';
import type { Message } from '@/shared/i18n/message';
import {
	isRejectedPendingUpload,
	MISSING_PENDING_IMAGE,
	pendingUploadErrorMessage,
	uploadSignErrorMessage,
} from './image-upload-errors';
import { HEIC_UNSUPPORTED_ERROR, prepareUploadImage } from './prepare-upload-image';

export const MAX_UPLOAD_MB = PRIVATE_IMAGE_MAX_BYTES / 1024 / 1024;
const NETWORK_UNSTABLE_NOTICE: Message = { key: 'shell.upload.networkUnstable' };

interface ImageUploadInput {
	shareCode: string;
	purpose: ImageUploadPurpose;
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
	const [error, setError] = useState<Message | null>(null);
	const [notice, setNotice] = useState<Message | null>(null);
	const [featureDisabled, setFeatureDisabled] = useState(false);
	const [localPreview, setLocalPreview] = useState<string | null>(null);
	const uploadPendingRef = useRef(false);
	const syncPendingRef = useRef<AbortController | null>(null);
	const uploadAbortRef = useRef<AbortController | null>(null);
	// Callers pass a fresh onChange on every render; effects must not restart for that.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	// An upload that finishes after its form closed must not write into the next form.
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			uploadAbortRef.current?.abort();
		};
	}, []);

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
					setError(MISSING_PENDING_IMAGE);
					onChangeRef.current(null);
					return;
				}
				objectUrl = URL.createObjectURL(record.file);
				setLocalPreview(objectUrl);
			} catch {
				if (!cancelled) {
					setLocalPreview(null);
					setNotice(null);
					setError(MISSING_PENDING_IMAGE);
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
		// A discarded form or a new image must not get this upload's result written back.
		let stale = false;
		const abort = new AbortController();
		const account = getLocalAccount();
		const isCurrent = () => !stale && !abort.signal.aborted && getLocalAccount() === account;

		async function syncPending(): Promise<void> {
			if (!isCurrent() || !navigator.onLine || !value || syncPendingRef.current) return;
			syncPendingRef.current = abort;
			setUploading(true);
			setError(null);
			setNotice(null);
			try {
				const publicUrl = await uploadPendingImageToken(value, identity.memberId, abort.signal);
				if (!isCurrent()) return;
				onChangeRef.current(publicUrl);
			} catch (err) {
				if (!isCurrent()) return;
				if (err instanceof PendingImageMissingError) {
					setNotice(null);
					setError(MISSING_PENDING_IMAGE);
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
				setNotice({ key: 'shell.upload.retryWhenStable' });
			} finally {
				if (syncPendingRef.current === abort) {
					syncPendingRef.current = null;
					if (isCurrent()) setUploading(false);
				}
			}
		}

		void syncPending();
		const unsubscribe = subscribeOnline(() => void syncPending());
		return () => {
			stale = true;
			abort.abort();
			unsubscribe();
			if (syncPendingRef.current === abort) {
				syncPendingRef.current = null;
				setUploading(false);
			}
		};
	}, [identity.memberId, value]);

	async function handleFile(original: File): Promise<void> {
		if (disabled) return;
		if (uploadPendingRef.current) return;
		if (!original.type.startsWith('image/')) {
			setNotice(null);
			setError({ key: 'shell.upload.chooseImage' });
			return;
		}
		if (!isAllowedPrivateImageMimeType(original.type)) {
			setNotice(null);
			setError({ key: 'shell.upload.chooseType' });
			return;
		}
		uploadPendingRef.current = true;
		const abort = new AbortController();
		uploadAbortRef.current = abort;
		const account = getLocalAccount();
		const isCurrent = () =>
			mountedRef.current && !abort.signal.aborted && getLocalAccount() === account;
		const finishUpload = () => {
			if (uploadAbortRef.current !== abort) return;
			uploadAbortRef.current = null;
			uploadPendingRef.current = false;
			if (mountedRef.current) setUploading(false);
		};
		setUploading(true);
		setError(null);
		setNotice(null);
		let file = original;
		try {
			file = await prepareUploadImage(original);
		} catch (err) {
			if (isCurrent())
				setError({
					key:
						err instanceof Error && err.message === HEIC_UNSUPPORTED_ERROR
							? 'shell.upload.heicUnsupported'
							: 'shell.upload.processFailed',
				});
			finishUpload();
			return;
		}
		if (!isCurrent()) {
			finishUpload();
			return;
		}
		if (file.size > PRIVATE_IMAGE_MAX_BYTES) {
			setError({ key: 'shell.upload.tooBig', values: { max: MAX_UPLOAD_MB } });
			finishUpload();
			return;
		}
		async function keepPending(message: Message): Promise<boolean> {
			if (!isCurrent()) return false;
			try {
				const token = await storePendingImage({
					file,
					shareCode,
					memberId: identity.memberId,
					purpose,
					signal: abort.signal,
				});
				if (!isCurrent()) {
					void removePendingImage(token, identity.memberId).catch(() => undefined);
					return false;
				}
				onChange(token);
				setError(null);
				setNotice(message);
				return true;
			} catch {
				if (isCurrent()) {
					setNotice(null);
					setError({ key: 'shell.upload.cacheFailed' });
				}
				return false;
			}
		}
		if (!navigator.onLine) {
			try {
				await keepPending({ key: 'shell.upload.offlineQueued' });
			} finally {
				finishUpload();
			}
			return;
		}
		try {
			const result = await signAndPut({
				shareCode,
				purpose,
				file,
				contentType: file.type,
				memberId: identity.memberId,
				signal: abort.signal,
			});
			if (!isCurrent()) return;
			if (result.ok) {
				setNotice(null);
				onChange(result.publicUrl);
				return;
			}
			if (result.kind === 'sign') {
				if (
					result.status === 503 &&
					(result.code === '' ||
						result.code === 'feature_disabled' ||
						result.code === 'image_uploads_unavailable')
				) {
					setNotice(null);
					setFeatureDisabled(true);
					return;
				}
				// No answer or a server fault: keep the file and retry once the network is stable.
				if (result.status === 0 || result.status >= 500) {
					await keepPending(NETWORK_UNSTABLE_NOTICE);
					return;
				}
				setNotice(null);
				setError(uploadSignErrorMessage(result.status, result.code));
				return;
			}
			await keepPending(NETWORK_UNSTABLE_NOTICE);
		} catch {
			await keepPending(NETWORK_UNSTABLE_NOTICE);
		} finally {
			finishUpload();
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
