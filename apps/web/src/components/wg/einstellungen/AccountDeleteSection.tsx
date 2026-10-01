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
import { UserX } from 'lucide-react';
import { useState } from 'react';

const CONFIRM_WORD = 'LÖSCHEN';
const UNKNOWN_DELETE_OUTCOME_MESSAGE =
	'Der Server kann den Status nicht bestätigen. Warte kurz und versuche es erneut; ein bereits angenommener Auftrag wird serverseitig fortgesetzt.';

export function AccountDeleteSection() {
	const [stage, setStage] = useState<'idle' | 'confirm' | 'pending'>('idle');
	const [confirmText, setConfirmText] = useState('');
	const [error, setError] = useState<string | null>(null);

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
				setError('Melde dich erneut an, um dein Konto zu löschen.');
				setStage('confirm');
				return;
			}
			if (res.status !== 200 && res.status !== 202) {
				setError('Konto konnte nicht gelöscht werden. Bitte später erneut versuchen.');
				setStage('confirm');
				return;
			}
			const pending = res.status === 202;
			try {
				const { signOutSocialAccount } = await import('@/core/auth/client');
				await signOutSocialAccount();
			} catch {
				// The server already removed WG access; a stale local session is harmless.
			}
			try {
				for (const key of Object.keys(localStorage)) {
					if (key.startsWith('manawg')) localStorage.removeItem(key);
				}
			} catch {
				// Browser storage failure does not change the server's accepted deletion.
			}
			window.location.assign(pending ? '/?accountDeletion=pending' : '/');
		} catch {
			setError(UNKNOWN_DELETE_OUTCOME_MESSAGE);
			setStage('confirm');
		}
	}

	return (
		<>
			<Section
				title="Konto löschen"
				hint="Löscht dein Konto und deine Anmeldedaten. In jeder WG ziehst du aus; Einträge und offene Salden bleiben für die anderen erhalten."
			>
				<div className="p-3">
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
				</div>
			</Section>

			<AlertDialog
				open={stage !== 'idle'}
				onOpenChange={(open) => {
					if (!open && stage !== 'pending') setStage('idle');
				}}
			>
				<AlertDialogContent>
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
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={stage === 'pending'}>Abbrechen</AlertDialogCancel>
						<Button
							variant="destructive"
							onClick={(event) => {
								event.preventDefault();
								void handleDelete();
							}}
							disabled={stage === 'pending' || confirmText !== CONFIRM_WORD}
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
