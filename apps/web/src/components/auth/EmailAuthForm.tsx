'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ErrorBox } from '@/components/app/ErrorBox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { type AuthFailure, classifyAuthError } from '@/core/auth/password-errors';
import type { Message } from '@/shared/i18n/message';
import {
	type AuthFormProps,
	type BusyAction,
	GenericAuthError,
	isValidEmail,
	normalizeEmail,
	SIGN_IN_PASSWORD_MIN_LENGTH,
	useResendCooldown,
} from './auth-form-shared';

/** Seconds before the confirmation mail can be requested again; the server limits stay authoritative. */
const RESEND_COOLDOWN_SECONDS = 60;

const MAIL_FAILED: Message = { key: 'auth.failure.mail' };

/** E-mail and password: sign in, resend a confirmation mail, or request a reset link. */
export function useEmailAuth({
	next,
	busy,
	setBusy,
	onAuthenticated,
}: AuthFormProps & { next: string }) {
	const t = useTranslations('auth.signIn');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [emailError, setEmailError] = useState<'generic' | 'invalid' | 'reset-invalid' | null>(
		null,
	);
	const [failure, setFailure] = useState<AuthFailure>('other');
	// True when the failed action was sending a mail, so an unclassified failure does not read as a sign-in failure.
	const [mailFailed, setMailFailed] = useState(false);
	// The unconfirmed address behind the last sign-in; the resend action outlives later feedback.
	const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
	const [emailMessage, setEmailMessage] = useState<string | null>(null);
	// Kept across sign-in attempts, so repeating the failed sign-in cannot mail again at once.
	const [resendCooldown, setResendCooldown] = useResendCooldown();

	function resetEmailFeedback(): void {
		setFailure('other');
		setMailFailed(false);
		setEmailError(null);
		setEmailMessage(null);
	}

	async function submitEmail(): Promise<void> {
		if (busy) return;
		resetEmailFeedback();
		const normalizedEmail = normalizeEmail(email);
		if (!isValidEmail(normalizedEmail) || password.length < SIGN_IN_PASSWORD_MIN_LENGTH) {
			setEmailError('invalid');
			return;
		}
		setBusy('email-sign-in');
		try {
			const { signInWithEmailPassword } = await import('@/core/auth/client');
			const result = await signInWithEmailPassword(normalizedEmail, password);
			if (result.sessionEstablished) {
				onAuthenticated();
			} else {
				setEmailMessage(t('incomplete'));
			}
		} catch (error) {
			const classified = classifyAuthError(error);
			setFailure(classified);
			setUnconfirmedEmail(classified === 'unconfirmed' ? normalizedEmail : null);
			setEmailError('generic');
		} finally {
			setBusy(null);
		}
	}

	async function resendConfirmation(): Promise<void> {
		if (busy || resendCooldown > 0) return;
		const normalizedEmail = normalizeEmail(email);
		resetEmailFeedback();
		if (!isValidEmail(normalizedEmail)) {
			setEmailError('reset-invalid');
			return;
		}
		setBusy('email-resend');
		try {
			const { resendSignupConfirmation } = await import('@/core/auth/client');
			await resendSignupConfirmation(normalizedEmail, next);
			setResendCooldown(RESEND_COOLDOWN_SECONDS);
			setEmailMessage(t('confirmationResent'));
		} catch (error) {
			setFailure(classifyAuthError(error));
			setMailFailed(true);
			setEmailError('generic');
		} finally {
			setBusy(null);
		}
	}

	async function requestPasswordReset(): Promise<void> {
		if (busy) return;
		resetEmailFeedback();
		const normalizedEmail = normalizeEmail(email);
		if (!isValidEmail(normalizedEmail)) {
			setEmailError('reset-invalid');
			return;
		}
		setBusy('password-reset');
		try {
			const { requestPasswordReset: sendPasswordReset } = await import('@/core/auth/client');
			await sendPasswordReset(normalizedEmail);
			setEmailMessage(t('resetSent'));
		} catch (error) {
			setFailure(classifyAuthError(error));
			setMailFailed(true);
			setEmailError('generic');
		} finally {
			setBusy(null);
		}
	}

	const canResendConfirmation =
		unconfirmedEmail !== null && unconfirmedEmail === normalizeEmail(email);
	const emailFieldInvalid =
		emailError === 'reset-invalid' ||
		(emailError === 'invalid' && !isValidEmail(normalizeEmail(email)));
	const passwordFieldInvalid =
		emailError === 'invalid' && password.length < SIGN_IN_PASSWORD_MIN_LENGTH;

	return {
		email,
		setEmail,
		password,
		setPassword,
		emailError,
		failure,
		mailFailed,
		emailMessage,
		submitEmail,
		resendConfirmation,
		resendCooldown,
		canResendConfirmation,
		requestPasswordReset,
		emailFieldInvalid,
		passwordFieldInvalid,
	};
}

