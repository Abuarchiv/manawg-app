'use client';

import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import {
	CONVERSION_TARGETS,
	type ConversionTarget,
	REACTION_OPTIONS,
} from '@/features/pinnwand/announcement-card-model';
import { getPinnwandPrefillHref } from '@/features/pinnwand/pinnwand-prefill';
import {
	CheckCircle2,
	ExternalLink,
	Eye,
	Hand,
	ListChecks,
	type LucideIcon,
	MoreHorizontal,
	Pencil,
	Pin,
	PinOff,
	Receipt,
	Sparkles,
	ThumbsUp,
	Trash2,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactionKey } from './announcement-types';

export const REACTION_ICONS: Record<ReactionKey, LucideIcon> = {
	seen: Eye,
	take: Hand,
	ok: ThumbsUp,
};

const CONVERSION_ICONS: Record<ConversionTarget, LucideIcon> = {
	shopping: ListChecks,
	chore: Sparkles,
	expense: Receipt,
};

export function reactionLabel(key: ReactionKey): string {
	return REACTION_OPTIONS.find((option) => option.key === key)?.label ?? key;
}

interface AnnouncementActionsMenuProps {
	actionSubject: string;
	shareCode: string;
	sourceHref: string | null;
	/** Prefill for turning a manual post into a shopping item, chore or expense; null otherwise. */
	prefill: Parameters<typeof getPinnwandPrefillHref>[2] | null;
	hiddenReactions: ReactionKey[];
	reactionPending: (key: ReactionKey) => boolean;
	isPinned: boolean;
	isResolved: boolean;
	canModerate: boolean;
	canEdit: boolean;
	canResolve: boolean;
	deletePending: boolean;
	pinPending: boolean;
	statusPending: boolean;
	onReact: (key: ReactionKey) => void;
	onTogglePinned: () => void;
	onToggleStatus: () => void;
	onEdit: () => void;
	onDelete: () => void;
}

/** The ⋯ menu of a card: source, conversions, less used reactions and moderation. */
export function AnnouncementActionsMenu({
	actionSubject,
	shareCode,
	sourceHref,
	prefill,
	hiddenReactions,
	reactionPending,
	isPinned,
	isResolved,
	canModerate,
	canEdit,
	canResolve,
	deletePending,
	pinPending,
	statusPending,
	onReact,
	onTogglePinned,
	onToggleStatus,
	onEdit,
	onDelete,
}: AnnouncementActionsMenuProps) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Button variant="ghost" size="icon" className="-my-1 size-8" />}
				aria-label={`Beitragsaktionen: ${actionSubject}`}
				disabled={deletePending}
			>
				<MoreHorizontal aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-2rem)]">
				<DropdownMenuGroup>
					{sourceHref && (
						<DropdownMenuItem
							render={<Link href={sourceHref} />}
							className="min-h-11"
							aria-label={`Quelle öffnen: ${actionSubject}`}
						>
							<ExternalLink aria-hidden /> Quelle öffnen
						</DropdownMenuItem>
					)}
					{prefill &&
						CONVERSION_TARGETS.map(({ target, label }) => {
							const Icon = CONVERSION_ICONS[target];
							return (
								<DropdownMenuItem
									key={target}
									render={<Link href={getPinnwandPrefillHref(shareCode, target, prefill)} />}
									className="min-h-11"
									aria-label={`${label} übernehmen: ${actionSubject}`}
								>
									<Icon aria-hidden /> {label} übernehmen
								</DropdownMenuItem>
							);
						})}
					{hiddenReactions.map((key) => {
						const Icon = REACTION_ICONS[key];
						const label = reactionLabel(key);
						return (
							<DropdownMenuItem
								key={key}
								onClick={() => onReact(key)}
								disabled={reactionPending(key)}
								className="min-h-11"
								aria-label={`${label}-Reaktion setzen: ${actionSubject}`}
							>
								<Icon aria-hidden /> {label}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuGroup>
				{(canEdit || canModerate || canResolve) && <DropdownMenuSeparator />}
				<DropdownMenuGroup>
					{canEdit && (
						<DropdownMenuItem
							onClick={onEdit}
							className="min-h-11"
							aria-label={`Beitrag bearbeiten: ${actionSubject}`}
						>
							<Pencil /> Bearbeiten
						</DropdownMenuItem>
					)}
					{canModerate && (
						<DropdownMenuItem
							onClick={onTogglePinned}
							disabled={pinPending}
							className="min-h-11"
							aria-label={(isPinned ? 'Fixierung lösen: ' : 'Beitrag fixieren: ') + actionSubject}
						>
							{pinPending ? <Spinner /> : isPinned ? <PinOff /> : <Pin />}
							{isPinned ? 'Fixierung lösen' : 'Fixieren'}
						</DropdownMenuItem>
					)}
					{canResolve && (
						<DropdownMenuItem
							onClick={onToggleStatus}
							disabled={statusPending}
							className="min-h-11"
							aria-label={
								(isResolved ? 'Beitrag wieder öffnen: ' : 'Als geklärt markieren: ') + actionSubject
							}
						>
							{statusPending ? <Spinner /> : <CheckCircle2 />}
							{isResolved ? 'Wieder öffnen' : 'Als geklärt markieren'}
						</DropdownMenuItem>
					)}
					{canModerate && (
						<DropdownMenuItem
							variant="destructive"
							onClick={onDelete}
							className="min-h-11"
							aria-label={`Beitrag entfernen: ${actionSubject}`}
						>
							<Trash2 /> Entfernen
						</DropdownMenuItem>
					)}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
