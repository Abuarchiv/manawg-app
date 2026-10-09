'use client';

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
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { MemberDeactivateDialog } from '@/components/wg/MemberDeactivateDialog';
import type { Member, WgSummary } from '@/components/wg/WgContextProvider';
import { useWg } from '@/components/wg/WgContextProvider';
import { Section } from '@/components/wg/einstellungen/Section';
import { PAYPAL_PAYMENT_PENDING_MESSAGE } from '@/components/wg/einstellungen/settings-errors';
import type { StoredIdentity } from '@/core/auth/identity';
import { RATE_LIMITED_MESSAGE, isRateLimited } from '@/core/http/error-codes';
import { apiFetch } from '@/core/infra/api-client';
import { MAX_MEMBERS_PER_WG } from '@/shared/lib/limits';
import { Crown, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';

interface MembersSectionProps {
	wg: WgSummary;
	members: Member[];
	identity: StoredIdentity;
}

/** Member list with admin handover, move-out and reactivation (admins only). */
export function MembersSection({ wg, members, identity }: MembersSectionProps) {
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const { refreshMembers, isAdmin } = useWg();
	const [memberToDeactivate, setMemberToDeactivate] = useState<{ id: string; name: string } | null>(
		null,
	);
	const [memberToPromote, setMemberToPromote] = useState<{ id: string; name: string } | null>(null);
	const [promoting, setPromoting] = useState(false);
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
		void refreshMembers(identity.memberId);
	}, [refreshMembers, identity.memberId]);

	function handleMemberDeactivated(name: string): void {
		setMemberActionError(null);
		setMemberActionMessage(`${name} ist jetzt als ausgezogen markiert.`);
		void refreshMembers(identity.memberId);
	}

	async function handleTransferAdmin(): Promise<void> {
		if (!memberToPromote || promoting) return;
		setPromoting(true);
		setPromoteError(null);
		const res = await apiFetch<{ member: { id: string; name: string } }>(
			`/api/wg/${encodedShareCode}/members/${memberToPromote.id}/admin`,
			{
				method: 'POST',
				memberId: identity.memberId,
				body: JSON.stringify({}),
			},
		);
		setPromoting(false);
		if (!res.ok) {
			setPromoteError(
				isRateLimited(res.error, res.status)
					? RATE_LIMITED_MESSAGE
					: res.error === 'member_inactive'
						? 'Dieses Mitglied ist ausgezogen. Aktiviere es zuerst wieder.'
						: res.error === 'member_not_linked'
							? 'Dieses Mitglied hat noch kein Konto verknüpft und kann nicht Admin werden.'
							: 'Admin-Rolle konnte nicht übergeben werden. Bitte versuche es erneut.',
			);
			return;
		}
		setMemberActionError(null);
		setMemberActionMessage(
			`${memberToPromote.name} ist jetzt Admin. Du kannst die WG jetzt normal verlassen.`,
		);
		setMemberToPromote(null);
		void refreshMembers(identity.memberId);
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
			setMemberActionMessage(`${member.name} ist wieder aktiv.`);
			void refreshMembers(identity.memberId);
		} else {
			setMemberActionError(
				isRateLimited(res.error, res.status)
					? RATE_LIMITED_MESSAGE
					: res.error === 'member_limit_reached'
						? `Die WG hat schon ${MAX_MEMBERS_PER_WG} aktive Mitglieder. Lass zuerst jemanden ausziehen.`
						: res.error === 'paypal_payment_pending'
							? PAYPAL_PAYMENT_PENDING_MESSAGE
							: 'Aktivierung konnte nicht gespeichert werden. Bitte versuche es erneut.',
			);
		}
		setReactivatingId(null);
	}

	return (
		<>
			<Section title="Mitglieder">
				<ItemGroup className="gap-0 px-2 py-1">
					{activeMembers.map((member) => (
						<Item key={member.id} size="sm" className="min-h-[44px]">
							<ItemMedia>
								<MemberAvatar name={member.name} size={26} />
							</ItemMedia>
							<ItemContent className="min-w-[8ch] basis-[8ch]">
								<ItemTitle className="line-clamp-none [overflow-wrap:break-word]">
									{member.name}
									{member.isAdmin && <Badge variant="outline">Admin</Badge>}
								</ItemTitle>
							</ItemContent>
							<ItemActions>
								{member.id === identity.memberId ? (
									<Badge variant="secondary">Du</Badge>
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
												aria-label={`Admin übergeben: ${member.name}`}
											>
												Admin übergeben
											</Button>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => setMemberToDeactivate({ id: member.id, name: member.name })}
												aria-label={`Ausziehen: ${member.name}`}
											>
												Ausziehen
											</Button>
										</>
									)
								)}
							</ItemActions>
						</Item>
					))}
				</ItemGroup>
				{inactiveMembers.length > 0 && (
					<div className="px-2 pt-2 pb-1">
						<p className="text-muted-foreground px-0.5 pb-1 text-xs font-medium">Ausgezogen</p>
						<ItemGroup className="gap-0">
							{inactiveMembers.map((member) => (
								<Item key={member.id} size="sm" className="min-h-[44px] opacity-70">
									<ItemMedia>
										<MemberAvatar name={member.name} size={26} />
									</ItemMedia>
									<ItemContent className="min-w-[8ch] basis-[8ch]">
										<ItemTitle className="line-clamp-none [overflow-wrap:break-word]">
											{member.name}
										</ItemTitle>
										<ItemDescription className="line-clamp-none [overflow-wrap:break-word]">
											{member.hasAccount === false
												? 'Ausgezogen, kein Konto verknüpft'
												: 'Ausgezogen, Verlauf bleibt erhalten'}
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
												aria-label={`Aktivieren: ${member.name}`}
											>
												{reactivatingId === member.id ? (
													<Spinner aria-hidden />
												) : (
													<UserPlus aria-hidden />
												)}
												Aktivieren
											</Button>
										)}
									</ItemActions>
								</Item>
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
						<AlertDialogTitle>Admin-Rolle übergeben?</AlertDialogTitle>
						<AlertDialogDescription>
							{memberToPromote?.name} wird Admin dieser WG. Du wirst normales Mitglied und kannst
							die Rolle nur zurückbekommen, wenn {memberToPromote?.name} sie dir übergibt.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{promoteError && (
						<Alert variant="destructive">
							<AlertDescription>{promoteError}</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={promoting}>Abbrechen</AlertDialogCancel>
						<Button
							onClick={(event) => {
								event.preventDefault();
								void handleTransferAdmin();
							}}
							disabled={promoting}
						>
							{promoting && <Spinner aria-hidden />}
							Übergeben
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
						<AlertDialogTitle>{memberToReactivate?.name} trotzdem aktivieren?</AlertDialogTitle>
						<AlertDialogDescription>
							{memberToReactivate?.name} hat kein verknüpftes Konto (zum Beispiel weil das Konto
							gelöscht wurde) und kann sich nicht anmelden. Die Person erscheint dann wieder in
							Aufteilungen und im Putzplan.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Abbrechen</AlertDialogCancel>
						<Button
							onClick={() => {
								const target = memberToReactivate;
								setMemberToReactivate(null);
								if (target) void handleReactivate(target);
							}}
						>
							Aktivieren
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