export function EmailAuthForm({
	auth,
	busy,
}: {
	auth: ReturnType<typeof useEmailAuth>;
	busy: BusyAction;
}) {
	const t = useTranslations('auth');
	const {
		email,
		setEmail,
		password,
		setPassword,
		emailError,
		failure,
		mailFailed,
		emailMessage,
		submitEmail,
		resendConfirmation,
		resendCooldown,
		canResendConfirmation,
		requestPasswordReset,
		emailFieldInvalid,
		passwordFieldInvalid,
	} = auth;
	return (
		<form
			method="post"
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				void submitEmail();
			}}
			className="flex flex-col gap-4"
		>
			<FieldGroup>
				<Field data-invalid={emailFieldInvalid}>
					<FieldLabel htmlFor="auth-email">{t('fields.email')}</FieldLabel>
					<Input
						id="auth-email"
						name="email"
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						readOnly={busy !== null}
						autoComplete="email"
						enterKeyHint="next"
						inputMode="email"
						required
						aria-describedby={emailFieldInvalid ? 'auth-email-error' : undefined}
						aria-invalid={emailFieldInvalid || undefined}
						className="text-base"
					/>
				</Field>
				<Field data-invalid={passwordFieldInvalid}>
					<FieldLabel htmlFor="auth-password">{t('fields.password')}</FieldLabel>
					<Input
						id="auth-password"
						name="password"
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						readOnly={busy !== null}
						autoComplete="current-password"
						enterKeyHint="go"
						minLength={SIGN_IN_PASSWORD_MIN_LENGTH}
						required
						aria-describedby={passwordFieldInvalid ? 'auth-email-error' : undefined}
						aria-invalid={passwordFieldInvalid || undefined}
						className="text-base"
					/>
				</Field>
				{emailError === 'generic' && (
					<div id="auth-email-error">
						<GenericAuthError
							failure={failure}
							{...(mailFailed ? { fallback: MAIL_FAILED } : {})}
						/>
					</div>
				)}
				{emailError === 'invalid' && (
					<div id="auth-email-error">
						<ErrorBox>{t('signIn.invalid')}</ErrorBox>
					</div>
				)}
				{emailError === 'reset-invalid' && (
					<div id="auth-email-error">
						<ErrorBox>{t('validEmail')}</ErrorBox>
					</div>
				)}
				<Button
					type="button"
					variant="link"
					onClick={() => void requestPasswordReset()}
					disabled={busy !== null}
					className="px-0"
				>
					{busy === 'password-reset' ? t('signIn.requestingLink') : t('signIn.forgot')}
				</Button>
				{emailMessage && (
					<Alert>
						<AlertDescription className="[overflow-wrap:break-word]">
							{emailMessage}
						</AlertDescription>
					</Alert>
				)}
				{canResendConfirmation && (
					<Button
						type="button"
						variant="outline"
						onClick={() => void resendConfirmation()}
						disabled={busy !== null || resendCooldown > 0}
					>
						{busy === 'email-resend' && <Spinner data-icon="inline-start" aria-hidden />}
						{resendCooldown > 0 ? t('resendIn', { seconds: resendCooldown }) : t('signIn.resend')}
					</Button>
				)}
				<Button type="submit" variant="default" disabled={busy !== null}>
					{busy === 'email-sign-in' && <Spinner data-icon="inline-start" aria-hidden />}
					{t('signIn.submit')}
				</Button>
			</FieldGroup>
		</form>
	);
}
