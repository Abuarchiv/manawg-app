'use client';
import { useToast } from '@/components/ui/Toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { OfflineQueueNotice } from '@/components/wg/OfflineQueueNotice';
import { SubNav } from '@/components/wg/SubNav';
import { ThumbAction } from '@/components/wg/ThumbAction';
import { useWg } from '@/components/wg/WgContextProvider';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { usePendingSet } from '@/core/hooks/usePendingSet';
import { apiFetch } from '@/core/infra/api-client';
import { captureException } from '@/core/infra/observability';
import { buildDraftKey, readDraft, removeDraft, writeDraft } from '@/core/offline/drafts';
import {
	enqueueOfflineAction,
	isOfflineActionQueued,
	readOfflineQueue,
	syncOfflineActions,
	writeOfflineQueue,
} from '@/core/offline/offline-client';
import {
	DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE,
	QUEUE_EDIT_ALREADY_SENT_MESSAGE,
} from '@/core/offline/offline-copy';
import { isPendingImageToken } from '@/core/offline/offline-images';
import {
	createOfflineIdempotencyKey,
	createQueuedAnnouncement,
} from '@/core/offline/offline-queue';
import { useOfflineQueueSync } from '@/core/offline/useOfflineQueueSync';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import {
	announcementActionErrorMessage,
	announcementCreateErrorMessage,
	commentActionErrorMessage,
} from '@/features/pinnwand/announcement-errors';
import {
	getAnnouncementHash,
	getMyOpenAnnouncements,
	isAnnouncementArchived,
	mergeBackgroundAnnouncements,
	reconcilePendingAnnouncements,
} from '@/features/pinnwand/announcement-workflow';
import { AnnouncementCard } from '@/features/pinnwand/components/AnnouncementCard';
import { AnnouncementSkeleton } from '@/features/pinnwand/components/AnnouncementSkeleton';
import { EmptyState } from '@/features/pinnwand/components/EmptyState';
import { MyOpenAnnouncements } from '@/features/pinnwand/components/MyOpenAnnouncements';
import { PinnwandComposer } from '@/features/pinnwand/components/PinnwandComposer';
import type {
	Announcement,
	AnnouncementComment,
	AnnouncementKind,
	AnnouncementStatus,
	ReactionKey,
} from '@/features/pinnwand/components/announcement-types';
import { CONTENT_MAX, REFRESH_INTERVAL_MS } from '@/features/pinnwand/components/constants';
import { ChevronDown, Megaphone, Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

type CommentOverride = AnnouncementComment | null;

type NotificationWarning = null | 'notification_delivery_failed' | 'notification_delivery_unknown';

type AnnouncementCreateResponse = {
	announcement: Announcement;
	warning: NotificationWarning;
};

type AnnouncementPatchResponse = {
	announcement: Announcement;
	warning: NotificationWarning;
};

type AnnouncementReactionResponse = {
	reaction: ReactionKey;
	active: boolean;
	warning: NotificationWarning;
};

type AnnouncementCommentResponse = {
	comment: AnnouncementComment;
	warning: NotificationWarning;
};

function notificationWarningMessage(warning: NotificationWarning): string | null {
	if (warning === 'notification_delivery_failed') {
		return 'Gespeichert. Nicht alle Push-Benachrichtigungen konnten versendet werden.';
	}
	if (warning === 'notification_delivery_unknown') {
		return 'Gespeichert. Push-Versand konnte nicht bestätigt werden.';
	}
	return null;
}

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function PinnwandPage(): React.ReactElement {
	const { wg, members, identity, isAdmin } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const {
		data: cachedAnnouncements,
		serverData: remoteAnnouncements,
		serverRevision: announcementsServerRevision,
		error: announcementsReadError,
		refresh: refreshAnnouncements,
		setData: setCachedAnnouncements,
	} = useCachedFetch<{ announcements: Announcement[] }>(
		`/api/wg/${encodedShareCode}/announcements`,
		{ memberId: identity.memberId },
	);
	const processedAnnouncementsRevisionRef = useRef(announcementsServerRevision);
	const searchParams = useSearchParams();
	const prefillContent = searchParams.get('content');
	const prefillKind = kindFromParam(searchParams.get('kind'));
	const prefillImageUrl = searchParams.get('imageUrl');
	const [items, setItems] = useState<Announcement[]>(
		() => cachedAnnouncements?.announcements ?? [],
	);
	const [initialLoading, setInitialLoading] = useState(cachedAnnouncements === undefined);
	const isFirstLoad = useRef(cachedAnnouncements === undefined);
	const itemsRef = useRef<Announcement[]>(cachedAnnouncements?.announcements ?? []);
	const [content, setContent] = useState('');
	const [kind, setKind] = useState<AnnouncementKind>('info');
	const [imageUrl, setImageUrl] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);
	const announcementIdempotencyKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const commentIdempotencyKeysRef = useRef(new Map<string, string>());
	const reactionIdempotencyKeysRef = useRef(new Map<string, { active: boolean; key: string }>());
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [composerOpen, setComposerOpen] = useState(false);
	const [archiveOpen, setArchiveOpen] = useState(searchParams.get('status') === 'resolved');
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const [pendingRemoteItems, setPendingRemoteItems] = useState<Announcement[] | null>(null);
	const [newCount, setNewCount] = useState(0);
	const commentOverridesRef = useRef(new Map<string, Map<string, CommentOverride>>());
	const [queueEditId, setQueueEditId] = useState<string | null>(null);
	const [draftHydrated, setDraftHydrated] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const appliedPrefillRef = useRef<string | null>(null);
	const mountedRef = useRef(false);
	const loadRequestIdRef = useRef(0);
	const initialLoadStartedRef = useRef(false);
	const itemCount = items.length;
	const draftKey = buildDraftKey(wg.shareCode, identity.memberId, 'announcement');
	const prefillKey = `${prefillContent ?? ''}|${prefillKind ?? ''}|${prefillImageUrl ?? ''}`;
	const hasDraft = Boolean(content.trim() || imageUrl || queueEditId || kind !== 'info');

	const { isPending, start, end } = usePendingSet();

	const scrollToAnnouncement = useCallback((id: string, behavior: ScrollBehavior = 'smooth') => {
		setHighlightedId(id);
		window.setTimeout(() => {
			document.getElementById(`announcement-${id}`)?.scrollIntoView({
				block: 'center',
				behavior,
			});
		}, 80);
		window.setTimeout(() => setHighlightedId((current) => (current === id ? null : current)), 4500);
	}, []);

	useEffect(() => {
		itemsRef.current = items;
	}, [items]);

	useEffect(() => {
		if (announcementsReadError) {
			setLoadError(
				getWgLoadErrorMessage(
					'Pinnwand',
					announcementsReadError.status,
					announcementsReadError.error,
				),
			);
			setInitialLoading(false);
			isFirstLoad.current = false;
			return;
		}
		if (cachedAnnouncements) {
			const current = itemsRef.current;
			const incoming = cachedAnnouncements.announcements.map(applyCommentOverrides);
			const merged =
				current.length > 0 ? mergeBackgroundAnnouncements(current, incoming) : incoming;
			itemsRef.current = merged;
			setItems(merged);
			const pending = remoteAnnouncements
				? reconcilePendingAnnouncements(
						current,
						remoteAnnouncements.announcements,
						announcementsServerRevision,
						processedAnnouncementsRevisionRef.current,
					)
				: null;
			if (pending) {
				processedAnnouncementsRevisionRef.current = pending.serverRevision;
				setLoadError(null);
				if (current.length > 0) {
					setPendingRemoteItems(pending.items);
					setNewCount(pending.count);
				} else {
					setPendingRemoteItems(null);
					setNewCount(0);
				}
			}
			setInitialLoading(false);
			isFirstLoad.current = false;
		}
	}, [
		announcementsReadError,
		announcementsServerRevision,
		cachedAnnouncements,
		remoteAnnouncements,
	]);

	useEffect(() => {
		if (composerOpen) textareaRef.current?.focus();
	}, [composerOpen]);

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
	}, [composerOpen, content, imageUrl]);

	function closeComposer(): void {
		if (submittingRef.current) return;
		setComposerOpen(false);
		setError(null);
		setNotice(null);
	}

	const load = useCallback(
		async (mode: 'replace' | 'background' = 'replace'): Promise<void> => {
			const requestId = loadRequestIdRef.current + 1;
			loadRequestIdRef.current = requestId;
			if (!isFirstLoad.current) setRefreshing(true);
			const res = await refreshAnnouncements();
			if (requestId !== loadRequestIdRef.current) {
				if (isFirstLoad.current) {
					isFirstLoad.current = false;
					setInitialLoading(false);
				}
				setRefreshing(false);
				return;
			}

			if (res.ok) {
				setLoadError(null);
				syncOfflineActions(wg.shareCode, { memberId: identity.memberId })
					.then((synced) => {
						if (!mountedRef.current) return;
						if (requestId !== loadRequestIdRef.current) return;
						refreshCount();
						if (synced > 0) void load('replace');
					})
					.catch((err) =>
						captureException(err, { action: 'syncOfflineActions', page: 'pinnwand' }),
					);
				const currentItems = itemsRef.current;
				if (mode === 'background' && currentItems.length > 0) {
					commitItems(
						mergeBackgroundAnnouncements(currentItems, res.data.announcements).map(
							applyCommentOverrides,
						),
					);
					const pending = reconcilePendingAnnouncements(
						currentItems,
						res.serverData?.announcements ?? res.data.announcements,
						res.serverRevision,
						processedAnnouncementsRevisionRef.current,
					);
					if (pending) {
						processedAnnouncementsRevisionRef.current = pending.serverRevision;
						setPendingRemoteItems(pending.items);
						setNewCount(pending.count);
					}
				} else {
					processedAnnouncementsRevisionRef.current = Math.max(
						processedAnnouncementsRevisionRef.current,
						res.serverRevision,
					);
					commitItems(res.data.announcements.map(applyCommentOverrides));
					setPendingRemoteItems(null);
					setNewCount(0);
				}
			} else {
				setLoadError(getWgLoadErrorMessage('Pinnwand', res.status, res.error));
			}
			if (isFirstLoad.current) {
				isFirstLoad.current = false;
				setInitialLoading(false);
			}
			setRefreshing(false);
		},
		[identity.memberId, refreshAnnouncements, wg.shareCode],
	);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		if (initialLoadStartedRef.current) return;
		initialLoadStartedRef.current = true;
		void load();
	}, [load]);

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
	}, [prefillContent, prefillImageUrl, prefillKey, prefillKind]);

	useEffect(() => {
		if (!draftHydrated) return;
		writeDraft(draftKey, { content, kind, imageUrl, queueEditId });
	}, [content, draftHydrated, draftKey, imageUrl, kind, queueEditId]);

	const { queuedCount, refreshCount } = useOfflineQueueSync({
		shareCode: wg.shareCode,
		memberId: identity.memberId,
		page: 'pinnwand',
		onSynced: () => void load('replace'),
	});

	useEffect(() => {
		function applyHash(): void {
			const hash = window.location.hash;
			if (!hash.startsWith('#announcement-')) return;
			const id = decodeURIComponent(hash.slice('#announcement-'.length));
			if (id) scrollToAnnouncement(id, 'auto');
		}
		applyHash();
		window.addEventListener('hashchange', applyHash);
		return () => window.removeEventListener('hashchange', applyHash);
	}, [scrollToAnnouncement]);

	useVisibilityPausedInterval(() => void load('background'), REFRESH_INTERVAL_MS);

	useEffect(() => {
		if (!highlightedId || itemCount === 0) return;
		// Verlinkte Beiträge können im eingeklappten Archiv liegen.
		const target = itemsRef.current.find((item) => item.id === highlightedId);
		if (target && isAnnouncementArchived(target, Date.now())) setArchiveOpen(true);
		const timer = window.setTimeout(() => {
			document.getElementById(`announcement-${highlightedId}`)?.scrollIntoView({
				block: 'center',
				behavior: 'smooth',
			});
		}, 80);
		return () => window.clearTimeout(timer);
	}, [highlightedId, itemCount]);

	function applyPendingItems(): void {
		if (!pendingRemoteItems) return;
		commitItems(pendingRemoteItems.map(applyCommentOverrides));
		setPendingRemoteItems(null);
		setNewCount(0);
	}

	function memberLookup(id: string): { name: string; color: string | null } {
		const m = members.find((x) => x.id === id);
		return { name: m?.name ?? '?', color: m?.color ?? null };
	}

	function commitItems(nextItems: Announcement[]): void {
		itemsRef.current = nextItems;
		setItems(nextItems);
		setCachedAnnouncements({ announcements: nextItems });
	}

	function rememberCommentOverride(
		announcementId: string,
		commentId: string,
		comment: CommentOverride,
	): void {
		const overrides =
			commentOverridesRef.current.get(announcementId) ?? new Map<string, CommentOverride>();
		overrides.set(commentId, comment);
		commentOverridesRef.current.set(announcementId, overrides);
	}

	function forgetCommentOverride(announcementId: string, commentId: string): void {
		const overrides = commentOverridesRef.current.get(announcementId);
		if (!overrides) return;
		overrides.delete(commentId);
		if (overrides.size === 0) commentOverridesRef.current.delete(announcementId);
	}

	function applyCommentOverrides(item: Announcement): Announcement {
		const overrides = commentOverridesRef.current.get(item.id);
		if (!overrides || overrides.size === 0) return item;
		const remoteComments = new Map(item.comments.map((comment) => [comment.id, comment]));
		const comments = item.comments.flatMap((comment) => {
			if (!overrides.has(comment.id)) return [comment];
			const override = overrides.get(comment.id);
			if (override === null) return [];
			if (override && override.content === comment.content) {
				overrides.delete(comment.id);
				return [comment];
			}
			return override ? [override] : [comment];
		});
		for (const [commentId, override] of overrides) {
			if (override === null) {
				if (!remoteComments.has(commentId)) overrides.delete(commentId);
				continue;
			}
			if (!remoteComments.has(commentId)) comments.push(override);
		}
		if (overrides.size === 0) commentOverridesRef.current.delete(item.id);
		const unchanged =
			comments.length === item.comments.length &&
			comments.every((comment, index) => comment === item.comments[index]);
		return unchanged ? item : { ...item, comments };
	}

	function updateItem(id: string, updater: (item: Announcement) => Announcement): void {
		commitItems(itemsRef.current.map((item) => (item.id === id ? updater(item) : item)));
	}

	function clearEditedQueueItem(): boolean {
		if (!queueEditId) return true;
		const saved = writeOfflineQueue(readOfflineQueue().filter((item) => item.id !== queueEditId));
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
			const res = await apiFetch<AnnouncementCreateResponse>(
				`/api/wg/${encodedShareCode}/announcements`,
				{
					method: 'POST',
					memberId: identity.memberId,
					memberToken: identity.memberToken,
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
					if (enqueueOfflineAction(queued) === 0) {
						setError(OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE);
						return;
					}
					announcementIdempotencyKeyRef.current = null;
					refreshCount();
					if (!clearEditedQueueItem()) {
						setError(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
						return;
					}
					setContent('');
					setKind('info');
					setImageUrl(null);
					setComposerOpen(false);
					removeDraft(draftKey);
					setNotice('Offline gespeichert. Wird synchronisiert, sobald ihr wieder online seid.');
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
			if (!clearEditedQueueItem()) {
				setError(DRAFT_CLEANUP_FAILED_MESSAGE);
				return;
			}
			removeDraft(draftKey);
			setComposerOpen(false);
			const warningMessage = notificationWarningMessage(res.data.warning);
			if (warningMessage) setNotice(warningMessage);
			void load().then(() => scrollToAnnouncement(createdAnnouncementId));
		} finally {
			submittingRef.current = false;
			setSubmitting(false);
		}
	}

	async function patchAnnouncement(
		id: string,
		body: { pinned?: boolean; status?: AnnouncementStatus; kind?: AnnouncementKind },
		pendingKey: string,
		rollbackItems?: Announcement[],
	): Promise<void> {
		if (isPending(pendingKey)) return;
		start(pendingKey);
		setActionError(null);
		const res = await apiFetch<AnnouncementPatchResponse>(
			`/api/wg/${encodedShareCode}/announcements/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify(body),
			},
		);
		end(pendingKey);
		if (!res.ok) {
			if (res.status === 404 && res.error === 'announcement_not_found') {
				commitItems(itemsRef.current.filter((item) => item.id !== id));
				setActionError('Dieser Pinnwand-Beitrag existiert nicht mehr und wurde entfernt.');
			} else {
				if (rollbackItems) commitItems(rollbackItems);
				setActionError(announcementActionErrorMessage(res.error));
			}
			return;
		}
		const warningMessage = notificationWarningMessage(res.data.warning);
		if (warningMessage) setNotice(warningMessage);
		void load();
	}

	function togglePinned(announcement: Announcement): void {
		const pendingKey = `${announcement.id}:pin`;
		if (isPending(pendingKey)) return;
		const previousItems = itemsRef.current;
		updateItem(announcement.id, (item) => ({
			...item,
			pinnedAt: item.pinnedAt ? null : new Date().toISOString(),
		}));
		void patchAnnouncement(
			announcement.id,
			{ pinned: !announcement.pinnedAt },
			pendingKey,
			previousItems,
		);
	}

	function toggleStatus(announcement: Announcement): void {
		const pendingKey = `${announcement.id}:status`;
		if (isPending(pendingKey)) return;
		const nextStatus = announcement.status === 'resolved' ? 'open' : 'resolved';
		const previousItems = itemsRef.current;
		updateItem(announcement.id, (item) => ({
			...item,
			status: nextStatus,
			resolvedAt: nextStatus === 'resolved' ? new Date().toISOString() : null,
			resolvedByMemberId: nextStatus === 'resolved' ? identity.memberId : null,
		}));
		if (nextStatus === 'resolved') toast.success('Erledigt – liegt jetzt unter „Geklärt & älter“');
		void patchAnnouncement(announcement.id, { status: nextStatus }, pendingKey, previousItems);
	}

	async function toggleReaction(announcement: Announcement, reaction: ReactionKey): Promise<void> {
		const pendingKey = `${announcement.id}:reaction:${reaction}`;
		if (isPending(pendingKey)) return;
		const previousItems = itemsRef.current;
		const active = announcement.myReactions.includes(reaction);
		updateItem(announcement.id, (item) => ({
			...item,
			myReactions: active
				? item.myReactions.filter((current) => current !== reaction)
				: [...item.myReactions, reaction],
			reactionCounts: {
				...item.reactionCounts,
				[reaction]: Math.max(0, (item.reactionCounts[reaction] ?? 0) + (active ? -1 : 1)),
			},
			takers:
				reaction !== 'take'
					? item.takers
					: active
						? item.takers.filter((taker) => taker.memberId !== identity.memberId)
						: [
								...item.takers,
								{
									memberId: identity.memberId,
									name: identity.name,
									color: members.find((member) => member.id === identity.memberId)?.color ?? null,
								},
							],
		}));
		start(pendingKey);
		setActionError(null);
		const reactionRequestKey = `${announcement.id}:${reaction}`;
		const pendingReaction = reactionIdempotencyKeysRef.current.get(reactionRequestKey);
		const idempotencyKey =
			pendingReaction?.active === !active ? pendingReaction.key : createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			commitItems(previousItems);
			end(pendingKey);
			setActionError('Reaktion konnte nicht sicher gesendet werden. Versuche es erneut.');
			return;
		}
		reactionIdempotencyKeysRef.current.set(reactionRequestKey, {
			active: !active,
			key: idempotencyKey,
		});
		const res = await apiFetch<AnnouncementReactionResponse>(
			`/api/wg/${encodedShareCode}/announcements/${encodeURIComponent(announcement.id)}/reactions`,
			{
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ reaction, active: !active }),
			},
		);
		end(pendingKey);
		if (!res.ok) {
			if (res.status > 0 && res.status < 500 && res.status !== 429) {
				reactionIdempotencyKeysRef.current.delete(reactionRequestKey);
			}
			if (res.status === 404 && res.error === 'announcement_not_found') {
				commitItems(itemsRef.current.filter((item) => item.id !== announcement.id));
				setActionError('Dieser Pinnwand-Beitrag existiert nicht mehr und wurde entfernt.');
			} else if (res.status === 404 && res.error === 'reaction_not_found' && active) {
				setActionError('Diese Reaktion war schon entfernt. Die Pinnwand bleibt aktuell.');
			} else {
				commitItems(previousItems);
				setActionError(announcementActionErrorMessage(res.error));
			}
			return;
		}
		reactionIdempotencyKeysRef.current.delete(reactionRequestKey);
		const warningMessage = notificationWarningMessage(res.data.warning);
		if (warningMessage) setNotice(warningMessage);
		void load();
	}

	async function addComment(announcement: Announcement, content: string): Promise<boolean> {
		const pendingKey = `${announcement.id}:comment`;
		if (isPending(pendingKey)) return false;
		const previousItems = itemsRef.current;
		const optimisticComment: AnnouncementComment = {
			id: `temp-${Date.now()}`,
			announcementId: announcement.id,
			memberId: identity.memberId,
			content,
			createdAt: new Date().toISOString(),
			authorName: identity.name,
			authorColor: members.find((member) => member.id === identity.memberId)?.color ?? null,
		};
		rememberCommentOverride(announcement.id, optimisticComment.id, optimisticComment);
		updateItem(announcement.id, (item) => ({
			...item,
			comments: [...item.comments, optimisticComment],
		}));
		start(pendingKey);
		setActionError(null);
		const commentRequestKey = `${announcement.id}:${content}`;
		const idempotencyKey =
			commentIdempotencyKeysRef.current.get(commentRequestKey) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			end(pendingKey);
			setActionError('Kommentar konnte nicht sicher gesendet werden. Versuche es erneut.');
			return false;
		}
		commentIdempotencyKeysRef.current.set(commentRequestKey, idempotencyKey);
		const res = await apiFetch<AnnouncementCommentResponse>(
			`/api/wg/${encodedShareCode}/announcements/${encodeURIComponent(announcement.id)}/comments`,
			{
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ content }),
			},
		);
		end(pendingKey);
		if (!res.ok) {
			if (res.status > 0 && res.status < 500 && res.status !== 429) {
				commentIdempotencyKeysRef.current.delete(commentRequestKey);
			}
			if (res.status === 404 && res.error === 'announcement_not_found') {
				commentOverridesRef.current.delete(announcement.id);
				commitItems(itemsRef.current.filter((item) => item.id !== announcement.id));
				setActionError('Dieser Pinnwand-Beitrag existiert nicht mehr und wurde entfernt.');
			} else {
				forgetCommentOverride(announcement.id, optimisticComment.id);
				commitItems(previousItems);
				setActionError(commentActionErrorMessage(res.error));
			}
			return false;
		}
		commentIdempotencyKeysRef.current.delete(commentRequestKey);
		forgetCommentOverride(announcement.id, optimisticComment.id);
		const confirmedComment = { ...optimisticComment, ...res.data.comment };
		rememberCommentOverride(announcement.id, confirmedComment.id, confirmedComment);
		updateItem(announcement.id, (item) => ({
			...item,
			comments: item.comments.map((comment) =>
				comment.id === optimisticComment.id ? confirmedComment : comment,
			),
		}));
		const warningMessage = notificationWarningMessage(res.data.warning);
		if (warningMessage) setNotice(warningMessage);
		void load('background');
		return true;
	}

	async function updateComment(
		announcement: Announcement,
		commentId: string,
		content: string,
	): Promise<boolean> {
		const pendingKey = `${commentId}:comment-edit`;
		if (isPending(pendingKey)) return false;
		const previousItems = itemsRef.current;
		const previousComment = announcement.comments.find((comment) => comment.id === commentId);
		if (previousComment) {
			rememberCommentOverride(announcement.id, commentId, { ...previousComment, content });
		}
		updateItem(announcement.id, (item) => ({
			...item,
			comments: item.comments.map((comment) =>
				comment.id === commentId ? { ...comment, content } : comment,
			),
		}));
		start(pendingKey);
		setActionError(null);
		const res = await apiFetch<{ comment: AnnouncementComment }>(
			`/api/wg/${encodedShareCode}/announcements/${encodeURIComponent(announcement.id)}/comments/${encodeURIComponent(commentId)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify({ content }),
			},
		);
		end(pendingKey);
		if (!res.ok) {
			if (res.status === 404 && res.error === 'comment_not_found') {
				forgetCommentOverride(announcement.id, commentId);
				updateItem(announcement.id, (item) => ({
					...item,
					comments: item.comments.filter((comment) => comment.id !== commentId),
				}));
				setActionError('Dieser Kommentar existiert nicht mehr und wurde entfernt.');
				return true;
			}
			forgetCommentOverride(announcement.id, commentId);
			commitItems(previousItems);
			setActionError(commentActionErrorMessage(res.error));
			return false;
		}
		const confirmedComment = { ...previousComment, ...res.data.comment };
		rememberCommentOverride(announcement.id, confirmedComment.id, confirmedComment);
		updateItem(announcement.id, (item) => ({
			...item,
			comments: item.comments.map((comment) =>
				comment.id === commentId ? confirmedComment : comment,
			),
		}));
		void load('background');
		return true;
	}

	async function deleteComment(announcement: Announcement, commentId: string): Promise<boolean> {
		const pendingKey = `${commentId}:comment-delete`;
		if (isPending(pendingKey)) return false;
		const previousItems = itemsRef.current;
		rememberCommentOverride(announcement.id, commentId, null);
		updateItem(announcement.id, (item) => ({
			...item,
			comments: item.comments.filter((comment) => comment.id !== commentId),
		}));
		start(pendingKey);
		setActionError(null);
		const res = await apiFetch<Record<string, never>>(
			`/api/wg/${encodedShareCode}/announcements/${encodeURIComponent(announcement.id)}/comments/${encodeURIComponent(commentId)}`,
			{
				method: 'DELETE',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
			},
		);
		end(pendingKey);
		if (!res.ok) {
			if (res.status === 404 && res.error === 'comment_not_found') {
				setActionError('Dieser Kommentar existiert nicht mehr und wurde entfernt.');
			} else {
				forgetCommentOverride(announcement.id, commentId);
				commitItems(previousItems);
				setActionError(commentActionErrorMessage(res.error));
			}
			return false;
		}
		void load('background');
		return true;
	}

	async function remove(id: string): Promise<boolean> {
		if (isPending(id)) return false;
		start(id);
		setActionError(null);
		const res = await apiFetch<Record<string, never>>(
			`/api/wg/${encodedShareCode}/announcements/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
			},
		);
		end(id);
		if (!res.ok) {
			if (res.status === 404 && res.error === 'announcement_not_found') {
				commitItems(itemsRef.current.filter((item) => item.id !== id));
				setActionError('Dieser Pinnwand-Beitrag existiert nicht mehr und wurde entfernt.');
			} else {
				const msg =
					res.status === 403
						? 'Nur Autor:in oder WG-Admin können diesen Beitrag entfernen.'
						: announcementActionErrorMessage(res.error);
				setActionError(msg);
			}
			return false;
		}
		commitItems(itemsRef.current.filter((item) => item.id !== id));
		void load();
		return true;
	}

	const showSkeleton = initialLoading && items.length === 0;
	const { openItems, archivedItems } = useMemo(() => {
		const now = Date.now();
		const openItems: Announcement[] = [];
		const archivedItems: Announcement[] = [];
		for (const item of items) {
			(isAnnouncementArchived(item, now) ? archivedItems : openItems).push(item);
		}
		return { openItems, archivedItems };
	}, [items]);
	const myOpenItems = useMemo(() => getMyOpenAnnouncements(items), [items]);

	function renderCard(a: Announcement): React.ReactElement {
		return (
			<AnnouncementCard
				key={`${identity.memberId}:${a.id}`}
				announcement={a}
				author={memberLookup(a.authorMemberId)}
				deletePending={isPending(a.id)}
				pinPending={isPending(`${a.id}:pin`)}
				statusPending={isPending(`${a.id}:status`)}
				reactionPending={(reaction) => isPending(`${a.id}:reaction:${reaction}`)}
				onDelete={() => remove(a.id)}
				onTogglePinned={() => togglePinned(a)}
				onToggleStatus={() => toggleStatus(a)}
				onToggleReaction={(reaction) => {
					void toggleReaction(a, reaction);
				}}
				onAddComment={(content) => addComment(a, content)}
				onUpdateComment={(commentId, content) => updateComment(a, commentId, content)}
				onDeleteComment={(commentId) => deleteComment(a, commentId)}
				currentMemberId={identity.memberId}
				isAdmin={isAdmin}
				shareCode={wg.shareCode}
				highlighted={highlightedId === a.id}
			/>
		);
	}

	return (
		<div data-exchange-content className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4">
			<SubNav />
			<h1 className="sr-only">Pinnwand</h1>

			{newCount > 0 && (
				<Button
					type="button"
					onClick={applyPendingItems}
					variant="secondary"
					className="w-full"
					aria-live="polite"
				>
					{newCount} neue Beitr{newCount === 1 ? 'ag' : 'äge'}
				</Button>
			)}
			<OfflineQueueNotice queuedCount={queuedCount} />
			{loadError && (
				<LoadErrorBanner
					message={loadError}
					onRetry={() => void load()}
					busy={refreshing}
					retryLabel="Pinnwand erneut laden"
				/>
			)}
			{myOpenItems.length > 0 && (
				<MyOpenAnnouncements
					items={myOpenItems}
					onSelect={(id) => {
						window.history.replaceState(window.history.state, '', getAnnouncementHash(id));
						scrollToAnnouncement(id);
					}}
				/>
			)}

			{composerOpen && (
				<PinnwandComposer
					authorName={identity.name}
					submitting={submitting}
					kind={kind}
					onKindChange={setKind}
					content={content}
					onContentChange={setContent}
					textareaRef={textareaRef}
					imageUrl={imageUrl}
					onImageUrlChange={setImageUrl}
					shareCode={wg.shareCode}
					error={error}
					onClose={closeComposer}
					onSubmit={submit}
				/>
			)}

			{notice && (
				<Alert aria-live="polite">
					<AlertDescription>{notice}</AlertDescription>
				</Alert>
			)}

			{actionError && (
				<Alert variant="destructive">
					<AlertDescription>{actionError}</AlertDescription>
				</Alert>
			)}

			{showSkeleton ? (
				<AnnouncementSkeleton />
			) : loadError && items.length === 0 ? (
				<EmptyState
					icon={Megaphone}
					hint="Versuche es erneut, sobald die Verbindung wieder da ist."
				>
					Noch keine Beiträge geladen.
				</EmptyState>
			) : items.length === 0 ? (
				<EmptyState icon={Megaphone} hint="Teile eine Frage oder Info über das Plus unten rechts.">
					Noch keine Beiträge
				</EmptyState>
			) : (
				<>
					{openItems.length === 0 ? (
						<EmptyState icon={Megaphone} hint="Geklärtes und ältere Infos liegen unten.">
							Nichts Offenes
						</EmptyState>
					) : (
						<ul
							className="flex flex-col divide-y overflow-hidden rounded-xl border"
							aria-label="Pinnwand-Beiträge"
						>
							{openItems.map(renderCard)}
						</ul>
					)}
					{archivedItems.length > 0 && (
						<Collapsible open={archiveOpen} onOpenChange={setArchiveOpen}>
							<CollapsibleTrigger
								render={
									<Button
										variant="ghost"
										className="group min-h-11 w-full justify-between px-1 text-muted-foreground"
									/>
								}
							>
								Geklärt & älter ({archivedItems.length})
								<ChevronDown
									aria-hidden
									className="size-4 shrink-0 group-aria-expanded:rotate-180"
								/>
							</CollapsibleTrigger>
							{/* Verlinkte Archiv-Beiträge müssen per Hash auffindbar bleiben. */}
							<CollapsibleContent keepMounted>
								<ul
									className="flex flex-col divide-y overflow-hidden rounded-xl border"
									aria-label="Geklärte und ältere Beiträge"
								>
									{archivedItems.map(renderCard)}
								</ul>
							</CollapsibleContent>
						</Collapsible>
					)}
				</>
			)}
			{/* Offenes Formular hat eigenes Schließen (X) und Posten. */}
			{!composerOpen && (
				<ThumbAction>
					<Button
						type="button"
						className="min-h-11 w-full"
						disabled={submitting || initialLoading}
						onClick={() => {
							setComposerOpen(true);
							setNotice(null);
						}}
					>
						<Plus data-icon="inline-start" aria-hidden />
						{hasDraft ? 'Entwurf fortsetzen' : 'Beitrag erstellen'}
					</Button>
				</ThumbAction>
			)}
		</div>
	);
}
