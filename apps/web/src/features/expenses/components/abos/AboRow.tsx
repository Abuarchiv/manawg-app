'use client';

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
import { Button } from '@/components/ui/button';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { useWg } from '@/components/wg/WgContextProvider';
import { berlinDayKey } from '@/core/utils/berlin-day';
import { formatEuroCents } from '@/core/utils/money';
import { formatShortDate, parseValidDate } from '@/core/utils/time';
import type { Abo, MemberOption } from '@/features/expenses/components/abos/abos-types';
import {
	canManageRecurringTemplate,
	formatIntervalLabel,
	previewNextOccurrences,
} from '@/features/expenses/recurring-expenses';
import { ChevronDown, Pause, Pencil, Play, Trash2 } from 'lucide-react';

const DATE_WITH_YEAR = new Intl.DateTimeFormat('de-DE', {
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
});

/** Yearly recurring expenses: without the year all dates would look the same (03.02., 03.02., 03.02.). */
function formatAboDate(iso: string, intervalMonths: number): string {
	const date = intervalMonths >= 12 ? parseValidDate(iso) : null;
	return date ? DATE_WITH_YEAR.format(date) : formatShortDate(iso);
}

interface AboRowProps {
	abo: Abo;
	members: MemberOption[];
	pending: boolean;
	onEdit: (abo: Abo) => void;
	onTogglePause: (abo: Abo) => void;
	onDelete: (abo: Abo) => void;
}

export function AboRow({ abo, members, pending, onEdit, onTogglePause, onDelete }: AboRowProps) {
	const payer = members.find((member) => member.id === abo.paidByMemberId);
	const isPaused = abo.pausedAt !== null;
	const isOverdue = !isPaused && berlinDayKey(new Date(abo.nextDueAt)) < berlinDayKey(new Date());
	const preview = previewNextOccurrences(
		{ nextDueAt: abo.nextDueAt, intervalMonths: abo.intervalMonths, anchorAt: abo.anchorAt },
		3,
	);
	const { identity, isAdmin } = useWg();
	const canManage = canManageRecurringTemplate(abo, identity.memberId, isAdmin);
	const payerName = payer?.name ?? 'unbekannt';
	// The cron skips (never advances) a template whose payer or debtor moved out.
	const blockedByMovedOut =
		!isPaused &&
		[abo.paidByMemberId, ...abo.splits.map((split) => split.debtorMemberId)].some(
			(id) => members.find((member) => member.id === id)?.active === false,
		);
	return (
		<li className={isPaused ? 'text-muted-foreground' : undefined}>
			<Collapsible>
				<CollapsibleTrigger
					render={
						<Button
							variant="ghost"
							className="group h-auto w-full items-start justify-start gap-3 rounded-none px-3 py-2.5 text-left whitespace-normal hover:bg-transparent aria-expanded:bg-transparent active:bg-muted"
						/>
					}
				>
					<span className="mt-0.5 flex">
						<MemberAvatar name={payerName} size={28} />
					</span>
					{/* Amount to the right of the title; only when the row gets too narrow (320 px, large text) it goes below. */}
					<span className="@container flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="flex min-w-0 flex-col gap-0.5 @[14rem]:flex-row @[14rem]:items-baseline @[14rem]:gap-3">
							<span className="sr-only">Details öffnen:</span>
							<span className="min-w-0 flex-1 hyphens-auto text-[14px] font-medium leading-snug [overflow-wrap:break-word]">
								{abo.description}
							</span>
							<span className="whitespace-nowrap font-mono tabular-nums @[14rem]:shrink-0">
								{formatEuroCents(abo.amountCents, abo.currency)}
							</span>
						</span>
						<span className="text-[12px] leading-normal font-normal text-muted-foreground">
							{isPaused ? (
								'pausiert'
							) : blockedByMovedOut ? (
								<span className="font-medium text-foreground">wird nicht gebucht</span>
							) : isOverdue ? (
								<span className="font-medium text-foreground">
									seit {formatAboDate(abo.nextDueAt, abo.intervalMonths)} fällig
								</span>
							) : (
								`nächste am ${formatAboDate(abo.nextDueAt, abo.intervalMonths)}`
							)}
							{` · ${formatIntervalLabel(abo.intervalMonths)} · `}
							<span className="sr-only">bezahlt von </span>
							{abo.paidByMemberId === identity.memberId ? 'du' : payerName}
						</span>
					</span>
					<ChevronDown
						aria-hidden
						className="mt-0.5 size-4 shrink-0 text-muted-foreground group-aria-expanded:rotate-180"
					/>
				</CollapsibleTrigger>
				<CollapsiblePanel>
					<div className="flex flex-col gap-3 px-3 pt-1 pb-3">
						<ul className="flex flex-col gap-2">
							{abo.splits.map((split) => {
								const name =
									split.debtorMemberId === identity.memberId
										? 'Du'
										: (members.find((member) => member.id === split.debtorMemberId)?.name ??
											'unbekannt');
								return (
									<li
										key={split.debtorMemberId}
										className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm"
									>
										<span className="min-w-[10ch] flex-1 hyphens-auto [overflow-wrap:break-word]">
											{name}
											{split.debtorMemberId === abo.paidByMemberId ? ' · eigener Anteil' : ''}
										</span>
										<span className="ml-auto font-mono tabular-nums">
											{formatEuroCents(split.amountCents, abo.currency)}
										</span>
									</li>
								);
							})}
						</ul>
						{blockedByMovedOut && (
							<p className="text-sm font-medium text-foreground">
								Wird nicht gebucht, weil ein beteiligtes Mitglied ausgezogen ist. Passe die Anteile
								an oder pausiere die Fixkosten.
							</p>
						)}
						{preview.length > 0 && !isPaused && !blockedByMovedOut && (
							<p className="text-sm text-muted-foreground">
								Nächste {preview.length} Buchungen:{' '}
								{preview
									.map((date) => formatAboDate(date.toISOString(), abo.intervalMonths))
									.join(', ')}
							</p>
						)}
						{canManage ? (
							<div className="flex flex-wrap items-center gap-3 border-t pt-3">
								{/* Pausing is deliberately here rather than a switch in the row: no accidental taps. */}
								<Button
									variant="outline"
									onClick={() => onTogglePause(abo)}
									disabled={pending}
									aria-label={
										isPaused ? `Fortsetzen: ${abo.description}` : `Pausieren: ${abo.description}`
									}
								>
									{isPaused ? (
										<Play data-icon="inline-start" />
									) : (
										<Pause data-icon="inline-start" />
									)}
									{isPaused ? 'Fortsetzen' : 'Pausieren'}
								</Button>
								<Button
									variant="outline"
									size="icon"
									onClick={() => onEdit(abo)}
									disabled={pending}
									aria-label={`${abo.description} bearbeiten`}
								>
									<Pencil />
									<span className="sr-only">{abo.description} bearbeiten</span>
								</Button>
								<Button
									variant="outline"
									size="icon"
									className="text-destructive"
									onClick={() => onDelete(abo)}
									disabled={pending}
									aria-label={`${abo.description} löschen`}
								>
									<Trash2 />
									<span className="sr-only">{abo.description} löschen</span>
								</Button>
							</div>
						) : (
							<p className="border-t pt-3 text-sm text-muted-foreground">
								Nur wer die Fixkosten angelegt hat oder Admin der WG ist, kann sie ändern, pausieren
								oder löschen.
							</p>
						)}
					</div>
				</CollapsiblePanel>
			</Collapsible>
		</li>
	);
}
