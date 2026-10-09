'use client';

import { ErrorBox } from '@/components/app/ErrorBox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { type AuthFailure, classifyAuthError } from '@/core/auth/password-errors';
import { normalizePhoneInput } from '@/core/auth/phone';
import { useState } from 'react';
import { type AuthFormProps, type BusyAction, GenericAuthError } from './auth-form-shared';

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const OTP_PATTERN = /^\d{6}$/;

/** Phone number and SMS one-time code. */
export function usePhoneAuth({ busy, setBusy, onAuthenticated }: AuthFormProps) {
	const [phone, setPhone] = useState('');
	const [otp, setOtp] = useState('');
	const [otpRequested, setOtpRequested] = useState(false);
	const [failure, setFailure] = useState<AuthFailure>('other');
	const [phoneError, setPhoneError] = useState<
		'generic' | 'invalid-phone' | 'invalid-otp' | 'unavailable' | null
	>(null);
	const [phoneMessage, setPhoneMessage] = useState<string | null>(null);

	function resetPhoneFeedback(): void {
		setFailure('other');
		setPhoneError(null);
		setPhoneMessage(null);
	}

	async function sendPhoneOtp(): Promise<void> {
		if (busy) return;
		resetPhoneFeedback();
		const normalizedPhone = normalizePhoneInput(phone);
		if (!E164_PATTERN.test(normalizedPhone)) {
			setPhoneError('invalid-phone');
			return;
		}
		setBusy('phone-request');
		try {
			const { requestPhoneOtp } = await import('@/core/auth/client');
			await requestPhoneOtp(normalizedPhone);
			setPhone(normalizedPhone);
			setOtp('');
			setOtpRequested(true);
			setPhoneMessage('Wenn die Nummer verwendet werden kann, wurde ein SMS-Code gesendet.');
		} catch (error) {
			const { isPhoneAuthUnavailable } = await import('@/core/auth/client');
			setFailure(classifyAuthError(error));
			setPhoneError(isPhoneAuthUnavailable(error) ? 'unavailable' : 'generic');
		} finally {
			setBusy(null);
		}
	}

	async function confirmPhoneOtp(): Promise<void> {
		if (busy) return;
		resetPhoneFeedback();
		if (!E164_PATTERN.test(phone)) {
			setPhoneError('invalid-phone');
			return;
		}
		if (!OTP_PATTERN.test(otp)) {
			setPhoneError('invalid-otp');
			return;
		}
		setBusy('phone-verify');
		try {
			const { verifyPhoneOtp } = await import('@/core/auth/client');
			const result = await verifyPhoneOtp(phone, otp);
			if (result.sessionEstablished) onAuthenticated();
			else setPhoneError('generic');
		} catch (error) {
			setFailure(classifyAuthError(error));
			setPhoneError('generic');
		} finally {
			setBusy(null);
		}
	}

	function useAnotherPhoneNumber(): void {
		if (busy) return;
		setOtp('');
		setOtpRequested(false);
		resetPhoneFeedback();
	}

	const phoneFieldInvalid = phoneError === 'invalid-phone';
	const otpFieldInvalid = phoneError === 'invalid-otp';
	const phoneErrorDescribed =
		phoneFieldInvalid ||
		phoneError === 'unavailable' ||
		(phoneError === 'generic' && !otpRequested);
	const otpErrorDescribed = otpFieldInvalid || (phoneError === 'generic' && otpRequested);

	return {
		phone,
		setPhone,
		otp,
		setOtp,
		otpRequested,
		failure,
		phoneError,
		phoneMessage,
		sendPhoneOtp,
		confirmPhoneOtp,
		useAnotherPhoneNumber,
		phoneFieldInvalid,
		otpFieldInvalid,
		phoneErrorDescribed,
		otpErrorDescribed,
	};
}

