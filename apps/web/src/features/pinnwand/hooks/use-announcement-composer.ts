import { useToast } from '@/components/ui/Toast';
import { apiFetch } from '@/core/infra/api-client';
import { notificationWarningMessage } from '@/core/notifications/notification-warning';
import { buildDraftKey, readDraft, removeDraft, writeDraft } from '@/core/offline/drafts';
import {
	enqueueOfflineAction,
	isOfflineActionQueued,
	updateOfflineQueue,
} from '@/core/offline/offline-client';
import {
	DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE,
	OFFLINE_SAVED_NOTICE,
	QUEUE_EDIT_ALREADY_SENT_MESSAGE,
} from '@/core/offline/offline-copy';
import { isPendingImageToken } from '@/core/offline/offline-images';
import {
	createOfflineIdempotencyKey,
	createQueuedAnnouncement,
} from '@/core/offline/offline-queue';
import { announcementCreateErrorMessage } from '@/features/pinnwand/announcement-errors';
import type { AnnouncementKind } from '@/features/pinnwand/components/announcement-types';
import { CONTENT_MAX } from '@/features/pinnwand/components/constants';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type {
	AnnouncementPageContext,
	AnnouncementWriteResponse,
} from './announcement-page-context';

function kindFromParam(value: string | null): AnnouncementKind | null {
	if (
		value === 'info' ||
		value === 'question' ||
		value === 'problem' ||
		value === 'request' ||
		value === 'decision'
	) {
		return value;
	}
	return null;
}

