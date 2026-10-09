'use client';

import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import type { KnownWg } from '@/core/auth/identity';
import {
	type OfflineAction,
	getOfflineActionRisk,
	getOfflineActionSummary,
} from '@/core/offline/offline-queue';
import Link from 'next/link';
import {
	type OfflineStatus,
	formatOfflineAge,
	formatQueuedActionCount,
	wgHref,
} from './offline-page-helpers';

const RECENT_VISIBLE = 4;

/** The newest queued actions; the full list lives in the WG settings. */
export function OfflineQueueCard({
	queue,
	primaryWg,
	status,
}: { queue: OfflineAction[]; primaryWg: KnownWg | null; status: OfflineStatus }) {
	const recentQueue = queue.slice(-RECENT_VISIBLE).reverse();
	const hiddenQueueCount = Math.max(0, queue.length - recentQueue.length);
	return (
		<section
			aria-labelledby="offline-queue-heading"
			className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 id="offline-queue-heading" className="font-heading text-base leading-5 font-semibold">
						Warteschlange
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						{status === 'checking'
							? 'Wird geladen…'
							: status === 'unauthenticated'
								? 'Nach der Anmeldung siehst du deine wartenden Aktionen.'
								: formatQueuedActionCount(queue.length)}
					</p>
				</div>
			</div>
			{recentQueue.length > 0 && (
				<ItemGroup className="gap-2" aria-label="Wartende Offline-Aktionen">
					{recentQueue.map((item) => {
						const summary = getOfflineActionSummary(item);
						const risk = getOfflineActionRisk(item);
						return (
							// biome-ignore lint/a11y/useSemanticElements: ItemGroup is a div[role=list], a bare <li> would be invalid HTML
							<Item key={item.id} variant="outline" role="listitem" className="items-start">
								<ItemContent className="basis-40">
									<ItemTitle className="line-clamp-none [overflow-wrap:break-word]">
										{summary.title}
									</ItemTitle>
									<ItemDescription className="line-clamp-1">{summary.detail}</ItemDescription>
									{(item.lastError || risk) && (
										<p className="mt-1 text-xs text-muted-foreground">
											{item.lastError && <span className="text-destructive">{item.lastError}</span>}
											{item.lastError && risk ? ' ' : null}
											{risk && `${risk.title}: ${risk.detail}`}
										</p>
									)}
								</ItemContent>
								<span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
									{formatOfflineAge(item.createdAt)}
								</span>
							</Item>
						);
					})}
				</ItemGroup>
			)}
			{hiddenQueueCount > 0 && (
				<>
					<Separator />
					<p className="text-sm text-muted-foreground">
						+{hiddenQueueCount} weitere Aktion
						{hiddenQueueCount === 1 ? '' : 'en'} in der Warteschlange.{' '}
						{primaryWg ? (
							<Link
								href={wgHref(primaryWg.code, '/einstellungen#daten')}
								className="text-primary underline underline-offset-4"
							>
								Alle Aktionen prüfen
							</Link>
						) : (
							'Alle Aktionen prüfen'
						)}{' '}
						öffnet die vollständige Liste.
					</p>
				</>
			)}
		</section>
	);
}
