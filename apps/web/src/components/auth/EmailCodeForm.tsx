'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { ErrorBox } from '@/components/app/ErrorBox';
import { richArgument } from '@/components/entry/rich-argument';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { authPageHref } from '@/core/auth/auth-intent';
import { AUTH_FAILURE_MESSAGES, classifyAuthError } from '@/core/auth/password-errors';
import { type Message, useMessage } from '@/shared/i18n/message';
import {
	type AuthFormProps,
	type BusyAction,
	isValidEmail,
	normalizeEmail,
	useResendCooldown,
} from './auth-form-shared';

/** Length of the one-time code in the sign-in mail (Supabase project setting). */
const EMAIL_CODE_LENGTH = 8;
/** Seconds before the sign-in code can be requested again. */
const RESEND_COOLDOWN_SECONDS = 30;

type CodeError =
	| 'invalid-email'
	| 'invalid-code'
	| 'wrong-code'
	| 'rate-limit'
	| 'network'
	| 'generic'
	| null;

/** Sign-in with a one-time code mailed to an existing account. */
export function useEmailCode({
	email,
	setEmail,
	busy,
	setBusy,
	onAuthenticated,
}: AuthFormProps & { email: string; setEmail: (value: string) => void }) {
	const [code, setCode] = useState('');
	const [error, setError] = useState<CodeError>(null);
	// The address the code went to; set means the code step is shown.
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [cooldown, setCooldown] = useResendCooldown();
	const [resendNotice, setResendNotice] = useState(false);

	function failureOf(caught: unknown, fallback: 'generic' | 'wrong-code'): CodeError {
		const failure = classifyAuthError(caught);
		if (failure === 'rate-limit' || failure === 'network') return failure;
		// A server fault says nothing about the code, so it must not read as a wrong one.
		const status =
			caught !== null && typeof caught === 'object' ? Reflect.get(caught, 'status') : 0;
		if (typeof status === 'number' && status >= 500) return 'generic';
		return fallback;
	}

	async function send(address: string, isResend: boolean): Promise<void> {
		setBusy('code-request');
		try {
			const { requestEmailCode } = await import('@/core/auth/client');
			await requestEmailCode(address);
			setSentTo(address);
			setCode('');
			setCooldown(RESEND_COOLDOWN_SECONDS);
			setResendNotice(isResend);
		} catch (caught) {
			setError(failureOf(caught, 'generic'));
		} finally {
			setBusy(null);
		}
	}

	async function requestCode(): Promise<void> {
		if (busy) return;
		setError(null);
		const address = normalizeEmail(email);
		if (!isValidEmail(address)) {
			setError('invalid-email');
			return;
		}
		await send(address, false);
	}

	async function resend(): Promise<void> {
		if (busy || !sentTo || cooldown > 0) return;
		setError(null);
		await send(sentTo, true);
	}

	async function verify(): Promise<void> {
		if (busy || !sentTo) return;
		setError(null);
		setResendNotice(false);
		const token = code.replace(/\s/g, '');
		if (!new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`).test(token)) {
			setError('invalid-code');
			return;
		}
		setBusy('code-verify');
		try {
			const { verifyEmailCode } = await import('@/core/auth/client');
			const result = await verifyEmailCode(sentTo, token);
			if (result.sessionEstablished) {
				onAuthenticated();
				return;
			}
			setError('generic');
		} catch (caught) {
			setError(failureOf(caught, 'wrong-code'));
		} finally {
			setBusy(null);
		}
	}

	function changeAddress(): void {
		setError(null);
		setResendNotice(false);
		setSentTo(null);
		setCode('');
		setCooldown(0);
	}

	return {
		email,
		setEmail,
		code,
		setCode,
		error,
		sentTo,
		cooldown,
		resendNotice,
		requestCode,
		resend,
		verify,
		changeAddress,
	};
}

const ERROR_MESSAGES: Record<NonNullable<CodeError>, Message> = {
	'invalid-email': { key: 'auth.validEmail' },
	'invalid-code': { key: 'auth.code.invalid', values: { length: EMAIL_CODE_LENGTH } },
	'wrong-code': { key: 'auth.code.wrong' },
	'rate-limit': { key: 'auth.code.rateLimit' },
	network: AUTH_FAILURE_MESSAGES.network,
	generic: { key: 'auth.failure.signIn' },
};

function CodeErrorBox({ error }: { error: CodeError }) {
	const message = useMessage();
	if (!error) return null;
	return (
		<div id="auth-code-error">
			<ErrorBox>{message(ERROR_MESSAGES[error])}</ErrorBox>
		</div>
	);
}

export function EmailCodeForm({
	auth,
	busy,
	intentQuery,
}: {
	auth: ReturnType<typeof useEmailCode>;
	busy: BusyAction;
	intentQuery: string;
}) {
	const t = useTranslations('auth');
	const { email, setEmail, code, setCode, error, sentTo, cooldown, resendNotice } = auth;
	const codeRef = useRef<HTMLInputElement>(null);
	const emailRef = useRef<HTMLInputElement>(null);
	const codeStep = sentTo !== null;
	const first = useRef(true);
	// The form swaps between the two steps, so focus follows the visitor to the field that is needed now.
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		(codeStep ? codeRef : emailRef).current?.focus();
	}, [codeStep]);
	// A failed request keeps the form; send focus back to the field that needs fixing.
	useEffect(() => {
		if (error === 'invalid-email') emailRef.current?.focus();
		if (error === 'invalid-code' || error === 'wrong-code') codeRef.current?.focus();
	}, [error]);

	if (!codeStep) {
		const invalid = error === 'invalid-email';
		return (
			<form
				noValidate
				onSubmit={(event) => {
					event.preventDefault();
					void auth.requestCode();
				}}
				className="flex flex-col gap-4"
			>
				<FieldGroup>
					<Field data-invalid={invalid}>
						<FieldLabel htmlFor="auth-code-email">{t('fields.email')}</FieldLabel>
						<Input
							ref={emailRef}
							id="auth-code-email"
							name="email"
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							readOnly={busy !== null}
							autoComplete="email"
							enterKeyHint="go"
							inputMode="email"
							required
							aria-describedby={error ? 'auth-code-error' : undefined}
							aria-invalid={invalid || undefined}
							className="text-base"
						/>
					</Field>
					<CodeErrorBox error={error} />
					<Button type="submit" variant="default" disabled={busy !== null}>
						{busy === 'code-request' && <Spinner data-icon="inline-start" aria-hidden />}
						{t('code.send')}
					</Button>
				</FieldGroup>
			</form>
		);
	}

	const invalid = error === 'invalid-code' || error === 'wrong-code';
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				void auth.verify();
			}}
			className="flex flex-col gap-4"
		>
			<FieldGroup>
				<Alert>
					<AlertDescription className="[overflow-wrap:anywhere]">
						{t.rich('code.sent', {
							email: sentTo,
							create: richArgument(
								<Link
									href={authPageHref('/signup', intentQuery)}
									className="font-medium underline underline-offset-4"
								>
									{t('code.createLink')}
								</Link>,
							),
						})}
					</AlertDescription>
				</Alert>
				<Field data-invalid={invalid}>
					<FieldLabel htmlFor="auth-code">
						{t('fields.code', { length: EMAIL_CODE_LENGTH })}
					</FieldLabel>
					<Input
						ref={codeRef}
						id="auth-code"
						name="code"
						type="text"
						value={code}
						onChange={(event) => setCode(event.target.value)}
						readOnly={busy !== null}
						inputMode="numeric"
						autoComplete="one-time-code"
						enterKeyHint="go"
						maxLength={EMAIL_CODE_LENGTH + 4}
						required
						aria-describedby={['auth-code-hint', error ? 'auth-code-error' : undefined]
							.filter(Boolean)
							.join(' ')}
						aria-invalid={invalid || undefined}
						className="text-base tracking-widest"
					/>
					<FieldDescription id="auth-code-hint" className="text-xs">
						{t('code.hint')}
					</FieldDescription>
				</Field>
				{resendNotice && (
					<output className="text-sm text-muted-foreground">{t('code.resent')}</output>
				)}
				<CodeErrorBox error={error} />
				<Button type="submit" variant="default" disabled={busy !== null}>
					{busy === 'code-verify' && <Spinner data-icon="inline-start" aria-hidden />}
					{t('code.submit')}
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={() => void auth.resend()}
					disabled={busy !== null || cooldown > 0}
				>
					{busy === 'code-request' && <Spinner data-icon="inline-start" aria-hidden />}
					{cooldown > 0 ? t('code.resendIn', { seconds: cooldown }) : t('code.resend')}
				</Button>
				<Button type="button" variant="ghost" onClick={auth.changeAddress} disabled={busy !== null}>
					{t('otherEmail')}
				</Button>
			</FieldGroup>
		</form>
	);
}
