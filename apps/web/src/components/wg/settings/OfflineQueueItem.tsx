'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { buildQueueEditDraft, type QueueEditDraft } from '@/core/offline/drafts';
import { needsManualOfflineResolution } from '@/core/offline/offline-client';
import { holdsServerReview, titled } from '@/core/offline/offline-failure-copy';
import {
	explainOfflineActionFailure,
	getOfflineActionRisk,
	getOfflineActionSummary,
	type OfflineAction,
} from '@/core/offline/offline-queue';
import { type Message, useMessage } from '@/shared/i18n/message';
import { cn } from '@/shared/lib/cn';

interface OfflineQueueItemProps {
	item: OfflineAction;
	inspectHref: string;
	conflictNote: Message | undefined;
	syncing: boolean;
	checkingServer: boolean;
	onCheckServer: () => void;
	onEdit: (draft: QueueEditDraft) => void;
	onRemoveAttachment: () => void;
	onRemove: () => void;
}

/** One queued offline action with its status, risk, server comparison and actions. */
export function OfflineQueueItem({
	item,
	inspectHref,
	conflictNote,
	syncing,
	checkingServer,
	onCheckServer,
	onEdit,
	onRemoveAttachment,
	onRemove,
}: OfflineQueueItemProps) {
	const t = useTranslations('offline.queue');
	const locale = useLocale();
	const message = useMessage();
	const summary = getOfflineActionSummary(item);
	const fallback = explainOfflineActionFailure(0);
	const risk = getOfflineActionRisk(item);
	const editDraft = buildQueueEditDraft(item, locale);
	const requiresManualReview = holdsServerReview(item);
	const requiresManualResolution = needsManualOfflineResolution(item);
	const actionLabel = message(summary.detail) || message(summary.title);
	const lastError = item.lastErrorMessage ? message(item.lastErrorMessage) : item.lastError;
	const rowBusy = syncing || checkingServer;
	return (
		<Item variant="outline" className="items-start">
			<ItemContent className="min-w-0">
				<ItemTitle>
					<span className="min-w-0 flex-1 truncate">{message(summary.title)}</span>
					{item.attempts ? (
						<Badge variant="destructive">{t('attempts', { count: String(item.attempts) })}</Badge>
					) : null}
				</ItemTitle>
				<ItemDescription className="line-clamp-none">{message(summary.detail)}</ItemDescription>
				{requiresManualResolution ? (
					<Alert className="mt-1" variant="destructive">
						<AlertDescription>{lastError}</AlertDescription>
					</Alert>
				) : (
					<p className="text-muted-foreground line-clamp-2 text-xs">
						{lastError ?? message(fallback.detail)}
					</p>
				)}
				{risk && (
					<Alert className="mt-1">
						<AlertDescription>{message(titled(risk))}</AlertDescription>
					</Alert>
				)}
				{conflictNote && (
					<Alert className="mt-1">
						<AlertDescription>{message(conflictNote)}</AlertDescription>
					</Alert>
				)}
				<div className="mt-2 flex flex-wrap gap-2">
					{requiresManualReview ? (
						<a
							href={inspectHref}
							className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-11')}
							aria-label={t('inspectLabel', { action: actionLabel })}
						>
							{t('inspect')}
						</a>
					) : (
						<>
							<Button
								type="button"
								variant="outline"
								size="sm"
								aria-label={t('compareLabel', { action: actionLabel })}
								onClick={onCheckServer}
								disabled={rowBusy}
							>
								{checkingServer && <Spinner aria-hidden />}
								{checkingServer ? t('comparing') : t('compare')}
							</Button>
							{editDraft ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label={t('editLabel', { action: actionLabel })}
									onClick={() => onEdit(editDraft)}
									disabled={rowBusy}
								>
									{t('edit')}
								</Button>
							) : null}
							{item.payload.imageUrl ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label={t('removeAttachmentLabel', { action: actionLabel })}
									onClick={onRemoveAttachment}
									disabled={rowBusy}
								>
									{t('removeAttachment')}
								</Button>
							) : null}
						</>
					)}
					<Button
						type="button"
						variant="destructive"
						size="sm"
						aria-label={t('discardLabel', { action: actionLabel })}
						onClick={onRemove}
						disabled={rowBusy}
					>
						{t('discard')}
					</Button>
				</div>
			</ItemContent>
		</Item>
	);
}
