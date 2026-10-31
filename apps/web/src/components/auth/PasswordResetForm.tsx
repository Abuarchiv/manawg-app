'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { NEW_PASSWORD_MIN_LENGTH } from '@/components/auth/auth-form-shared';
import { PasswordResetRequest } from '@/components/auth/PasswordResetRequest';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/Toast';
import {
	isSamePasswordError,
	isWeakPasswordError,
	WEAK_PASSWORD_MESSAGE,
} from '@/core/auth/password-errors';
import { useMessage } from '@/shared/i18n/message';
import { cn } from '@/shared/lib/cn';

type ResetState = 'ready' | 'submitting' | 'unavailable';

interface PasswordResetFormProps {
	recoveryRequested: boolean;
}

export function PasswordResetForm({ recoveryRequested }: PasswordResetFormProps) {
	const t = useTranslations('auth');
	const message = useMessage();
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
					? t('reset.tooShort', { min: NEW_PASSWORD_MIN_LENGTH })
					: t('mismatch'),
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
			toast.success(t('reset.saved'));
			router.replace('/login');
		} catch (error) {
			if (isWeakPasswordError(error)) setError(message(WEAK_PASSWORD_MESSAGE));
			// Supabase rejects reusing the current password; a new link would not change that.
			else if (isSamePasswordError(error)) {
				setError(t('reset.same'));
			} else {
				setServerError(t('reset.failed'));
			}
			setState('ready');
		}
	}

	if (state === 'unavailable') {
		return (
			<div className="flex flex-col gap-4">
				<Alert variant="destructive">
					<AlertDescription>{t('reset.invalidLink')}</AlertDescription>
				</Alert>
				<PasswordResetRequest />
				<Link href="/login" className={cn(buttonVariants({ variant: 'ghost' }))}>
					{t('reset.back')}
				</Link>
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
					<PasswordResetRequest />
				</>
			)}
			<form method="post" onSubmit={(event) => void submit(event)} noValidate>
				<FieldGroup>
					<Field data-invalid={Boolean(error)}>
						<FieldLabel htmlFor="reset-password">{t('fields.newPassword')}</FieldLabel>
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
						<FieldDescription id="reset-password-hint">
							{t('reset.hint', { min: NEW_PASSWORD_MIN_LENGTH })}
						</FieldDescription>
					</Field>
					<Field data-invalid={Boolean(error)}>
						<FieldLabel htmlFor="reset-password-confirmation">
							{t('fields.confirmPassword')}
						</FieldLabel>
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
						{state === 'submitting' ? t('reset.saving') : t('reset.save')}
					</Button>
				</FieldGroup>
			</form>
		</div>
	);
}
