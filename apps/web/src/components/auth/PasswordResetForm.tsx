'use client';

import { NEW_PASSWORD_MIN_LENGTH } from '@/components/auth/CredentialsAuth';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { WEAK_PASSWORD_MESSAGE, isWeakPasswordError } from '@/core/auth/password-errors';
import { cn } from '@/shared/lib/cn';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type ResetState = 'ready' | 'submitting' | 'unavailable';

interface PasswordResetFormProps {
	recoveryRequested: boolean;
}

export function PasswordResetForm({ recoveryRequested }: PasswordResetFormProps) {
	const router = useRouter();
	const [state, setState] = useState<ResetState>(recoveryRequested ? 'ready' : 'unavailable');
	const [password, setPassword] = useState('');
	const [confirmation, setConfirmation] = useState('');
	const [error, setError] = useState<string | null>(null);

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
		setError(null);
		setState('submitting');
		try {
			const { updatePassword } = await import('@/core/auth/client');
			await updatePassword(password);
			try {
				await fetch('/api/auth/recovery', { method: 'DELETE', credentials: 'same-origin' });
			} catch {
				// The marker expires quickly; a successful password update must still finish.
			}
			router.replace('/neu');
		} catch (error) {
			setError(
				isWeakPasswordError(error)
					? WEAK_PASSWORD_MESSAGE
					: 'Das Passwort konnte gerade nicht geändert werden. Bitte fordere einen neuen Link an.',
			);
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
				<Link href="/neu" className={cn(buttonVariants({ variant: 'outline' }))}>
					Neuen Link über die Anmeldung anfordern
				</Link>
			</div>
		);
	}

	return (
		<form onSubmit={(event) => void submit(event)} noValidate>
			<FieldGroup>
				<Field data-invalid={Boolean(error)}>
					<FieldLabel htmlFor="reset-password">Neues Passwort</FieldLabel>
					<Input
						id="reset-password"
						name="password"
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete="new-password"
						minLength={NEW_PASSWORD_MIN_LENGTH}
						required
						enterKeyHint="next"
						aria-describedby={error ? 'reset-password-error' : undefined}
						aria-invalid={error ? true : undefined}
						className="text-base"
					/>
				</Field>
				<Field data-invalid={Boolean(error)}>
					<FieldLabel htmlFor="reset-password-confirmation">Passwort bestätigen</FieldLabel>
					<Input
						id="reset-password-confirmation"
						name="passwordConfirmation"
						type="password"
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
						autoComplete="new-password"
						minLength={NEW_PASSWORD_MIN_LENGTH}
						required
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
	);
}
