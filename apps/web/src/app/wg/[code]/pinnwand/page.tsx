'use client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { OfflineQueueNotice } from '@/components/wg/OfflineQueueNotice';
import { SubNav } from '@/components/wg/SubNav';
import { ThumbAction } from '@/components/wg/ThumbAction';
import { getAnnouncementHash } from '@/features/pinnwand/announcement-workflow';
import { AnnouncementCard } from '@/features/pinnwand/components/AnnouncementCard';
import { AnnouncementSkeleton } from '@/features/pinnwand/components/AnnouncementSkeleton';
import { EmptyState } from '@/features/pinnwand/components/EmptyState';
import { MyOpenAnnouncements } from '@/features/pinnwand/components/MyOpenAnnouncements';
import { PinnwandComposer } from '@/features/pinnwand/components/PinnwandComposer';
import type { Announcement } from '@/features/pinnwand/components/announcement-types';
import { usePinnwandPage } from '@/features/pinnwand/hooks/use-pinnwand-page';
import { ChevronDown, Megaphone, Plus } from 'lucide-react';
import type React from 'react';

const UNKNOWN_AUTHOR = { name: '?', color: null };

export default function PinnwandPage(): React.ReactElement {
	const {
		wg,
		identity,
		isAdmin,
		items,
		openItems,
		archivedItems,
		myOpenItems,
		visibleOpenCount,
		visibleArchivedCount,
		showMoreOpen,
		showMoreArchived,
		showSkeleton,
		loadError,
		refreshing,
		load,
		newCount,
		applyPendingItems,
		queuedCount,
		notice,
		setNotice,
		highlightedId,
		scrollToAnnouncement,
		archiveOpen,
		setArchiveOpen,
		authorByMemberId,
		isPending,
		stableDelete,
		stableTogglePinned,
		stableToggleStatus,
		stableEdit,
		stableToggleReaction,
		stableAddComment,
		stableUpdateComment,
		stableDeleteComment,
		composer,
	} = usePinnwandPage();

	function renderCard(a: Announcement): React.ReactElement {
		return (
			<AnnouncementCard
				key={`${identity.memberId}:${a.id}`}
				announcement={a}
				author={authorByMemberId.get(a.authorMemberId) ?? UNKNOWN_AUTHOR}
				deletePending={isPending(a.id)}
				pinPending={isPending(`${a.id}:pin`)}
				statusPending={isPending(`${a.id}:status`)}
				pendingReactions={(['seen', 'take', 'ok'] as const)
					.filter((reaction) => isPending(`${a.id}:reaction:${reaction}`))
					.join()}
				onDelete={stableDelete}
				onTogglePinned={stableTogglePinned}
				onToggleStatus={stableToggleStatus}
				onEdit={stableEdit}
				onToggleReaction={stableToggleReaction}
				onAddComment={stableAddComment}
				onUpdateComment={stableUpdateComment}
				onDeleteComment={stableDeleteComment}
				currentMemberId={identity.memberId}
				isAdmin={isAdmin}
				shareCode={wg.shareCode}
				highlighted={highlightedId === a.id}
			/>
		);
	}

	return (
		<div data-exchange-content className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-3">
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

			<PinnwandComposer
				open={composer.open}
				finalFocusRef={composer.buttonRef}
				authorName={identity.name}
				submitting={composer.submitting}
				kind={composer.kind}
				onKindChange={composer.setKind}
				content={composer.content}
				onContentChange={composer.setContent}
				textareaRef={composer.textareaRef}
				imageUrl={composer.imageUrl}
				onImageUrlChange={composer.setImageUrl}
				shareCode={wg.shareCode}
				error={composer.error}
				onClose={composer.close}
				onSubmit={composer.submit}
			/>

			{notice && (
				<Alert aria-live="polite">
					<AlertDescription>{notice}</AlertDescription>
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
				<EmptyState icon={Megaphone}>Noch keine Beiträge</EmptyState>
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
							{openItems.slice(0, visibleOpenCount).map(renderCard)}
						</ul>
					)}
					{visibleOpenCount < openItems.length && (
						<Button variant="outline" onClick={showMoreOpen}>
							Mehr anzeigen ({openItems.length - visibleOpenCount})
						</Button>
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
							{/* Linked archive posts must stay reachable by hash. */}
							<CollapsibleContent keepMounted>
								<ul
									className="flex flex-col divide-y overflow-hidden rounded-xl border"
									aria-label="Geklärte und ältere Beiträge"
								>
									{archivedItems.slice(0, visibleArchivedCount).map(renderCard)}
								</ul>
								{visibleArchivedCount < archivedItems.length && (
									<Button variant="outline" className="mt-2 w-full" onClick={showMoreArchived}>
										Mehr anzeigen ({archivedItems.length - visibleArchivedCount})
									</Button>
								)}
							</CollapsibleContent>
						</Collapsible>
					)}
				</>
			)}
			<ThumbAction>
				<Button
					ref={composer.buttonRef}
					type="button"
					className="relative min-h-11 w-full"
					disabled={composer.submitting}
					onClick={() => {
						composer.setOpen(true);
						setNotice(null);
					}}
				>
					<Plus data-icon="inline-start" aria-hidden />
					{composer.hasDraft ? 'Entwurf fortsetzen' : 'Beitrag hinzufügen'}
					{composer.hasDraft && (
						<span
							aria-hidden
							className="absolute top-1 right-1 size-2.5 rounded-full bg-primary-foreground ring-2 ring-primary"
						/>
					)}
				</Button>
			</ThumbAction>
		</div>
	);
}