/** Compose a post: composer state, localStorage draft, prefill from the URL and creation (online/offline). */
export function useAnnouncementComposer(
	ctx: AnnouncementPageContext,
	scrollToAnnouncement: (id: string, behavior?: ScrollBehavior) => void,
) {
	const { wg, identity, encodedShareCode, setNotice, load, refreshCount } = ctx;
	const toast = useToast();
	const searchParams = useSearchParams();
	const prefillContent = searchParams.get('content');
	const prefillKind = kindFromParam(searchParams.get('kind'));
	const prefillImageUrl = searchParams.get('imageUrl');
	const [content, setContent] = useState('');
	const [kind, setKind] = useState<AnnouncementKind>('info');
	const [imageUrl, setImageUrl] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);
	const announcementIdempotencyKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [composerOpen, setComposerOpen] = useState(false);
	const [queueEditId, setQueueEditId] = useState<string | null>(null);
	const [draftHydrated, setDraftHydrated] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const appliedPrefillRef = useRef<string | null>(null);
	const draftKey = buildDraftKey(wg.shareCode, identity.memberId, 'announcement');
	const prefillKey = `${prefillContent ?? ''}|${prefillKind ?? ''}|${prefillImageUrl ?? ''}`;
	const hasDraft = Boolean(content.trim() || imageUrl || queueEditId);

	const createButtonRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (!composerOpen) return;
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape' && content.length === 0 && !imageUrl) {
				setComposerOpen(false);
				setError(null);
				setNotice(null);
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [composerOpen, content, imageUrl, setNotice]);

	// On send error: focus back into the text field (the disabled send button took it away).
	useEffect(() => {
		if (error && composerOpen && document.activeElement === document.body) {
			textareaRef.current?.focus({ preventScroll: true });
		}
	}, [error, composerOpen]);

	function closeComposer(): void {
		if (submittingRef.current) return;
		setComposerOpen(false);
		setError(null);
		setNotice(null);
	}

	useEffect(() => {
		if (prefillContent || prefillKind || prefillImageUrl) {
			setDraftHydrated(true);
			return;
		}
		const draft = readDraft<{
			content?: string;
			kind?: AnnouncementKind;
			imageUrl?: string | null;
			queueEditId?: string;
		}>(draftKey);
		if (!draft) {
			setDraftHydrated(true);
			return;
		}
		if (draft?.content) {
			setContent(draft.content);
		}
		if (draft?.kind) setKind(draft.kind);
		if (draft && 'imageUrl' in draft) setImageUrl(draft.imageUrl ?? null);
		if (draft?.queueEditId) {
			setQueueEditId(draft.queueEditId);
		}
		setDraftHydrated(true);
	}, [draftKey, prefillContent, prefillImageUrl, prefillKind]);

	useEffect(() => {
		if (!prefillContent && !prefillKind && !prefillImageUrl) return;
		if (appliedPrefillRef.current === prefillKey) return;
		appliedPrefillRef.current = prefillKey;
		if (prefillContent) setContent(prefillContent.slice(0, CONTENT_MAX));
		if (prefillKind) setKind(prefillKind);
		if (prefillImageUrl) setImageUrl(prefillImageUrl);
		setComposerOpen(true);
		// Take the prefill only once: otherwise the composer reopens after cancel and reload.
		const url = new URL(window.location.href);
		for (const name of ['content', 'kind', 'imageUrl']) url.searchParams.delete(name);
		window.history.replaceState(window.history.state, '', url);
	}, [prefillContent, prefillImageUrl, prefillKey, prefillKind]);

	useEffect(() => {
		if (!draftHydrated) return;
		writeDraft(draftKey, { content, kind, imageUrl, queueEditId });
	}, [content, draftHydrated, draftKey, imageUrl, kind, queueEditId]);

	async function clearEditedQueueItem(): Promise<boolean> {
		if (!queueEditId) return true;
		const saved = await updateOfflineQueue((actions) =>
			actions.some((item) => item.id === queueEditId)
				? actions.filter((item) => item.id !== queueEditId)
				: null,
		);
		if (!saved) return false;
		setQueueEditId(null);
		return true;
	}

	async function submit(): Promise<void> {
		const text = content.trim();
		if (text.length === 0 || text.length > CONTENT_MAX) {
			setError('Inhalt fehlt oder zu lang.');
			return;
		}
		if (submittingRef.current) return;
		// The edited queue entry may have been synced meanwhile; a new create would duplicate it.
		if (queueEditId && !isOfflineActionQueued(queueEditId)) {
			setQueueEditId(null);
			setContent('');
			setKind('info');
			setImageUrl(null);
			setComposerOpen(false);
			removeDraft(draftKey);
			setError(null);
			setNotice(QUEUE_EDIT_ALREADY_SENT_MESSAGE);
			void load();
			return;
		}
		// Race guard: if the image is still a local pending-image-token (upload
		// hasn't resolved to the S3 URL yet), do NOT post. Server's imageUrlSchema
		// would reject the token as image_invalid, the user would see a generic
		// error, and the draft state stays — they'd be stuck retrying. Online
		// path needs the public URL; offline path is fine (sync resolves later).
		if (imageUrl && isPendingImageToken(imageUrl) && navigator.onLine) {
			setError('Bild wird noch hochgeladen. Bitte kurz warten und nochmal versuchen.');
			return;
		}
		if (submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		setError(null);
		setNotice(null);
		const fingerprint = JSON.stringify({ text, imageUrl, kind });
		const pendingRequest = announcementIdempotencyKeyRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setError('Beitrag konnte nicht sicher gesendet werden. Versuche es erneut.');
			setSubmitting(false);
			submittingRef.current = false;
			return;
		}
		announcementIdempotencyKeyRef.current = { fingerprint, key: idempotencyKey };
		try {
			const res = await apiFetch<AnnouncementWriteResponse>(
				`/api/wg/${encodedShareCode}/announcements`,
				{
					method: 'POST',
					memberId: identity.memberId,
					headers: { 'Idempotency-Key': idempotencyKey },
					body: JSON.stringify({
						content: text,
						imageUrl,
						kind,
					}),
				},
			);
			if (!res.ok) {
				if (res.status > 0 && res.status < 500 && res.status !== 429)
					announcementIdempotencyKeyRef.current = null;
				if (res.status === 0) {
					const queued = createQueuedAnnouncement({
						wgId: wg.id,
						shareCode: wg.shareCode,
						memberId: identity.memberId,
						idempotencyKey,
						content: text,
						kind,
						imageUrl,
					});
					if ((await enqueueOfflineAction(queued)) === 0) {
						setError(OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE);
						return;
					}
					announcementIdempotencyKeyRef.current = null;
					refreshCount();
					if (!(await clearEditedQueueItem())) {
						setError(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
						return;
					}
					setContent('');
					setKind('info');
					setImageUrl(null);
					setComposerOpen(false);
					removeDraft(draftKey);
					setNotice(OFFLINE_SAVED_NOTICE);
					return;
				}
				setError(announcementCreateErrorMessage(res.error));
				return;
			}
			const createdAnnouncementId = res.data.announcement.id;
			announcementIdempotencyKeyRef.current = null;
			setContent('');
			setKind('info');
			setImageUrl(null);
			if (!(await clearEditedQueueItem())) {
				setError(DRAFT_CLEANUP_FAILED_MESSAGE);
				return;
			}
			removeDraft(draftKey);
			setComposerOpen(false);
			const warningMessage = notificationWarningMessage(res.data.warning);
			if (warningMessage) toast.info(warningMessage);
			else toast.success('Beitrag veröffentlicht.');
			void load().then(() => scrollToAnnouncement(createdAnnouncementId));
		} finally {
			submittingRef.current = false;
			setSubmitting(false);
		}
	}

	return {
		open: composerOpen,
		setOpen: setComposerOpen,
		buttonRef: createButtonRef,
		textareaRef,
		submitting,
		hasDraft,
		kind,
		setKind,
		content,
		setContent,
		imageUrl,
		setImageUrl,
		error,
		close: closeComposer,
		submit,
	};
}
