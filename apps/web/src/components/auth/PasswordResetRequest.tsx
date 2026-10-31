'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import type { AuthFailure } from '@/core/auth/password-errors';
import { classifyAuthError } from '@/core/auth/password-errors';
import { GenericAuthError, isValidEmail, normalizeEmail } from './auth-form-shared';

/** Requests a fresh reset link without leaving the reset page; the answer never reveals an account. */
export function PasswordResetRequest() {
	const t = useTranslations('auth');
	const [email, setEmail] = useState('');
	const [busy, setBusy] = useState(false);
	const [state, setState] = useState<'idle' | 'invalid' | 'sent' | 'failed'>('idle');
	const [failure, setFailure] = useState<AuthFailure>('other');

	async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		if (busy) return;
		const normalizedEmail = normalizeEmail(email);
		if (!isValidEmail(normalizedEmail)) {
			setState('invalid');
			return;
		}
		setBusy(true);
		setState('idle');
		try {
			const { requestPasswordReset } = await import('@/core/auth/client');
			await requestPasswordReset(normalizedEmail);
			setState('sent');
		} catch (error) {
			setFailure(classifyAuthError(error));
			setState('failed');
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			method="post"
			noValidate
			onSubmit={(event) => void submit(event)}
			className="flex flex-col gap-4"
		>
			<FieldGroup>
				<Field data-invalid={state === 'invalid'}>
					<FieldLabel htmlFor="reset-request-email">{t('fields.email')}</FieldLabel>
					<Input
						id="reset-request-email"
						name="email"
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						readOnly={busy}
						autoComplete="email"
						inputMode="email"
						enterKeyHint="go"
						required
						aria-invalid={state === 'invalid' || undefined}
						aria-describedby={state === 'invalid' ? 'reset-request-error' : undefined}
						className="text-base"
					/>
				</Field>
				{state === 'invalid' && (
					<p id="reset-request-error" role="alert" className="text-sm text-destructive">
						{t('validEmail')}
					</p>
				)}
				{state === 'failed' && (
					<GenericAuthError failure={failure} fallback={{ key: 'auth.failure.mail' }} />
				)}
				{state === 'sent' && (
					<Alert>
						<AlertDescription>{t('signIn.resetSent')}</AlertDescription>
					</Alert>
				)}
				<Button type="submit" disabled={busy}>
					{busy && <Spinner data-icon="inline-start" aria-hidden />}
					{t('reset.sendLink')}
				</Button>
			</FieldGroup>
		</form>
	);
}