export function PhoneAuthForm({
	auth,
	busy,
}: { auth: ReturnType<typeof usePhoneAuth>; busy: BusyAction }) {
	const {
		phone,
		setPhone,
		otp,
		setOtp,
		otpRequested,
		failure,
		phoneError,
		phoneMessage,
		sendPhoneOtp,
		confirmPhoneOtp,
		useAnotherPhoneNumber,
		phoneFieldInvalid,
		otpFieldInvalid,
		phoneErrorDescribed,
		otpErrorDescribed,
	} = auth;
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				void (otpRequested ? confirmPhoneOtp() : sendPhoneOtp());
			}}
			className="flex flex-col gap-4"
		>
			<FieldGroup>
				<h2 id="phone-auth-heading" className="sr-only">
					Mit Telefon per SMS
				</h2>
				<Field data-invalid={phoneFieldInvalid} data-disabled={otpRequested || busy !== null}>
					<FieldLabel htmlFor="auth-phone">Telefonnummer</FieldLabel>
					<Input
						id="auth-phone"
						name="phone"
						type="tel"
						value={phone}
						onChange={(event) => setPhone(event.target.value)}
						autoComplete="tel"
						inputMode="tel"
						enterKeyHint="send"
						placeholder="+491701234567"
						aria-describedby={
							phoneErrorDescribed ? 'auth-phone-hint auth-phone-error' : 'auth-phone-hint'
						}
						aria-invalid={phoneFieldInvalid ? true : undefined}
						disabled={otpRequested || busy !== null}
						className="text-base disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 dark:disabled:bg-muted/40"
					/>
				</Field>
				<p id="auth-phone-hint" className="text-xs text-muted-foreground">
					Beginne mit + oder 00 und der Landesvorwahl.
				</p>
				{otpRequested && (
					<Field data-invalid={otpFieldInvalid}>
						<FieldLabel htmlFor="auth-phone-otp">6-stelliger SMS-Code</FieldLabel>
						<Input
							id="auth-phone-otp"
							name="otp"
							type="text"
							value={otp}
							onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
							inputMode="numeric"
							autoComplete="one-time-code"
							enterKeyHint="done"
							maxLength={6}
							aria-describedby={otpErrorDescribed ? 'auth-phone-error' : undefined}
							aria-invalid={otpFieldInvalid ? true : undefined}
							className="font-mono text-base"
						/>
					</Field>
				)}
				{phoneError === 'generic' && (
					<div id="auth-phone-error">
						<GenericAuthError failure={failure} />
					</div>
				)}
				{phoneError === 'invalid-phone' && (
					<div id="auth-phone-error">
						<ErrorBox>
							Beginne mit + oder 00 und der Landesvorwahl, zum Beispiel +49 170 1234567.
						</ErrorBox>
					</div>
				)}
				{phoneError === 'invalid-otp' && (
					<div id="auth-phone-error">
						<ErrorBox>Gib einen sechsstelligen SMS-Code ein.</ErrorBox>
					</div>
				)}
				{phoneError === 'unavailable' && (
					<div id="auth-phone-error">
						<ErrorBox>
							SMS-Anmeldung ist derzeit nicht verfügbar. Bitte nutze E-Mail oder Google.
						</ErrorBox>
					</div>
				)}
				{phoneMessage && (
					<Alert>
						<AlertDescription className="[overflow-wrap:break-word]">
							{phoneMessage}
						</AlertDescription>
					</Alert>
				)}
				{otpRequested ? (
					<div className="flex flex-col gap-2">
						<Button type="submit" disabled={busy !== null}>
							{busy === 'phone-verify' && <Spinner data-icon="inline-start" aria-hidden />}
							Code bestätigen
						</Button>
						<Button
							type="button"
							variant="outline"
							onClick={() => void sendPhoneOtp()}
							disabled={busy !== null}
						>
							{busy === 'phone-request' && <Spinner data-icon="inline-start" aria-hidden />}
							SMS-Code erneut senden
						</Button>
						<Button
							type="button"
							variant="link"
							onClick={useAnotherPhoneNumber}
							disabled={busy !== null}
							className="px-0"
						>
							Andere Telefonnummer verwenden
						</Button>
					</div>
				) : (
					<Button type="submit" disabled={busy !== null} className="w-full">
						{busy === 'phone-request' && <Spinner data-icon="inline-start" aria-hidden />}
						SMS-Code anfordern
					</Button>
				)}
			</FieldGroup>
		</form>
	);
}
