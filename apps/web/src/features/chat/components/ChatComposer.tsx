'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { readDraft, removeDraft, writeDraft } from '@/core/offline/drafts';
import { isPendingImageToken } from '@/core/offline/offline-images';
import { haptic } from '@/shared/lib/haptics';
import { Send, X } from 'lucide-react';
import {
	type ChangeEvent,
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { type MentionTrigger, detectMention, findMentions } from '../chat-text';
import { ComposerImageButton, ComposerImagePanel } from './ComposerImage';
import {
	MentionAutocomplete,
	type MentionMember,
	filterMentionMembers,
	mentionOptionId,
} from './MentionAutocomplete';

const BODY_MAX = 4000;

interface ChatComposerProps {
	shareCode: string;
	draftKey: string;
	error: string | null;
	members: MentionMember[];
	currentMemberId: string;
	replyToMessageId: string | null;
	replyFocusRequest?: number;
	replyToPreview: string | null;
	replyToSenderName: string | null;
	onClearReply: () => void;
	onRestoreReply: (id: string | null) => void;
	onSend: (input: {
		body: string;
		mentionMemberIds: string[];
		replyToMessageId: string | null;
		imageUrl?: string;
	}) => Promise<boolean>;
}

export function ChatComposer({
	shareCode,
	draftKey,
	error,
	members,
	currentMemberId,
	replyToMessageId,
	replyFocusRequest = 0,
	replyToPreview,
	replyToSenderName,
	onClearReply,
	onRestoreReply,
	onSend,
}: ChatComposerProps) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const draftRef = useRef('');
	const replyToMessageIdRef = useRef(replyToMessageId);
	const handledReplyFocusRequestRef = useRef(0);
	replyToMessageIdRef.current = replyToMessageId;
	const [draft, setDraft] = useState('');
	const [pending, setPending] = useState(false);
	// The image is deliberately not part of the stored draft: it only lives until sent or removed.
	const [imageUrl, setImageUrl] = useState<string | null>(null);
	const imageUrlRef = useRef(imageUrl);
	const [imageOpen, setImageOpen] = useState(false);
	const [imageError, setImageError] = useState<string | null>(null);
	const pendingRef = useRef(false);
	const [draftHydrated, setDraftHydrated] = useState(false);
	const [draftStorageFailed, setDraftStorageFailed] = useState(false);
	const [mention, setMention] = useState<MentionTrigger | null>(null);
	const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
	const mentionListboxId = 'mention-listbox';
	const visibleMembers = useMemo(
		() => members.filter((m) => m.id !== currentMemberId),
		[members, currentMemberId],
	);

	const mentionItems = useMemo(
		() => (mention === null ? [] : filterMentionMembers(visibleMembers, mention.query)),
		[mention, visibleMembers],
	);
	const mentionOpen = mentionItems.length > 0;
	const activeOptionId = mentionOpen
		? mentionOptionId(mentionListboxId, mentionActiveIndex)
		: undefined;
	useEffect(() => {
		const saved = readDraft<{ body?: string; replyToMessageId?: string }>(draftKey);
		const restoredDraft = typeof saved?.body === 'string' ? saved.body.slice(0, BODY_MAX) : '';
		draftRef.current = restoredDraft;
		setDraft(restoredDraft);
		onRestoreReply(typeof saved?.replyToMessageId === 'string' ? saved.replyToMessageId : null);
		setDraftHydrated(true);
	}, [draftKey, onRestoreReply]);

	useEffect(() => {
		if (
			replyFocusRequest === 0 ||
			!draftHydrated ||
			handledReplyFocusRequestRef.current === replyFocusRequest
		)
			return;
		const textarea = textareaRef.current;
		if (!textarea) return;
		handledReplyFocusRequestRef.current = replyFocusRequest;
		textarea.focus({ preventScroll: true });
		const cursor = textarea.value.length;
		textarea.setSelectionRange(cursor, cursor);
	}, [draftHydrated, replyFocusRequest]);

	useEffect(() => {
		if (!draftHydrated) return;
		if (!draft && !replyToMessageId) {
			removeDraft(draftKey);
			setDraftStorageFailed(false);
			return;
		}
		setDraftStorageFailed(!writeDraft(draftKey, { body: draft, replyToMessageId }));
	}, [draft, draftHydrated, draftKey, replyToMessageId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mentionItems identity change is the correct trigger
	useEffect(() => {
		setMentionActiveIndex(0);
	}, [mentionItems]);

	function handleChange(e: ChangeEvent<HTMLTextAreaElement>): void {
		const value = e.target.value;
		draftRef.current = value;
		setDraft(value);
		const cursor = e.target.selectionStart ?? value.length;
		setMention(detectMention(value, cursor));
	}

	function insertMention(member: MentionMember): void {
		if (pendingRef.current || !mention || !textareaRef.current) return;
		const value = textareaRef.current.value;
		const before = value.slice(0, mention.startIndex);
		const after = value.slice(mention.startIndex + 1 + mention.query.length);
		const insertion = `@${member.name} `;
		const next = `${before}${insertion}${after}`;
		if (next.length > BODY_MAX) return;
		draftRef.current = next;
		setDraft(next);
		setMention(null);
		const nextCursor = before.length + insertion.length;
		queueMicrotask(() => {
			const el = textareaRef.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(nextCursor, nextCursor);
		});
	}

	function changeImage(url: string | null): void {
		imageUrlRef.current = url;
		setImageUrl(url);
		setImageError(null);
	}
	async function submit(): Promise<void> {
		const outgoingDraft = draftRef.current;
		const outgoingReplyToMessageId = replyToMessageIdRef.current;
		const outgoingImageUrl = imageUrlRef.current;
		const text = outgoingDraft.trim();
		if ((text.length === 0 && !outgoingImageUrl) || text.length > BODY_MAX || pendingRef.current)
			return;
		// Offline or still uploading: the server would reject the local token as image_invalid.
		if (outgoingImageUrl && isPendingImageToken(outgoingImageUrl)) {
			setImageError('Bild wird noch hochgeladen. Bitte kurz warten und nochmal versuchen.');
			return;
		}
		pendingRef.current = true;
		haptic('selection');
		setPending(true);
		// Same matcher as the display (longest name first), over all names so that the sender's own
		// "Anna Lena" cannot turn into a mention of member "Anna".
		const matchedNames = new Set(
			findMentions(
				text,
				members.map((m) => m.name),
			).map((match) => match.name),
		);
		const mentionedIds = visibleMembers.filter((m) => matchedNames.has(m.name)).map((m) => m.id);
		try {
			const ok = await onSend({
				body: text,
				mentionMemberIds: mentionedIds,
				replyToMessageId: outgoingReplyToMessageId,
				...(outgoingImageUrl ? { imageUrl: outgoingImageUrl } : {}),
			});
			if (ok) {
				haptic('medium');
				// A user may continue composing while the request is in flight. Only
				// clear the draft/reply that produced this request.
				if (draftRef.current === outgoingDraft) {
					draftRef.current = '';
					setDraft('');
					setMention(null);
				}
				if (imageUrlRef.current === outgoingImageUrl) {
					changeImage(null);
					setImageOpen(false);
				}
				if (replyToMessageIdRef.current === outgoingReplyToMessageId) {
					onClearReply();
				}
			}
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	}

	function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
		if (e.nativeEvent.isComposing) return;
		if (mentionOpen) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setMentionActiveIndex((current) => (current + 1) % mentionItems.length);
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setMentionActiveIndex((current) => (current === 0 ? mentionItems.length - 1 : current - 1));
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				const target = mentionItems[mentionActiveIndex];
				if (target) insertMention(target);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setMention(null);
				return;
			}
		}
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void submit();
		}
	}

	// Toasts read --thumb-action-space so they stack above the composer instead of covering it.
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const doc = document.documentElement;
		const sync = () =>
			doc.style.setProperty('--thumb-action-space', `${root.getBoundingClientRect().height + 8}px`);
		sync();
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
		observer?.observe(root);
		return () => {
			observer?.disconnect();
			doc.style.removeProperty('--thumb-action-space');
		};
	}, []);

	return (
		<div
			ref={rootRef}
			className="relative shrink-0 border-t border-border bg-background"
			aria-busy={pending}
		>
			{/* Hints scroll internally so the history stays visible at large font sizes. */}
			<div className="max-h-[25dvh] overflow-y-auto">
				{replyToMessageId && (
					<div className="flex items-start gap-2 border-b border-border bg-muted px-3 py-2 text-xs">
						<div className="min-w-0 flex-1">
							<div className="font-medium text-foreground">
								Antwort an {replyToSenderName ?? 'Unbekannt'}
							</div>
							<div className="truncate text-muted-foreground">{replyToPreview ?? '…'}</div>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={onClearReply}
							disabled={pending}
							aria-label="Antwort abbrechen"
						>
							<X aria-hidden />
						</Button>
					</div>
				)}
				{(imageOpen || imageUrl) && (
					<ComposerImagePanel
						shareCode={shareCode}
						value={imageUrl}
						onChange={changeImage}
						disabled={pending}
					/>
				)}
				{imageError && (
					<Alert variant="destructive">
						<AlertDescription>{imageError}</AlertDescription>
					</Alert>
				)}
				{error && (
					<Alert variant="destructive">
						<AlertDescription>
							{error}{' '}
							{imageUrl ? 'Dein Text und dein Bild sind noch da.' : 'Dein Text ist noch da.'}
						</AlertDescription>
					</Alert>
				)}
				{draftStorageFailed && (
					<Alert>
						<AlertDescription>
							Der Entwurf kann auf diesem Gerät nicht gespeichert werden. Lass den Chat bis zum
							Senden geöffnet.
						</AlertDescription>
					</Alert>
				)}
			</div>
			<MentionAutocomplete
				listboxId={mentionListboxId}
				items={mentionItems}
				activeIndex={mentionActiveIndex}
				onSelect={insertMention}
				onHoverIndex={setMentionActiveIndex}
			/>
			<div className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 py-2">
				{/* Pill shape with a round send button, as in common messengers. */}
				<InputGroup className="h-auto items-end rounded-3xl">
					{/* Before the textarea in the DOM so tab order matches the visual order (order-first). */}
					<ComposerImageButton
						disabled={pending || !draftHydrated}
						expanded={imageOpen || Boolean(imageUrl)}
						onToggle={() => setImageOpen((open) => !open)}
					/>
					<InputGroupTextarea
						ref={textareaRef}
						value={draft}
						disabled={!draftHydrated}
						onChange={handleChange}
						onKeyDown={onKey}
						placeholder="Nachricht schreiben"
						maxLength={BODY_MAX}
						rows={1}
						aria-label="Chat-Nachricht"
						aria-autocomplete="list"
						aria-controls={mentionOpen ? mentionListboxId : undefined}
						aria-activedescendant={activeOptionId}
						className="max-h-[min(8rem,20dvh)] min-h-11 flex-1 px-4 py-2 text-base"
					/>
					<InputGroupAddon align="inline-end" className="py-1 pe-1">
						<InputGroupButton
							type="button"
							variant="default"
							size="icon-sm"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => void submit()}
							disabled={pending || !draftHydrated || (draft.trim().length === 0 && !imageUrl)}
							aria-label="Nachricht senden"
							className="size-8 shrink-0 rounded-full"
						>
							{pending ? <Spinner aria-hidden /> : <Send aria-hidden />}
						</InputGroupButton>
					</InputGroupAddon>
				</InputGroup>
			</div>
			{/* Screen readers only: a visible line would make the composer taller and shift the list. */}
			{pending && <output className="sr-only">Nachricht wird gesendet…</output>}
		</div>
	);
}
