'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { PAYPAL_PAYMENT_PENDING_MESSAGE } from '@/components/wg/einstellungen/settings-errors';
import { RATE_LIMITED_MESSAGE, isRateLimited } from '@/core/http/error-codes';
import { apiFetch } from '@/core/infra/api-client';
import { formatEuroCents } from '@/core/utils/money';
import { TriangleAlert as AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** One open debt of the member being moved out, from their own perspective. */
interface OpenBalanceDto {
	member_id: string;
	name: string;
	amount_cents: number;
	currency: string;
	direction: 'owes' | 'owed';
}

interface MemberDeactivateResponse {
	member: { id: string; name: string; active: boolean };
}

interface OpenBalancesResponse {
	member: { id: string; name: string; active: boolean };
	openBalances: OpenBalanceDto[];
}

interface MemberDeactivateDialogProps {
	/** Already URL-encoded WG share code. */
	encodedShareCode: string;
	member: { id: string; name: string };
	/** Identity of the device performing the action (for the member-id header). */
	viewerMemberId: string;
	/** Use the same balance review for a member leaving their own WG. */
	selfLeave?: boolean | undefined;
	onClose: () => void;
	onDeactivated: (name: string) => void;
}

/**
 * Confirmation dialog for marking a member as moved out ("Auszug").
 *
 * On open it fetches the member's open balances and lists them as a warning.
 * The move-out is never blocked by open balances — the decision is "erlauben,
 * aber warnen": we surface the money that would be left hanging and let the
 * user proceed anyway. Deactivation is reversible, so this is not destructive.
 */
export function MemberDeactivateDialog({
	encodedShareCode,
	member,
	viewerMemberId,
	selfLeave = false,
	onClose,
	onDeactivated,
}: MemberDeactivateDialogProps) {
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [openBalances, setOpenBalances] = useState<OpenBalanceDto[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const submittingRef = useRef(false);

	// Load the open balances once per opened member.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setLoadError(null);
		async function loadOpenBalances(): Promise<void> {
			try {
				const res = await apiFetch<OpenBalancesResponse>(
					`/api/wg/${encodedShareCode}/members/${member.id}`,
					{ memberId: viewerMemberId },
				);
				if (cancelled) return;
				if (res.ok) {
					setOpenBalances(res.data.openBalances);
				} else {
					setLoadError('Offene Salden konnten nicht geladen werden.');
				}
			} catch {
				if (!cancelled) setLoadError('Offene Salden konnten nicht geladen werden.');
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		void loadOpenBalances();
		return () => {
			cancelled = true;
		};
	}, [encodedShareCode, member.id, viewerMemberId]);

	async function handleConfirm(): Promise<void> {
		if (submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		setSubmitError(null);
		const res = await apiFetch<MemberDeactivateResponse>(
			`/api/wg/${encodedShareCode}/members/${member.id}`,
			{
				method: 'PATCH',
				memberId: viewerMemberId,
				body: JSON.stringify({ active: false }),
			},
		);
		if (res.ok) {
			onDeactivated(res.data.member.name);
			onClose();
			return;
		}
		if (res.error === 'admin_required') {
			setSubmitError(
				selfLeave
					? 'Übergib zuerst die Admin-Rolle an ein aktives Mitglied, dann kannst du die WG verlassen. Wenn du nur dieses Gerät abmelden möchtest, nutze oben „Konto abmelden“.'
					: 'Nur aktive Admin-Mitglieder können andere Mitglieder deaktivieren. Admin-Mitgliedschaften selbst können nicht deaktiviert werden. Bitte wende dich an ein aktives Admin-Mitglied.',
			);
			submittingRef.current = false;
			setSubmitting(false);
			return;
		}
		setSubmitError(
			isRateLimited(res.error, res.status)
				? RATE_LIMITED_MESSAGE
				: res.error === 'paypal_payment_pending'
					? PAYPAL_PAYMENT_PENDING_MESSAGE
					: selfLeave
						? 'WG konnte nicht verlassen werden. Deine Mitgliedschaft bleibt bestehen. Bitte versuche es erneut.'
						: 'Auszug konnte nicht gespeichert werden. Bitte versuche es erneut.',
		);
		submittingRef.current = false;
		setSubmitting(false);
	}

	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open && !submitting) onClose();
			}}
		>
			<AlertDialogContent size="default">
				<AlertDialogHeader>
					<AlertDialogMedia>
						<AlertTriangle aria-hidden />
					</AlertDialogMedia>
					<AlertDialogTitle>
						{selfLeave ? 'Wirklich verlassen?' : `${member.name} ausziehen?`}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{selfLeave
							? 'Deine Mitgliedschaft in dieser WG wird deaktiviert. Deine Einträge und offenen Salden bleiben erhalten. Ein aktives Admin-Mitglied mit der nötigen Berechtigung kann dich später wieder aktivieren.'
							: `${member.name} verliert den Zugriff auf diese WG. Historie und offene Salden bleiben erhalten. Ein aktives Admin-Mitglied kann den Zugang später wieder aktivieren.`}
					</AlertDialogDescription>
				</AlertDialogHeader>

				<div className="grid gap-2">
					{loading ? (
						<p className="text-muted-foreground flex min-h-[44px] items-center gap-2 text-meta">
							<Spinner aria-hidden />
							Offene Salden werden geprüft …
						</p>
					) : loadError ? (
						<Alert>
							<AlertDescription>
								{loadError}{' '}
								{selfLeave
									? 'Das Verlassen ist trotzdem möglich.'
									: 'Der Auszug ist trotzdem möglich.'}
							</AlertDescription>
						</Alert>
					) : openBalances.length === 0 ? (
						<p className="text-muted-foreground text-meta">Keine offenen Salden.</p>
					) : (
						<Alert>
							<AlertTitle>
								Offene Salden bleiben nach {selfLeave ? 'dem Verlassen' : 'dem Auszug'} bestehen:
							</AlertTitle>
							<AlertDescription>
								<ul className="mt-1.5 grid gap-1">
									{openBalances.map((balance) => (
										<li
											key={`${balance.currency}-${balance.direction}-${balance.member_id}`}
											className="flex items-center justify-between gap-2 text-meta"
										>
											<span className="text-muted-foreground truncate">
												{balance.direction === 'owes'
													? `Schuldet ${balance.name}`
													: `${balance.name} schuldet`}
											</span>
											<span className="text-foreground shrink-0 font-medium tabular-nums">
												{formatEuroCents(balance.amount_cents, balance.currency)}
											</span>
										</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					)}

					{submitError && (
						<Alert variant="destructive">
							<AlertDescription>{submitError}</AlertDescription>
						</Alert>
					)}
				</div>

				<AlertDialogFooter>
					<AlertDialogCancel
						disabled={submitting}
						aria-label={selfLeave ? 'Abbrechen: WG verlassen' : undefined}
					>
						Abbrechen
					</AlertDialogCancel>
					<Button
						variant="destructive"
						onClick={(event) => {
							event.preventDefault();
							void handleConfirm();
						}}
						disabled={submitting || loading}
						aria-label={selfLeave ? 'Verlassen: WG verlassen' : undefined}
					>
						{submitting && <Spinner aria-hidden />}
						{selfLeave ? 'Verlassen' : 'Ausziehen'}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
