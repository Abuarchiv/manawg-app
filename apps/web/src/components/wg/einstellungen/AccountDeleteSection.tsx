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
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Section } from '@/components/wg/einstellungen/Section';
import {
	PAYPAL_PAYMENT_PENDING_MESSAGE,
	readResponseErrorCode,
} from '@/components/wg/einstellungen/settings-errors';
import { RATE_LIMITED_MESSAGE } from '@/core/http/error-codes';
import { UserX } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const CONFIRM_WORD = 'LÖSCHEN';
const SIGN_IN_AGAIN_MESSAGE = 'Melde dich erneut an, um dein Konto zu löschen.';
const UNKNOWN_DELETE_OUTCOME_MESSAGE =
	'Der Server kann den Status nicht bestätigen. Warte kurz und versuche es erneut; ein bereits angenommener Auftrag wird serverseitig fortgesetzt.';

export function AccountDeleteSection() {
	const [stage, setStage] = useState<'idle' | 'confirm' | 'pending'>('idle');
	const [confirmText, setConfirmText] = useState('');
	const [error, setError] = useState<string | null>(null);
	// Focus the cancel button so iOS does not open the keyboard unprompted.
	const cancelRef = useRef<HTMLButtonElement>(null);

	// With large text the message lies below the visible dialog area.
	useEffect(() => {
		if (error)
			document.getElementById('delete-account-error')?.scrollIntoView({ block: 'nearest' });
	}, [error]);

	async function handleDelete(): Promise<void> {
		setStage('pending');
		setError(null);
		try {
			const res = await fetch('/api/account', { method: 'DELETE' });
			if (res.status === 503) {
				const result = await res.json().catch(() => null);
				if (
					result?.status === 'unknown' &&
					result?.error === 'account_deletion_outcome_unconfirmed'
				) {
					setError(UNKNOWN_DELETE_OUTCOME_MESSAGE);
					setStage('confirm');
					return;
				}
			}
			if (res.status === 401) {
				setError(SIGN_IN_AGAIN_MESSAGE);
				setStage('confirm');
				return;
			}
			if (res.status === 429) {
				setError(RATE_LIMITED_MESSAGE);
				setStage('confirm');
				return;
			}
			if (res.status === 409 && (await readResponseErrorCode(res)) === 'paypal_payment_pending') {
				setError(PAYPAL_PAYMENT_PENDING_MESSAGE);
				setStage('confirm');
				return;
			}
			if (res.status !== 200 && res.status !== 202) {
				setError('Konto konnte nicht gelöscht werden. Bitte versuche es später erneut.');
				setStage('confirm');
				return;
			}
			const pending = res.status === 202;
			try {
				const { clearLocalAccountData, signOutSocialAccount } = await import('@/core/auth/client');
				await signOutSocialAccount().catch(() => {
					// The server already removed WG access; a stale local session is harmless.
				});
				await clearLocalAccountData();
			} catch {
				// Browser storage failure does not change the server's accepted deletion.
			}
			window.location.assign(pending ? '/?accountDeletion=pending' : '/');
		} catch {
			setError(UNKNOWN_DELETE_OUTCOME_MESSAGE);
			setStage('confirm');
		}
	}

	const armed = confirmText === CONFIRM_WORD;

	const trigger = (
		<Button
			type="button"
			variant="destructive"
			onClick={() => {
				setStage('confirm');
				setConfirmText('');
				setError(null);
			}}
			className="w-full"
		>
			<UserX aria-hidden />
			Konto dauerhaft löschen
		</Button>
	);

	return (
		<>
			<Section
				title="Konto löschen"
				hint="Löscht dein Konto und deine Anmeldedaten. In jeder WG ziehst du aus; Einträge und offene Salden bleiben für die anderen erhalten."
			>
				<div className="p-3">{trigger}</div>
			</Section>

			<AlertDialog
				open={stage !== 'idle'}
				onOpenChange={(open) => {
					if (!open && stage !== 'pending') setStage('idle');
				}}
			>
				<AlertDialogContent initialFocus={cancelRef}>
					<AlertDialogHeader>
						<AlertDialogMedia>
							<UserX aria-hidden />
						</AlertDialogMedia>
						<AlertDialogTitle>Konto dauerhaft löschen?</AlertDialogTitle>
						<AlertDialogDescription>
							Du wirst aus allen WGs ausgetragen. Bist du Admin, übernimmt das am längsten aktive
							Mitglied. WGs, in denen du allein bist, werden komplett gelöscht. Das lässt sich nicht
							rückgängig machen.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<Field>
						<FieldLabel htmlFor="delete-account-confirm">Tippe {CONFIRM_WORD}</FieldLabel>
						<Input
							id="delete-account-confirm"
							type="text"
							value={confirmText}
							onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
							placeholder={CONFIRM_WORD}
							aria-describedby="delete-account-confirm-hint"
							disabled={stage === 'pending'}
							className="text-center font-mono text-base tracking-[0.18em]"
							autoComplete="off"
						/>
						<FieldDescription id="delete-account-confirm-hint">
							Exportiere vorher bei Bedarf deine WG-Daten unter „Daten“.
						</FieldDescription>
					</Field>
					{error && (
						<Alert variant="destructive" id="delete-account-error">
							<AlertDescription>
								<div>{error}</div>
								{error === SIGN_IN_AGAIN_MESSAGE && (
									<Button
										variant="outline"
										size="sm"
										className="mt-2 no-underline!"
										render={<Link href="/neu" />}
										nativeButton={false}
									>
										Erneut anmelden
									</Button>
								)}
							</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel ref={cancelRef} disabled={stage === 'pending'}>
							Abbrechen
						</AlertDialogCancel>
						<Button
							variant="destructive"
							className={
								armed
									? 'bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive dark:text-background dark:hover:bg-destructive/90'
									: undefined
							}
							onClick={(event) => {
								event.preventDefault();
								void handleDelete();
							}}
							disabled={stage === 'pending' || !armed}
						>
							{stage === 'pending' ? <Spinner aria-hidden /> : <UserX aria-hidden />}
							Konto löschen
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
