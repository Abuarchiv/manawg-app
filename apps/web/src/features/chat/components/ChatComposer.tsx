'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { readDraft, removeDraft, writeDraft } from '@/core/offline/drafts';
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
import { type MentionTrigger, detectMention, escapeRegExp } from '../chat-pure';
import {
	MentionAutocomplete,
	type MentionMember,
	filterMentionMembers,
	mentionOptionId,
} from './MentionAutocomplete';

const BODY_MAX = 4000;

interface ChatComposerProps {
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
	}) => Promise<boolean>;
}

export function ChatComposer({
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

	async function submit(): Promise<void> {
		const outgoingDraft = draftRef.current;
		const outgoingReplyToMessageId = replyToMessageIdRef.current;
		const text = outgoingDraft.trim();
		if (text.length === 0 || text.length > BODY_MAX || pendingRef.current) return;
		pendingRef.current = true;
		haptic('selection');
		setPending(true);
		// Trailing `\b` misses names ending in a diacritic (e.g. "René"): `\b` only
		// matches at a word/non-word transition, and JS regex `\w` is ASCII-only, so
		// a non-ASCII trailing letter followed by a space/end never satisfies it.
		// A negative lookahead against `\p{L}\p{N}_-` (any Unicode letter/digit, not
		// just the enumerated German charset) avoids matching a longer name that
		// merely starts with this one — e.g. "@René" must not also match member "Ren".
		const mentionedIds = visibleMembers
			.filter((m) => new RegExp(`@${escapeRegExp(m.name)}(?![\\p{L}\\p{N}_-])`, 'u').test(text))
			.map((m) => m.id);
		try {
			const ok = await onSend({
				body: text,
				mentionMemberIds: mentionedIds,
				replyToMessageId: outgoingReplyToMessageId,
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
			data-chat-composer
			className="relative shrink-0 bg-[#f0f2f5] dark:bg-[#202c33]"
			aria-busy={pending}
		>
			{/* Hints scroll internally so the history stays visible at large font sizes. */}
			<div className="max-h-[25dvh] overflow-y-auto">
				{replyToMessageId && (
					<div className="mx-3 mt-2 flex items-start gap-2 rounded-lg border-s-4 border-[#06cf9c] bg-white py-1.5 ps-2.5 pe-1 text-xs dark:bg-[#1d282f]">
						<div className="min-w-0 flex-1">
							<div className="font-medium text-[#008069] dark:text-[#06cf9c]">
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
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{error} Dein Text ist noch da.</AlertDescription>
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
			<div className="mx-auto flex w-full max-w-3xl items-end gap-2 px-3 py-2">
				{/* WhatsApp layout: white pill field, round green send button next to it. */}
				<InputGroup className="h-auto items-end rounded-3xl border-[#8696a0]/60 bg-white dark:bg-[#2a3942]">
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
				</InputGroup>
				<Button
					type="button"
					size="icon"
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => void submit()}
					disabled={pending || !draftHydrated || draft.trim().length === 0}
					aria-label="Nachricht senden"
					className="size-11 shrink-0 rounded-full bg-[#008069] text-white hover:bg-[#006e5a] active:bg-[#006e5a] disabled:bg-[#008069]/50 disabled:text-white dark:bg-[#00a884] dark:text-[#111b21] dark:hover:bg-[#06cf9c] dark:active:bg-[#06cf9c] dark:disabled:text-[#111b21]"
				>
					{pending ? <Spinner aria-hidden /> : <Send aria-hidden />}
				</Button>
			</div>
			{/* Screen readers only: a visible line would make the composer taller and shift the list. */}
			{pending && <output className="sr-only">Nachricht wird gesendet…</output>}
		</div>
	);
}
