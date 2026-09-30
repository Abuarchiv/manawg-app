'use client';

import { Switch } from '@/components/animate-ui/components/base/switch';
import { SocialLoginButtons, type SocialProvider } from '@/components/auth/SocialLoginButtons';
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
	Field,
	FieldContent,
	FieldDescription,
	FieldLabel,
	FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { MemberDeactivateDialog } from '@/components/wg/MemberDeactivateDialog';
import { ShareWgCard } from '@/components/wg/ShareWgCard';
import type { Member, WgSummary } from '@/components/wg/WgContextProvider';
import { useWg } from '@/components/wg/WgContextProvider';
import { AccountDeleteSection } from '@/components/wg/einstellungen/AccountDeleteSection';
import { Section } from '@/components/wg/einstellungen/Section';
import {
	accessErrorMessage,
	deleteWgErrorMessage,
	readResponseErrorCode,
} from '@/core/guards/settings-errors';
import { apiFetch } from '@/core/infra/api-client';
import { buildSecurityOverview } from '@/core/infra/security';
import type { StoredIdentity } from '@/shared/lib/identity';
import { clearIdentity, forgetWg, memberAuthHeader } from '@/shared/lib/identity';
import { LogOut, Trash2, UserMinus, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface AccessTabProps {
	wg: WgSummary;
	members: Member[];
	identity: StoredIdentity;
}

async function linkSocialIdentity(provider: SocialProvider, next: string): Promise<void> {
	const { linkSocialIdentity } = await import('@/core/auth/client');
	await linkSocialIdentity(provider, next);
}

export function AccessTab({ wg, members, identity }: AccessTabProps) {
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const router = useRouter();
	const { refreshMembers, isAdmin } = useWg();
	const [joiningEnabled, setJoiningEnabled] = useState(wg.joiningEnabled);

	useEffect(() => {
		setJoiningEnabled(wg.joiningEnabled);
	}, [wg.joiningEnabled]);
	const [accessPending, setAccessPending] = useState<'join' | 'rotate' | null>(null);
	const [accessMessage, setAccessMessage] = useState<string | null>(null);
	const [accessError, setAccessError] = useState<string | null>(null);
	const [rotateConfirm, setRotateConfirm] = useState(false);
	const [accountSignOutPending, setAccountSignOutPending] = useState(false);
	const [accountSignOutError, setAccountSignOutError] = useState<string | null>(null);
	const [deleteStage, setDeleteStage] = useState<'idle' | 'confirm' | 'pending'>('idle');
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [confirmText, setConfirmText] = useState('');
	const [memberToDeactivate, setMemberToDeactivate] = useState<{
		id: string;
		name: string;
		selfLeave?: boolean;
	} | null>(null);
	const [reactivatingId, setReactivatingId] = useState<string | null>(null);
	const [memberActionMessage, setMemberActionMessage] = useState<string | null>(null);
	const [memberActionError, setMemberActionError] = useState<string | null>(null);
	const accessPendingRef = useRef(false);
	const activeMembers = members.filter((m) => m.active);
	const inactiveMembers = members.filter((m) => !m.active);

	function handleMemberDeactivated(name: string): void {
		if (memberToDeactivate?.id === identity.memberId) {
			clearIdentity(wg.id);
			forgetWg(wg.shareCode);
			router.push('/');
			return;
		}
		setMemberActionError(null);
		setMemberActionMessage(`${name} ist jetzt als ausgezogen markiert.`);
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
				memberToken: identity.memberToken,
				body: JSON.stringify({ active: true }),
			},
		);
		if (res.ok) {
			setMemberActionMessage(`${member.name} ist wieder aktiv.`);
			void refreshMembers(identity.memberId);
		} else {
			setMemberActionError('Aktivierung konnte nicht gespeichert werden. Bitte erneut versuchen.');
		}
		setReactivatingId(null);
	}
	const securityOverview = buildSecurityOverview({
		memberName: identity.name,
		memberCount: members.length,
		joiningEnabled,
		shareCodeRotatedAt: wg.shareCodeRotatedAt ?? null,
	});

	async function handleAccountSignOut(): Promise<void> {
		if (accountSignOutPending) return;
		setAccountSignOutPending(true);
		setAccountSignOutError(null);
		try {
			const { signOutSocialAccount } = await import('@/core/auth/client');
			const { pushCleanup } = await signOutSocialAccount([
				{
					code: wg.shareCode,
					memberId: identity.memberId,
					...(identity.memberToken ? { memberToken: identity.memberToken } : {}),
				},
			]);
			clearIdentity(wg.id);
			forgetWg(wg.shareCode);
			if (pushCleanup === 'failed') {
				window.alert(
					'Du bist abgemeldet, aber Push konnte auf diesem Browser nicht sicher beendet werden. Deaktiviere Website-Benachrichtigungen in den Browsereinstellungen.',
				);
			}
			router.push('/');
		} catch {
			setAccountSignOutError('Konto konnte nicht abgemeldet werden. Bitte erneut versuchen.');
		} finally {
			setAccountSignOutPending(false);
		}
	}

	function openLeaveConfirm(): void {
		if (isAdmin || activeMembers.length <= 1) return;
		setMemberToDeactivate({ id: identity.memberId, name: identity.name, selfLeave: true });
		setDeleteStage('idle');
		setDeleteError(null);
		setConfirmText('');
	}

	function openDeleteConfirm(): void {
		if (!isAdmin) return;
		setMemberToDeactivate(null);
		setDeleteStage('confirm');
		setDeleteError(null);
		setConfirmText('');
	}

	async function handleDelete(): Promise<void> {
		if (!isAdmin) return;
		setDeleteStage('pending');
		setDeleteError(null);
		try {
			const res = await fetch(`/api/wg/${encodedShareCode}`, {
				method: 'DELETE',
				headers: memberAuthHeader(identity.memberId, identity.memberToken),
			});
			if (res.status === 403) {
				const errorCode = await readResponseErrorCode(res);
				setDeleteError(
					errorCode === 'member_not_verified'
						? 'Dein Gerät ist noch nicht bestätigt. Lade die App neu und versuche es erneut.'
						: 'Nur Admins können die WG löschen.',
				);
				setDeleteStage('confirm');
				return;
			}
			if (!res.ok) {
				setDeleteError(deleteWgErrorMessage(res.status, await readResponseErrorCode(res)));
				setDeleteStage('confirm');
				return;
			}
			clearIdentity(wg.id);
			forgetWg(wg.shareCode);
			router.push('/');
		} catch {
			setDeleteError(
				'WG konnte nicht gelöscht werden: Prüfe deine Verbindung und versuche es erneut.',
			);
			setDeleteStage('confirm');
		}
	}

	async function updateAccess(body: {
		joiningEnabled?: boolean;
		rotateShareCode?: boolean;
	}): Promise<{ wg: WgSummary } | null> {
		if (!isAdmin) return null;
		setAccessError(null);
		setAccessMessage(null);
		try {
			const res = await fetch(`/api/wg/${encodedShareCode}`, {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...memberAuthHeader(identity.memberId, identity.memberToken),
				},
				body: JSON.stringify(body),
			});
			if (res.status === 403) {
				const errorCode = await readResponseErrorCode(res);
				setAccessError(
					errorCode === 'member_not_verified'
						? 'Dein Gerät ist noch nicht bestätigt. Lade die App neu und versuche es erneut.'
						: 'Nur Admins können den WG-Zugang ändern.',
				);
				return null;
			}
			if (!res.ok) {
				setAccessError(accessErrorMessage(res.status, await readResponseErrorCode(res)));
				return null;
			}
			return (await res.json()) as { wg: WgSummary };
		} catch {
			setAccessError(
				'Zugang konnte nicht geändert werden: Prüfe deine Verbindung und versuche es erneut.',
			);
			return null;
		}
	}

	async function toggleJoining(): Promise<void> {
		if (!isAdmin || accessPendingRef.current) return;
		accessPendingRef.current = true;
		setAccessPending('join');
		setRotateConfirm(false);
		const next = !joiningEnabled;
		// Optimistisch umschalten, damit der Thumb sofort gleitet; bei Fehler zurück.
		setJoiningEnabled(next);
		try {
			const data = await updateAccess({ joiningEnabled: next });
			if (!data) {
				setJoiningEnabled(!next);
				return;
			}
			setJoiningEnabled(data.wg.joiningEnabled);
			setAccessMessage(
				next ? 'Neue Beitritte sind wieder erlaubt.' : 'Neue Beitritte sind gesperrt.',
			);
		} finally {
			accessPendingRef.current = false;
			setAccessPending(null);
		}
	}

	async function rotateShareCode(): Promise<void> {
		if (!isAdmin) return;
		if (!rotateConfirm) {
			setRotateConfirm(true);
			setAccessError(null);
			setAccessMessage('Klicke erneut auf Bestätigen, um den WG-Code zu erneuern.');
			return;
		}
		if (accessPendingRef.current) return;
		accessPendingRef.current = true;
		setAccessPending('rotate');
		try {
			const data = await updateAccess({ rotateShareCode: true });
			if (!data) return;
			setRotateConfirm(false);
			setJoiningEnabled(data.wg.joiningEnabled);
			router.replace(`/wg/${encodeURIComponent(data.wg.shareCode)}/einstellungen`);
		} finally {
			accessPendingRef.current = false;
			setAccessPending(null);
		}
	}

	function cancelRotateConfirm(): void {
		setRotateConfirm(false);
		setAccessError(null);
		setAccessMessage(null);
	}

	return (
		<>
			<Section
				title="WG teilen"
				hint={
					joiningEnabled
						? 'Code oder QR führen neue Mitbewohner zum Beitrittsflow.'
						: 'Beitritte sind gesperrt. Teilen wird blockiert, bis du den Zugang öffnest.'
				}
			>
				{/* ShareWgCard already centres QR and aligns copy buttons */}
				<div className="p-3">
					<ShareWgCard
						wgName={wg.name}
						shareCode={wg.shareCode}
						hideHeader
						joiningEnabled={joiningEnabled}
					/>
				</div>
			</Section>

			<Section
				title="Anmeldemethoden"
				hint="Verknüpfe einen weiteren Anbieter, damit dein Zugang auch bei Gerätewechsel erhalten bleibt."
			>
				<div className="p-3">
					<SocialLoginButtons
						variant="link"
						next={`/wg/${encodedShareCode}/einstellungen#zugang`}
						onOAuthStart={linkSocialIdentity}
					/>
				</div>
			</Section>

			<Section
				title="Zugang"
				hint={
					isAdmin
						? 'Steuert, ob der aktuelle WG-Code neue Mitglieder aufnehmen darf.'
						: 'Nur Admins können den WG-Code verwalten.'
				}
			>
				<div className="grid gap-3 p-3">
					<Field orientation="horizontal" className="min-h-[44px]">
						<FieldContent className="min-w-0">
							<FieldTitle>Neue Beitritte</FieldTitle>
							<FieldDescription>
								{accessPending === 'join'
									? 'Wird gespeichert…'
									: joiningEnabled
										? 'Mit Code können neue Personen beitreten.'
										: 'Der Code ist für neue Beitritte gesperrt.'}
							</FieldDescription>
						</FieldContent>
						<Switch
							checked={joiningEnabled}
							disabled={!isAdmin || accessPending !== null}
							aria-busy={accessPending === 'join'}
							aria-label={joiningEnabled ? 'Neue Beitritte sperren' : 'Neue Beitritte erlauben'}
							onCheckedChange={() => void toggleJoining()}
						/>
					</Field>
					<div className="border-border border-t pt-2">
						<div className="flex min-h-[44px] flex-wrap items-center justify-between gap-3">
							<div className="min-w-0 flex-1 basis-40">
								<div className="text-foreground text-sm font-medium">WG-Code erneuern</div>
								<div className="text-muted-foreground mt-0.5 text-xs">
									Alte Links funktionieren danach nicht mehr.
								</div>
							</div>
							{rotateConfirm ? (
								<div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
									<Button
										type="button"
										variant="ghost"
										onClick={cancelRotateConfirm}
										disabled={accessPending !== null}
										aria-label="Abbrechen: WG-Code-Erneuerung"
										className="shrink-0 px-2.5"
									>
										Abbrechen
									</Button>
									<Button
										type="button"
										variant="destructive"
										onClick={() => void rotateShareCode()}
										disabled={!isAdmin || accessPending !== null}
										aria-label="Bestätigen: WG-Code-Erneuerung"
										className="shrink-0 px-2.5"
									>
										{accessPending === 'rotate' ? (
											<>
												<Spinner aria-hidden />
												Speichert…
											</>
										) : (
											'Bestätigen'
										)}
									</Button>
								</div>
							) : (
								<Button
									type="button"
									variant="outline"
									onClick={() => void rotateShareCode()}
									disabled={!isAdmin || accessPending !== null}
									aria-label="Erneuern: WG-Code"
									className="shrink-0"
								>
									Erneuern
								</Button>
							)}
						</div>
					</div>
					{accessMessage && (
						<Alert>
							<AlertDescription>{accessMessage}</AlertDescription>
						</Alert>
					)}
					{accessError && (
						<Alert variant="destructive">
							<AlertDescription>{accessError}</AlertDescription>
						</Alert>
					)}
				</div>
			</Section>

			<Section
				title="Sicherheit & Vertrauen"
				hint="Schneller Überblick, wer drin ist und wie offen der WG-Code ist."
			>
				<div className="grid grid-cols-2 gap-3 p-3">
					{securityOverview.map((item) => (
						<div key={item.label} className="min-w-0">
							<p className="text-muted-foreground text-xs">{item.label}</p>
							<p className="text-foreground mt-0.5 text-[12px] font-medium">{item.value}</p>
						</div>
					))}
				</div>
				<Separator />
				<ItemGroup className="gap-0 px-2 py-1">
					{activeMembers.map((member) => (
						<Item key={member.id} size="sm" className="min-h-[44px]">
							<ItemMedia>
								<MemberAvatar name={member.name} size={26} />
							</ItemMedia>
							<ItemContent className="min-w-0">
								<ItemTitle>{member.name}</ItemTitle>
							</ItemContent>
							<ItemActions>
								{member.id === identity.memberId ? (
									<Badge variant="secondary">Du</Badge>
								) : (
									isAdmin && (
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => setMemberToDeactivate({ id: member.id, name: member.name })}
											aria-label={`Ausziehen: ${member.name}`}
										>
											<UserMinus aria-hidden />
											Ausziehen
										</Button>
									)
								)}
							</ItemActions>
						</Item>
					))}
				</ItemGroup>
				{inactiveMembers.length > 0 && (
					<div className="px-4 pt-2 pb-1">
						<p className="text-muted-foreground px-0.5 pb-1 text-xs font-medium tracking-wide uppercase">
							Ausgezogen
						</p>
						<ItemGroup className="gap-0">
							{inactiveMembers.map((member) => (
								<Item key={member.id} size="sm" className="min-h-[44px] opacity-70">
									<ItemMedia>
										<MemberAvatar name={member.name} size={26} />
									</ItemMedia>
									<ItemContent className="min-w-0">
										<ItemTitle>{member.name}</ItemTitle>
										<ItemDescription>Ausgezogen, Verlauf bleibt erhalten</ItemDescription>
									</ItemContent>
									<ItemActions>
										{isAdmin && (
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => void handleReactivate({ id: member.id, name: member.name })}
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
					<div className="px-4 pb-3">
						<Alert>
							<AlertDescription>{memberActionMessage}</AlertDescription>
						</Alert>
					</div>
				)}
				{memberActionError && (
					<div className="px-4 pb-3">
						<Alert variant="destructive">
							<AlertDescription>{memberActionError}</AlertDescription>
						</Alert>
					</div>
				)}
			</Section>

			<Section
				title="Konto abmelden"
				hint="Meldet dein Konto auf diesem Gerät ab. WG-Mitgliedschaft und Daten bleiben erhalten."
			>
				<div className="p-3">
					<Button
						type="button"
						variant="outline"
						onClick={() => void handleAccountSignOut()}
						disabled={accountSignOutPending}
						aria-label="Konto abmelden"
						className="w-full"
					>
						{accountSignOutPending ? <Spinner aria-hidden /> : <LogOut aria-hidden />}
						{accountSignOutPending ? 'Melde ab…' : 'Konto abmelden'}
					</Button>
					{accountSignOutError && (
						<Alert variant="destructive" className="mt-2">
							<AlertDescription>{accountSignOutError}</AlertDescription>
						</Alert>
					)}
				</div>
			</Section>

			<div className="grid gap-3">
				<div className="px-1">
					<h2 className="text-destructive text-[12px] font-semibold">Gefahrenzone</h2>
					<p className="text-muted-foreground mt-0.5 text-xs">
						WG verlassen, WG löschen oder Konto löschen.
					</p>
				</div>

				<Section
					title="WG verlassen"
					hint={
						isAdmin
							? 'Admins können ihre Mitgliedschaft derzeit nicht beenden.'
							: 'Deaktiviert deine Mitgliedschaft. Einträge und offene Salden bleiben erhalten.'
					}
				>
					<div className="grid gap-3 p-3">
						{isAdmin ? (
							<p className="text-muted-foreground text-[12px]">
								Admins können ihre Mitgliedschaft derzeit nicht beenden, weil die Admin-Rolle nicht
								übertragen werden kann.
							</p>
						) : activeMembers.length <= 1 ? (
							<p className="text-muted-foreground text-[12px]">
								Du bist das letzte aktive Mitglied. Die WG kann erst verlassen werden, wenn ein
								weiteres Mitglied aktiv ist. Wenn du nur dieses Gerät abmelden möchtest, nutze oben
								„Konto abmelden“.
							</p>
						) : (
							<Button
								type="button"
								variant="destructive"
								onClick={openLeaveConfirm}
								className="w-full"
							>
								<LogOut aria-hidden />
								WG verlassen
							</Button>
						)}
					</div>
				</Section>

				<Section
					title="WG dauerhaft löschen"
					hint={
						isAdmin
							? 'Entfernt die gesamte WG und alle Daten (Ausgaben, Listen, Pinnwand) unwiderruflich für alle Mitglieder.'
							: 'Nur Admins können die WG löschen.'
					}
				>
					<div className="p-3">
						<Button
							type="button"
							variant="destructive"
							onClick={openDeleteConfirm}
							disabled={!isAdmin}
							className="w-full"
						>
							<Trash2 aria-hidden />
							Komplette WG für alle löschen
						</Button>
					</div>
				</Section>

				<AccountDeleteSection />
			</div>

			<AlertDialog
				open={deleteStage !== 'idle'}
				onOpenChange={(open) => {
					if (!open && deleteStage !== 'pending') {
						setDeleteStage('idle');
						setDeleteError(null);
						setConfirmText('');
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia>
							<Trash2 aria-hidden />
						</AlertDialogMedia>
						<AlertDialogTitle>WG dauerhaft löschen?</AlertDialogTitle>
						<AlertDialogDescription>
							Diese Aktion löscht die WG {wg.name} für alle Mitglieder unwiderruflich. Tippe zur
							Bestätigung den WG-Code {wg.shareCode}.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<Field>
						<FieldLabel htmlFor="delete-wg-confirm">WG-Code zur Bestätigung</FieldLabel>
						<Input
							id="delete-wg-confirm"
							type="text"
							value={confirmText}
							onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
							placeholder={wg.shareCode}
							aria-describedby="delete-wg-confirm-hint"
							disabled={deleteStage === 'pending'}
							className="text-center font-mono text-base tracking-[0.18em]"
							autoComplete="off"
						/>
						<FieldDescription id="delete-wg-confirm-hint">
							Groß-/Kleinschreibung wird automatisch angeglichen.
						</FieldDescription>
					</Field>
					{deleteError && (
						<Alert variant="destructive">
							<AlertDescription>{deleteError}</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deleteStage === 'pending'}>Abbrechen</AlertDialogCancel>
						<Button
							variant="destructive"
							onClick={(event) => {
								event.preventDefault();
								void handleDelete();
							}}
							disabled={deleteStage === 'pending' || confirmText !== wg.shareCode}
						>
							{deleteStage === 'pending' ? <Spinner aria-hidden /> : <Trash2 aria-hidden />}
							Endgültig löschen
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{memberToDeactivate && (
				<MemberDeactivateDialog
					encodedShareCode={encodedShareCode}
					member={memberToDeactivate}
					selfLeave={memberToDeactivate.selfLeave}
					viewerMemberId={identity.memberId}
					viewerMemberToken={identity.memberToken}
					onClose={() => setMemberToDeactivate(null)}
					onDeactivated={handleMemberDeactivated}
				/>
			)}
		</>
	);
}
