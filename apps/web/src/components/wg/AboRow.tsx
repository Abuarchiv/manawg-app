'use client';

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
import { Button } from '@/components/ui/button';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { useWg } from '@/components/wg/WgContextProvider';
import type { Abo, MemberOption } from '@/components/wg/abos-types';
import { berlinDayKey } from '@/core/utils/berlin-day';
import { formatEuroCents } from '@/core/utils/money';
import { formatShortDate } from '@/core/utils/time';
import {
	formatIntervalLabel,
	previewNextOccurrences,
} from '@/features/expenses/recurring-expenses';
import { ChevronDown, Pause, Pencil, Play, Trash2 } from 'lucide-react';

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
		{ nextDueAt: abo.nextDueAt, intervalMonths: abo.intervalMonths },
		3,
	);
	const { identity } = useWg();
	const payerName = payer?.name ?? 'unbekannt';
	return (
		<li className={isPaused ? 'text-muted-foreground' : undefined}>
			<Collapsible>
				<CollapsibleTrigger
					render={
						<Button
							variant="ghost"
							className="group h-auto w-full justify-start gap-3 rounded-none px-3 py-2.5 text-left whitespace-normal"
						/>
					}
				>
					<MemberAvatar name={payerName} size={28} />
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="flex min-w-0 items-baseline gap-3">
							<span className="sr-only">Details öffnen:</span>
							<span className="min-w-0 flex-1 break-words text-[14px] font-medium leading-snug">
								{abo.description}
							</span>
							<span className="shrink-0 whitespace-nowrap font-mono tabular-nums">
								{formatEuroCents(abo.amountCents, abo.currency)}
							</span>
						</span>
						<span className="text-[12px] leading-normal font-normal text-muted-foreground">
							{isPaused ? (
								'pausiert'
							) : isOverdue ? (
								<span className="font-medium text-foreground">
									seit {formatShortDate(abo.nextDueAt)} fällig
								</span>
							) : (
								`nächste am ${formatShortDate(abo.nextDueAt)}`
							)}
							{` · ${formatIntervalLabel(abo.intervalMonths)} · `}
							<span className="sr-only">bezahlt von </span>
							{abo.paidByMemberId === identity.memberId ? 'du' : payerName}
						</span>
					</span>
					<ChevronDown
						aria-hidden
						className="size-4 shrink-0 text-muted-foreground group-aria-expanded:rotate-180"
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
										className="flex items-baseline justify-between gap-3 text-sm"
									>
										<span className="min-w-0 break-words">
											{name}
											{split.debtorMemberId === abo.paidByMemberId ? ' · eigener Anteil' : ''}
										</span>
										<span className="shrink-0 font-mono tabular-nums">
											{formatEuroCents(split.amountCents, abo.currency)}
										</span>
									</li>
								);
							})}
						</ul>
						{preview.length > 0 && !isPaused && (
							<p className="text-sm text-muted-foreground">
								Nächste {preview.length} Buchungen:{' '}
								{preview.map((date) => formatShortDate(date.toISOString())).join(', ')}
							</p>
						)}
						<div className="flex flex-wrap items-center gap-2 border-t pt-3">
							{/* Pausieren liegt bewusst hier statt als Schalter in der Zeile: kein versehentliches Antippen. */}
							<Button
								variant="outline"
								onClick={() => onTogglePause(abo)}
								disabled={pending}
								aria-label={
									isPaused ? `Fortsetzen: ${abo.description}` : `Pausieren: ${abo.description}`
								}
							>
								{isPaused ? <Play data-icon="inline-start" /> : <Pause data-icon="inline-start" />}
								{isPaused ? 'Fortsetzen' : 'Pausieren'}
							</Button>
							<Button
								variant="outline"
								size="icon"
								className="size-10"
								onClick={() => onEdit(abo)}
								disabled={pending}
								aria-label={`${abo.description} bearbeiten`}
							>
								<Pencil />
								<span className="sr-only">{abo.description} bearbeiten</span>
							</Button>
							<Button
								variant="ghost"
								size="icon"
								className="size-10"
								onClick={() => onDelete(abo)}
								disabled={pending}
								aria-label={`${abo.description} löschen`}
							>
								<Trash2 />
								<span className="sr-only">{abo.description} löschen</span>
							</Button>
						</div>
					</div>
				</CollapsiblePanel>
			</Collapsible>
		</li>
	);
}
