'use client';

import { NEW_PASSWORD_MIN_LENGTH } from '@/components/auth/auth-form-shared';
import { useToast } from '@/components/ui/Toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
	WEAK_PASSWORD_MESSAGE,
	isSamePasswordError,
	isWeakPasswordError,
} from '@/core/auth/password-errors';
import { cn } from '@/shared/lib/cn';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type ResetState = 'ready' | 'submitting' | 'unavailable';

interface PasswordResetFormProps {
	recoveryRequested: boolean;
	/** A session exists, so /neu would show the WG picker instead of the reset-link form. */
	signedIn?: boolean;
}

/** Entry point to request a fresh reset link; signed-in users must sign out first. */
function NewLinkAction({ signedIn }: { signedIn: boolean }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	if (!signedIn) {
		return (
			<Link href="/neu" className={cn(buttonVariants({ variant: 'outline' }))}>
				Neuen Link anfordern
			</Link>
		);
	}
	async function signOutAndRestart(): Promise<void> {
		setBusy(true);
		setFailed(false);
		try {
			const { signOutSocialAccount } = await import('@/core/auth/client');
			// Known limit: no push targets, so the server drops this browser's push endpoint lazily.
			await signOutSocialAccount([]);
			router.replace('/neu');
		} catch {
			setFailed(true);
			setBusy(false);
		}
	}
	return (
		<>
			{failed && (
				<Alert variant="destructive">
					<AlertDescription>Abmelden fehlgeschlagen. Versuche es erneut.</AlertDescription>
				</Alert>
			)}
			<Button
				type="button"
				variant="outline"
				disabled={busy}
				onClick={() => void signOutAndRestart()}
			>
				{busy && <Spinner data-icon="inline-start" aria-hidden />}
				Abmelden und neuen Link anfordern
			</Button>
		</>
	);
}

export function PasswordResetForm({ recoveryRequested, signedIn = false }: PasswordResetFormProps) {
	const router = useRouter();
	const [state, setState] = useState<ResetState>(recoveryRequested ? 'ready' : 'unavailable');
	const [password, setPassword] = useState('');
	const [confirmation, setConfirmation] = useState('');
	const [error, setError] = useState<string | null>(null);
	// Server failures are not the fault of a field, so they never mark the inputs invalid.
	const [serverError, setServerError] = useState<string | null>(null);
	const toast = useToast();

	function clearErrors(): void {
		setError(null);
		setServerError(null);
	}

	useEffect(() => {
		setState((prev) =>
			prev === 'submitting' ? prev : recoveryRequested ? 'ready' : 'unavailable',
		);
	}, [recoveryRequested]);

	async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		if (
			state !== 'ready' ||
			password.length < NEW_PASSWORD_MIN_LENGTH ||
			password !== confirmation
		) {
			setError(
				password.length < NEW_PASSWORD_MIN_LENGTH
					? `Das Passwort muss mindestens ${NEW_PASSWORD_MIN_LENGTH} Zeichen lang sein.`
					: 'Die Passwörter stimmen nicht überein.',
			);
			return;
		}
		clearErrors();
		setState('submitting');
		try {
			const { updatePassword } = await import('@/core/auth/client');
			await updatePassword(password);
			try {
				await fetch('/api/auth/recovery', { method: 'DELETE', credentials: 'same-origin' });
			} catch {
				// The marker expires quickly; a successful password update must still finish.
			}
			toast.success('Passwort gespeichert.');
			router.replace('/neu');
		} catch (error) {
			if (isWeakPasswordError(error)) setError(WEAK_PASSWORD_MESSAGE);
			// Supabase rejects reusing the current password; a new link would not change that.
			else if (isSamePasswordError(error)) {
				setError('Das neue Passwort muss sich vom bisherigen unterscheiden.');
			} else {
				setServerError(
					'Das Passwort konnte gerade nicht geändert werden. Bitte fordere einen neuen Link an.',
				);
			}
			setState('ready');
		}
	}

	if (state === 'unavailable') {
		return (
			<div className="flex flex-col gap-4">
				<Alert variant="destructive">
					<AlertDescription>
						Dieser Link ist ungültig oder abgelaufen. Bitte fordere einen neuen Link an.
					</AlertDescription>
				</Alert>
				<NewLinkAction signedIn={signedIn} />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			{serverError && (
				<>
					<Alert variant="destructive">
						<AlertDescription>{serverError}</AlertDescription>
					</Alert>
					<NewLinkAction signedIn={signedIn} />
				</>
			)}
			<form onSubmit={(event) => void submit(event)} noValidate>
				<FieldGroup>
					<Field data-invalid={Boolean(error)}>
						<FieldLabel htmlFor="reset-password">Neues Passwort</FieldLabel>
						<Input
							id="reset-password"
							name="password"
							type="password"
							value={password}
							onChange={(event) => {
								setPassword(event.target.value);
								clearErrors();
							}}
							autoComplete="new-password"
							minLength={NEW_PASSWORD_MIN_LENGTH}
							required
							readOnly={state === 'submitting'}
							enterKeyHint="next"
							aria-describedby={
								error ? 'reset-password-hint reset-password-error' : 'reset-password-hint'
							}
							aria-invalid={error ? true : undefined}
							className="text-base"
						/>
						<FieldDescription id="reset-password-hint">Mindestens acht Zeichen.</FieldDescription>
					</Field>
					<Field data-invalid={Boolean(error)}>
						<FieldLabel htmlFor="reset-password-confirmation">Passwort bestätigen</FieldLabel>
						<Input
							id="reset-password-confirmation"
							name="passwordConfirmation"
							type="password"
							value={confirmation}
							onChange={(event) => {
								setConfirmation(event.target.value);
								clearErrors();
							}}
							autoComplete="new-password"
							minLength={NEW_PASSWORD_MIN_LENGTH}
							required
							readOnly={state === 'submitting'}
							enterKeyHint="done"
							aria-describedby={error ? 'reset-password-error' : undefined}
							aria-invalid={error ? true : undefined}
							className="text-base"
						/>
					</Field>
					{error && <FieldError id="reset-password-error">{error}</FieldError>}
					<Button
						type="submit"
						variant="default"
						size="lg"
						disabled={state === 'submitting'}
						className="w-full"
					>
						{state === 'submitting' && <Spinner data-icon="inline-start" aria-hidden />}
						{state === 'submitting' ? 'Passwort wird gespeichert…' : 'Passwort speichern'}
					</Button>
				</FieldGroup>
			</form>
		</div>
	);
}
