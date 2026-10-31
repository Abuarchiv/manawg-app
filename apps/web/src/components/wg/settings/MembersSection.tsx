'use client';

import { Crown, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemEntry,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { MemberDeactivateDialog } from '@/components/wg/MemberDeactivateDialog';
import {
	type PendingAdminTransfer,
	postAdminTransfer,
} from '@/components/wg/settings/admin-transfer';
import { Section } from '@/components/wg/settings/Section';
import type { Member, WgSummary } from '@/components/wg/WgContextProvider';
import { useWg } from '@/components/wg/WgContextProvider';
import type { SessionMember } from '@/core/auth/local-account';
import { isRateLimited } from '@/core/http/error-codes';
import { apiFetch } from '@/core/infra/api-client';
import { MAX_MEMBERS_PER_WG } from '@/shared/lib/limits';

interface MembersSectionProps {
	wg: WgSummary;
	members: Member[];
	identity: SessionMember;
}

/** Member list with admin handover, move-out and reactivation (admins only). */
export function MembersSection({ wg, members, identity }: MembersSectionProps) {
	const t = useTranslations('settings.members');
	const common = useTranslations('common');
	const actions = useTranslations('settings.actions');
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const { refreshMembers, isAdmin } = useWg();
	const [memberToDeactivate, setMemberToDeactivate] = useState<{ id: string; name: string } | null>(
		null,
	);
	const [memberToPromote, setMemberToPromote] = useState<{ id: string; name: string } | null>(null);
	const [promoting, setPromoting] = useState(false);
	const pendingTransferRef = useRef<PendingAdminTransfer['current']>(null);
	const [promoteError, setPromoteError] = useState<string | null>(null);
	const [reactivatingId, setReactivatingId] = useState<string | null>(null);
	const [memberActionMessage, setMemberActionMessage] = useState<string | null>(null);
	const [memberActionError, setMemberActionError] = useState<string | null>(null);
	const [memberToReactivate, setMemberToReactivate] = useState<{ id: string; name: string } | null>(
		null,
	);
	const activeMembers = members.filter((m) => m.active);
	const inactiveMembers = members.filter((m) => !m.active);

	// The layout's roster has no roles; load them so the Admin badge is right from the start.
	useEffect(() => {
		void refreshMembers();
	}, [refreshMembers]);

	function handleMemberDeactivated(name: string): void {
		setMemberActionError(null);
		setMemberActionMessage(t('movedOutDone', { name }));
		void refreshMembers();
	}

	async function handleTransferAdmin(): Promise<void> {
		if (!memberToPromote || promoting) return;
		setPromoting(true);
		setPromoteError(null);
		const res = await postAdminTransfer({
			adminsUrl: `/api/wg/${encodedShareCode}/members/${memberToPromote.id}/admin`,
			actorMemberId: identity.memberId,
			targetMemberId: memberToPromote.id,
			pending: pendingTransferRef,
		});
		setPromoting(false);
		if (!res.ok) {
			setPromoteError(
				isRateLimited(res.error, res.status)
					? common('errors.rateLimited')
					: res.error === 'member_inactive'
						? t('errors.inactive')
						: res.error === 'member_not_linked'
							? t('errors.notLinked')
							: t('errors.promoteFailed'),
			);
			return;
		}
		setMemberActionError(null);
		setMemberActionMessage(t('promoted', { name: memberToPromote.name }));
		setMemberToPromote(null);
		void refreshMembers();
	}

	async function handleReactivate(member: { id: string; name: string }): Promise<void> {
		if (reactivatingId) return;
		setReactivatingId(member.id);
		setMemberActionError(null);
		setMemberActionMessage(null);
		const res = await apiFetch<{ member: { id: string; name: string; active: boolean } }>(
			`/api/wg/${encodedShareCode}/members/${member.id}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				body: JSON.stringify({ active: true }),
			},
		);
		if (res.ok) {
			setMemberActionMessage(t('reactivated', { name: member.name }));
			void refreshMembers();
		} else {
			setMemberActionError(
				isRateLimited(res.error, res.status)
					? common('errors.rateLimited')
					: res.error === 'member_limit_reached'
						? t('errors.limit', { max: String(MAX_MEMBERS_PER_WG) })
						: t('errors.reactivateFailed'),
			);
		}
		setReactivatingId(null);
	}

	return (
		<>
			<Section title={t('title')}>
				<ItemGroup className="gap-0 px-2 py-1">
					{activeMembers.map((member) => (
						<ItemEntry key={member.id} size="sm" className="min-h-11">
							<ItemMedia>
								<MemberAvatar name={member.name} size={26} />
							</ItemMedia>
							<ItemContent className="min-w-[8ch] basis-[8ch]">
								<ItemTitle className="line-clamp-none [overflow-wrap:break-word]">
									{member.name}
									{member.isAdmin && <Badge variant="outline">{t('admin')}</Badge>}
								</ItemTitle>
							</ItemContent>
							<ItemActions>
								{member.id === identity.memberId ? (
									<Badge variant="secondary">{t('you')}</Badge>
								) : (
									isAdmin && (
										<>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => {
													setPromoteError(null);
													setMemberToPromote({ id: member.id, name: member.name });
												}}
												aria-label={t('transferAdminAria', { name: member.name })}
											>
												{t('transferAdmin')}
											</Button>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => setMemberToDeactivate({ id: member.id, name: member.name })}
												aria-label={t('moveOutAria', { name: member.name })}
											>
												{t('moveOut')}
											</Button>
										</>
									)
								)}
							</ItemActions>
						</ItemEntry>
					))}
				</ItemGroup>
				{inactiveMembers.length > 0 && (
					<div className="px-2 pt-2 pb-1">
						<p className="text-muted-foreground px-0.5 pb-1 text-xs font-medium">{t('movedOut')}</p>
						<ItemGroup className="gap-0">
							{inactiveMembers.map((member) => (
								<ItemEntry key={member.id} size="sm" className="min-h-11 opacity-70">
									<ItemMedia>
										<MemberAvatar name={member.name} size={26} />
									</ItemMedia>
									<ItemContent className="min-w-[8ch] basis-[8ch]">
										<ItemTitle className="line-clamp-none [overflow-wrap:break-word]">
											{member.name}
										</ItemTitle>
										<ItemDescription className="line-clamp-none [overflow-wrap:break-word]">
											{member.hasAccount === false ? t('movedOutNoAccount') : t('movedOutKept')}
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										{isAdmin && (
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => {
													const target = { id: member.id, name: member.name };
													if (member.hasAccount === false) setMemberToReactivate(target);
													else void handleReactivate(target);
												}}
												disabled={reactivatingId === member.id}
												aria-label={t('reactivateAria', { name: member.name })}
											>
												{reactivatingId === member.id ? (
													<Spinner aria-hidden />
												) : (
													<UserPlus aria-hidden />
												)}
												{t('reactivate')}
											</Button>
										)}
									</ItemActions>
								</ItemEntry>
							))}
						</ItemGroup>
					</div>
				)}
				{memberActionMessage && (
					<div className="px-2 pb-3">
						<Alert>
							<AlertDescription>{memberActionMessage}</AlertDescription>
						</Alert>
					</div>
				)}
				{memberActionError && (
					<div className="px-2 pb-3">
						<Alert variant="destructive">
							<AlertDescription>{memberActionError}</AlertDescription>
						</Alert>
					</div>
				)}
			</Section>

			<AlertDialog
				open={memberToPromote !== null}
				onOpenChange={(open) => {
					if (!open && !promoting) setMemberToPromote(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia>
							<Crown aria-hidden />
						</AlertDialogMedia>
						<AlertDialogTitle>{t('promoteDialog.title')}</AlertDialogTitle>
						<AlertDialogDescription>
							{t('promoteDialog.body', { name: memberToPromote?.name ?? '' })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{promoteError && (
						<Alert variant="destructive">
							<AlertDescription>{promoteError}</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={promoting}>{actions('cancel')}</AlertDialogCancel>
						<Button
							onClick={(event) => {
								event.preventDefault();
								void handleTransferAdmin();
							}}
							disabled={promoting}
						>
							{promoting && <Spinner aria-hidden />}
							{t('promoteDialog.confirm')}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				open={memberToReactivate !== null}
				onOpenChange={(open) => {
					if (!open) setMemberToReactivate(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia>
							<UserPlus aria-hidden />
						</AlertDialogMedia>
						<AlertDialogTitle>
							{t('reactivateDialog.title', { name: memberToReactivate?.name ?? '' })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t('reactivateDialog.body', { name: memberToReactivate?.name ?? '' })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{actions('cancel')}</AlertDialogCancel>
						<Button
							onClick={() => {
								const target = memberToReactivate;
								setMemberToReactivate(null);
								if (target) void handleReactivate(target);
							}}
						>
							{t('reactivateDialog.confirm')}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{memberToDeactivate && (
				<MemberDeactivateDialog
					encodedShareCode={encodedShareCode}
					member={memberToDeactivate}
					viewerMemberId={identity.memberId}
					onClose={() => setMemberToDeactivate(null)}
					onDeactivated={handleMemberDeactivated}
				/>
			)}
		</>
	);
}
