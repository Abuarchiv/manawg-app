import { SubNav } from '@/components/wg/SubNav';
import { db, type wgChatMessages, wgs } from '@/core/db';
import { getE2EWgFixture, isE2EDbDownMode } from '@/core/infra/e2e-db-down';
import { ChatView } from '@/features/chat/components/ChatView';
import { isValidShareCode, normalizeShareCode } from '@/shared/lib/share-code';
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

interface PageProps {
	params: Promise<{ code: string }>;
}

type MessageRow = typeof wgChatMessages.$inferSelect;
type ReactionRow = { messageId: string; memberId: string; emoji: string };

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
	title: 'Chat — ManaWG',
	robots: { index: false, follow: false },
};

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default async function ChatPage({ params }: PageProps) {
	const { code: rawCode } = await params;
	const code = normalizeShareCode(rawCode);
	if (!isValidShareCode(code)) notFound();

	if (isE2EDbDownMode()) {
		const fixture = getE2EWgFixture(code);
		if (!fixture) notFound();
		return <ChatPageContent wgRow={fixture} messages={buildE2EChatMessages(fixture.id)} />;
	}

	const wg = await db
		.select({ id: wgs.id, name: wgs.name, shareCode: wgs.shareCode })
		.from(wgs)
		.where(eq(wgs.shareCode, code))
		.limit(1);
	const wgRow = wg[0];
	if (!wgRow) notFound();

	// SECURITY: no server-side message loading here. The RSC has no member
	// identity (headers are only sent by apiFetch), so anything loaded here
	// would leak chat history to anyone holding the share code. ChatView
	// bootstraps its first page through the membership-gated API instead.
	return <ChatPageContent wgRow={wgRow} messages={[]} />;
}

function buildE2EChatMessages(wgId: string): MessageRow[] {
	const now = Date.now();
	return [
		{
			id: '1c2c9254-5945-4774-9f03-d12e772d3a6f',
			wgId,
			senderMemberId: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55',
			kind: 'text',
			body: 'Das ist eine ziemlich lange Chat-Nachricht mit einem_sehr_langen_ununterbrochenen_Wort_das_trotzdem_nicht_die_mobile_Ansicht_sprengen_darf.',
			imageUrl: null,
			replyToMessageId: null,
			systemKind: null,
			systemPayload: null,
			createdAt: new Date(now - 120_000),
			editedAt: null,
			deletedAt: null,
		},
		{
			id: '8c1bb4a9-4722-42fe-bb86-aebf2e2d5b11',
			wgId,
			senderMemberId: '7d898f9e-5ad7-4f5d-abed-8c3e99a76973',
			kind: 'text',
			body: 'Alles klar, ich bringe Hafermilch mit.',
			imageUrl: null,
			replyToMessageId: '1c2c9254-5945-4774-9f03-d12e772d3a6f',
			systemKind: null,
			systemPayload: null,
			createdAt: new Date(now - 60_000),
			editedAt: null,
			deletedAt: null,
		},
	] as MessageRow[];
}

function ChatPageContent({
	wgRow,
	messages,
	reactions = [],
}: {
	wgRow: { id: string; name: string; shareCode: string };
	messages: MessageRow[];
	reactions?: ReactionRow[];
}) {
	return (
		<div
			data-chat-frame
			className="flex min-h-0 flex-col"
			style={{
				height: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))',
				// ChatView already ends the frame above the nav; cancel the shell's nav padding.
				marginBottom: 'calc(-1 * (var(--app-nav-height, 5rem) + 0.5rem))',
			}}
		>
			<header className="flex shrink-0 flex-col gap-2 border-b border-border bg-background px-4 py-2">
				<div className="mx-auto flex w-full max-w-3xl items-center gap-2">
					{/* Das Segment ersetzt den sichtbaren Titel, damit der Chat keine
					    zusätzliche Höhe verliert. */}
					<h1 className="sr-only">Chat</h1>
					<SubNav className="flex-1" />
				</div>
			</header>
			<ChatView
				key={wgRow.id}
				wgId={wgRow.id}
				shareCode={wgRow.shareCode}
				initialMessages={messages.map((m) => ({
					...m,
					body: m.deletedAt ? null : m.body,
					imageUrl: m.deletedAt ? null : m.imageUrl,
					systemPayload:
						m.systemPayload && typeof m.systemPayload === 'object'
							? (m.systemPayload as Record<string, unknown>)
							: null,
					createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
					editedAt: m.editedAt instanceof Date ? m.editedAt.toISOString() : (m.editedAt ?? null),
					deletedAt:
						m.deletedAt instanceof Date ? m.deletedAt.toISOString() : (m.deletedAt ?? null),
				}))}
				initialReactions={reactions}
			/>
		</div>
	);
}
