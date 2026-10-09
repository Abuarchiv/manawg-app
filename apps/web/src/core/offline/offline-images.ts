'use client';

import { REQUEST_TIMEOUT_MS, anySignal } from '@/core/infra/api-client';
import { EXPECTED_MEMBER_ID_HEADER } from '@/shared/lib/member-header';
import { createOfflineIdempotencyKey } from './offline-queue';

const DB_NAME = 'manawg-offline-images';
const STORE_NAME = 'images';
const DB_VERSION = 1;
const TOKEN_PREFIX = 'manawg-pending-image:';
// A stalled PUT on a bad mobile connection would otherwise block the uploader indefinitely.
export const UPLOAD_TIMEOUT_MS = 60_000;

interface PendingImageRecord {
	id: string;
	file: Blob;
	name: string;
	type: string;
	size: number;
	shareCode: string;
	memberId: string;
	purpose: 'expense' | 'announcement' | 'chat';
	createdAt: string;
	publicUrl?: string;
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

/** Error code of a failed /api/upload/sign response, or '' when the body is unreadable. */
export async function readUploadSignError(response: Response): Promise<string> {
	try {
		const body = (await response.clone().json()) as ErrorResponse;
		return body.error ?? body.code ?? '';
	} catch {
		return '';
	}
}

function createPendingImageToken(id: string): string {
	return `${TOKEN_PREFIX}${id}`;
}

export function isPendingImageToken(value: string | null | undefined): value is string {
	return Boolean(value?.startsWith(TOKEN_PREFIX));
}

function pendingImageIdFromToken(token: string): string {
	return token.slice(TOKEN_PREFIX.length);
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function withStore<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, mode);
		const request = run(tx.objectStore(STORE_NAME));
		let result: T;
		let requestError: DOMException | null = null;
		request.onsuccess = () => {
			result = request.result;
		};
		request.onerror = () => {
			requestError = request.error;
		};
		tx.oncomplete = () => {
			db.close();
			if (requestError) reject(requestError);
			else resolve(result);
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
		tx.onabort = () => {
			db.close();
			reject(tx.error ?? new Error('offline-image-transaction-aborted'));
		};
	});
}

export async function storePendingImage(input: {
	file: File;
	shareCode: string;
	memberId: string;
	purpose: 'expense' | 'announcement' | 'chat';
}): Promise<string> {
	const now = Date.now();
	// Local IndexedDB key only: prefer UUID, but keep browsers without Web Crypto usable.
	const suffix =
		createOfflineIdempotencyKey() ?? `${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
	const id = `${input.shareCode}:${input.purpose}:${now}:${suffix}`;
	const record: PendingImageRecord = {
		id,
		file: input.file,
		name: input.file.name,
		type: input.file.type,
		size: input.file.size,
		shareCode: input.shareCode,
		memberId: input.memberId,
		purpose: input.purpose,
		createdAt: new Date(now).toISOString(),
	};
	await withStore('readwrite', (store) => store.put(record, id));
	return createPendingImageToken(id);
}

export async function readPendingImage(
	token: string,
	memberId: string,
): Promise<PendingImageRecord | null> {
	if (!isPendingImageToken(token)) return null;
	const record = await withStore('readonly', (store) => store.get(pendingImageIdFromToken(token)));
	return record?.memberId === memberId ? record : null;
}

export async function removePendingImage(token: string, memberId: string): Promise<void> {
	if (!isPendingImageToken(token)) return;
	if (!(await readPendingImage(token, memberId))) return;
	await withStore('readwrite', (store) => store.delete(pendingImageIdFromToken(token)));
}

export async function uploadPendingImageToken(
	token: string,
	memberId: string,
	signal?: AbortSignal,
): Promise<string> {
	const record = await readPendingImage(token, memberId);
	if (!record) throw new Error('pending-image-missing');
	if (record.publicUrl) return record.publicUrl;
	// A stalled request must not block the offline sync forever.
	const withTimeout = (ms: number) =>
		signal ? anySignal([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
	const sigRes = await fetch('/api/upload/sign', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			[EXPECTED_MEMBER_ID_HEADER]: memberId,
		},
		signal: withTimeout(REQUEST_TIMEOUT_MS),
		body: JSON.stringify({
			shareCode: record.shareCode,
			purpose: record.purpose,
			mimeType: record.type,
			fileSize: record.size,
		}),
	});
	if (!sigRes.ok) {
		const error = await readUploadSignError(sigRes);
		throw new Error(
			error ? `sign-failed:${sigRes.status}:${error}` : `sign-failed:${sigRes.status}`,
		);
	}
	const sig = (await sigRes.json()) as SignResponse;
	const uploadRes = await fetch(sig.presignedUrl, {
		method: 'PUT',
		body: record.file,
		headers: { ...sig.uploadHeaders, 'Content-Type': record.type },
		signal: withTimeout(UPLOAD_TIMEOUT_MS),
	});
	if (!uploadRes.ok) throw new Error(`upload-failed:${uploadRes.status}`);
	await withStore('readwrite', (store) =>
		store.put({ ...record, publicUrl: sig.publicUrl }, record.id),
	);
	return sig.publicUrl;
}
