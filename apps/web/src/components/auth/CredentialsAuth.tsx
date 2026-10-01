'use client';

import { ErrorBox } from '@/components/neu/ErrorBox';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WEAK_PASSWORD_MESSAGE, isWeakPasswordError } from '@/core/auth/password-errors';
import { type ReactElement, useEffect, useState } from 'react';

/** Minimum for passwords chosen now (sign-up, reset); Supabase enforces the same value. */
export const NEW_PASSWORD_MIN_LENGTH = 8;

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const OTP_PATTERN = /^\d{6}$/;

type CredentialsAuthProps = {
	next: string;
	onAuthenticated: () => void;
};

type BusyAction =
	| 'email-sign-in'
	| 'email-sign-up'
	| 'password-reset'
	| 'phone-request'
	| 'phone-verify'
	| null;

function isValidEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function GenericAuthError(): ReactElement {
	return (
		<ErrorBox>
			Die Anmeldung konnte gerade nicht abgeschlossen werden. Bitte versuche es erneut.
		</ErrorBox>
	);
}

export function CredentialsAuth({ next, onAuthenticated }: CredentialsAuthProps) {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [phone, setPhone] = useState('');
	const [otp, setOtp] = useState('');
	const [otpRequested, setOtpRequested] = useState(false);
	const [busy, setBusy] = useState<BusyAction>(null);
	const [emailError, setEmailError] = useState<
		'generic' | 'invalid' | 'weak-password' | 'reset-invalid' | null
	>(null);
	const [emailMessage, setEmailMessage] = useState<string | null>(null);
	const [phoneError, setPhoneError] = useState<'generic' | 'invalid' | 'unavailable' | null>(null);
	const [phoneMessage, setPhoneMessage] = useState<string | null>(null);
	// Offer SMS only where the Supabase project actually has it switched on.
	const [phoneEnabled, setPhoneEnabled] = useState(false);

	useEffect(() => {
		let active = true;
		import('@/core/auth/client')
			.then(({ isAuthProviderEnabled }) => isAuthProviderEnabled('phone'))
			.then((enabled) => {
				if (active) setPhoneEnabled(enabled);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, []);

	function resetEmailFeedback(): void {
		setEmailError(null);
		setEmailMessage(null);
	}

	function resetPhoneFeedback(): void {
		setPhoneError(null);
		setPhoneMessage(null);
	}

	async function submitEmail(mode: 'sign-in' | 'sign-up'): Promise<void> {
		if (busy) return;
		resetEmailFeedback();
		const normalizedEmail = email.trim().toLowerCase();
		// Existing accounts may still use 6-character passwords, so only new
		// passwords have to meet the stricter minimum.
		if (mode === 'sign-up' && password.length < NEW_PASSWORD_MIN_LENGTH) {
			setEmailError('weak-password');
			return;
		}
		if (!isValidEmail(normalizedEmail) || password.length < 6) {
			setEmailError('invalid');
			return;
		}
		const action = mode === 'sign-in' ? 'email-sign-in' : 'email-sign-up';
		setBusy(action);
		try {
			const { signInWithEmailPassword, signUpWithEmailPassword } = await import(
				'@/core/auth/client'
			);
			const result =
				mode === 'sign-in'
					? await signInWithEmailPassword(normalizedEmail, password)
					: await signUpWithEmailPassword(normalizedEmail, password, next);
			if (result.sessionEstablished) {
				onAuthenticated();
			} else {
				setEmailMessage(
					mode === 'sign-up'
						? 'Falls ein neues Konto angelegt wurde, prüfe deine E-Mail und bestätige den Link. Danach kannst du dich anmelden.'
						: 'Die Anmeldung ist noch nicht abgeschlossen. Prüfe deine E-Mail und versuche es erneut.',
				);
			}
		} catch (error) {
			setEmailError(mode === 'sign-up' && isWeakPasswordError(error) ? 'weak-password' : 'generic');
		} finally {
			setBusy(null);
		}
	}

	async function requestPasswordReset(): Promise<void> {
		if (busy) return;
		resetEmailFeedback();
		const normalizedEmail = email.trim().toLowerCase();
		if (!isValidEmail(normalizedEmail)) {
			setEmailError('reset-invalid');
			return;
		}
		setBusy('password-reset');
		try {
			const { requestPasswordReset: sendPasswordReset } = await import('@/core/auth/client');
			await sendPasswordReset(normalizedEmail);
			setEmailMessage(
				'Wenn zu dieser E-Mail-Adresse ein Konto gehört, erhältst du gleich einen Link zum Zurücksetzen des Passworts.',
			);
		} catch {
			setEmailError('generic');
		} finally {
			setBusy(null);
		}
	}

	async function sendPhoneOtp(): Promise<void> {
		if (busy) return;
		resetPhoneFeedback();
		const normalizedPhone = phone.trim();
		if (!E164_PATTERN.test(normalizedPhone)) {
			setPhoneError('invalid');
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
			setPhoneError(isPhoneAuthUnavailable(error) ? 'unavailable' : 'generic');
		} finally {
			setBusy(null);
		}
	}

	async function confirmPhoneOtp(): Promise<void> {
		if (busy) return;
		resetPhoneFeedback();
		if (!E164_PATTERN.test(phone) || !OTP_PATTERN.test(otp)) {
			setPhoneError('invalid');
			return;
		}
		setBusy('phone-verify');
		try {
			const { verifyPhoneOtp } = await import('@/core/auth/client');
			const result = await verifyPhoneOtp(phone, otp);
			if (result.sessionEstablished) onAuthenticated();
			else setPhoneError('generic');
		} catch {
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

	const emailFieldInvalid =
		emailError === 'reset-invalid' ||
		(emailError === 'invalid' && !isValidEmail(email.trim().toLowerCase()));
	const passwordFieldInvalid =
		(emailError === 'invalid' && password.length < 6) || emailError === 'weak-password';

	return (
		<Tabs defaultValue="email" aria-busy={busy !== null} className="gap-4">
			{phoneEnabled && (
				<TabsList className="min-h-12 w-full">
					<TabsTrigger value="email" disabled={busy !== null} className="min-h-11">
						E-Mail
					</TabsTrigger>
					<TabsTrigger value="phone" disabled={busy !== null} className="min-h-11">
						Telefon / SMS
					</TabsTrigger>
				</TabsList>
			)}
			<TabsContent value="email" aria-label="Mit E-Mail anmelden">
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void submitEmail('sign-in');
					}}
					className="flex flex-col gap-4"
				>
					<FieldGroup>
						<Field data-invalid={emailFieldInvalid}>
							<FieldLabel htmlFor="auth-email">E-Mail-Adresse</FieldLabel>
							<Input
								id="auth-email"
								name="email"
								type="email"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								autoComplete="email"
								inputMode="email"
								required
								aria-describedby={emailFieldInvalid ? 'auth-email-error' : undefined}
								aria-invalid={emailFieldInvalid || undefined}
								className="text-base"
							/>
						</Field>
						<Field data-invalid={passwordFieldInvalid}>
							<FieldLabel htmlFor="auth-password">Passwort</FieldLabel>
							<Input
								id="auth-password"
								name="password"
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								autoComplete="current-password"
								minLength={6}
								required
								aria-describedby={passwordFieldInvalid ? 'auth-email-error' : undefined}
								aria-invalid={passwordFieldInvalid || undefined}
								className="text-base"
							/>
						</Field>
						<Button
							type="button"
							variant="link"
							onClick={() => void requestPasswordReset()}
							disabled={busy !== null}
							className="px-0"
						>
							{busy === 'password-reset' ? 'Link wird angefordert …' : 'Passwort vergessen?'}
						</Button>
						{emailError === 'generic' && (
							<div id="auth-email-error">
								<GenericAuthError />
							</div>
						)}
						{emailError === 'invalid' && (
							<div id="auth-email-error">
								<ErrorBox>
									Bitte gib eine gültige E-Mail-Adresse und ein Passwort mit mindestens 6 Zeichen
									ein.
								</ErrorBox>
							</div>
						)}
						{emailError === 'weak-password' && (
							<div id="auth-email-error">
								<ErrorBox>{WEAK_PASSWORD_MESSAGE}</ErrorBox>
							</div>
						)}

						{emailError === 'reset-invalid' && (
							<div id="auth-email-error">
								<ErrorBox>Bitte gib eine gültige E-Mail-Adresse ein.</ErrorBox>
							</div>
						)}
						{emailMessage && (
							<output className="block text-[13px] text-muted-foreground">{emailMessage}</output>
						)}
						<div className="flex flex-col gap-2">
							<Button type="submit" variant="default" disabled={busy !== null}>
								{busy === 'email-sign-in' && <Spinner data-icon="inline-start" aria-hidden />}
								Anmelden
							</Button>
							<Button
								type="button"
								variant="outline"
								onClick={() => void submitEmail('sign-up')}
								disabled={busy !== null}
							>
								{busy === 'email-sign-up' && <Spinner data-icon="inline-start" aria-hidden />}
								Konto erstellen
							</Button>
						</div>
					</FieldGroup>
				</form>
			</TabsContent>

			{phoneEnabled && (
				<TabsContent value="phone" aria-labelledby="phone-auth-heading">
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void (otpRequested ? confirmPhoneOtp() : sendPhoneOtp());
						}}
						className="flex flex-col gap-4"
					>
						<FieldGroup>
							<h2 id="phone-auth-heading" className="text-[14px] font-semibold text-foreground">
								Mit Telefon per SMS
							</h2>
							<Field
								data-invalid={Boolean(phoneError)}
								data-disabled={otpRequested || busy !== null}
							>
								<FieldLabel htmlFor="auth-phone">Telefonnummer</FieldLabel>
								<Input
									id="auth-phone"
									name="phone"
									type="tel"
									value={phone}
									onChange={(event) => setPhone(event.target.value)}
									autoComplete="tel"
									inputMode="tel"
									placeholder="+491701234567"
									aria-describedby={
										phoneError ? 'auth-phone-hint auth-phone-error' : 'auth-phone-hint'
									}
									aria-invalid={phoneError ? true : undefined}
									disabled={otpRequested || busy !== null}
									className="text-base"
								/>
							</Field>
							<p id="auth-phone-hint" className="text-xs text-muted-foreground">
								Mit + und Landesvorwahl, zum Beispiel +491701234567.
							</p>
							{otpRequested && (
								<Field data-invalid={Boolean(phoneError)}>
									<FieldLabel htmlFor="auth-phone-otp">6-stelliger SMS-Code</FieldLabel>
									<Input
										id="auth-phone-otp"
										name="otp"
										type="text"
										value={otp}
										onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
										inputMode="numeric"
										autoComplete="one-time-code"
										maxLength={6}
										pattern="[0-9]{6}"
										aria-describedby={phoneError ? 'auth-phone-error' : undefined}
										aria-invalid={phoneError ? true : undefined}
										className="font-mono text-base"
									/>
								</Field>
							)}
							{phoneError === 'generic' && (
								<div id="auth-phone-error">
									<GenericAuthError />
								</div>
							)}
							{phoneError === 'invalid' && (
								<div id="auth-phone-error">
									<ErrorBox>
										Gib eine Telefonnummer im internationalen E.164-Format ein, zum Beispiel
										+491701234567.
									</ErrorBox>
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
								<output className="block text-[13px] text-muted-foreground">{phoneMessage}</output>
							)}
							{otpRequested ? (
								<div className="flex flex-col gap-2">
									<Button type="submit" variant="outline" disabled={busy !== null}>
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
								<Button type="submit" variant="outline" disabled={busy !== null} className="w-full">
									{busy === 'phone-request' && <Spinner data-icon="inline-start" aria-hidden />}
									SMS-Code anfordern
								</Button>
							)}
						</FieldGroup>
					</form>
				</TabsContent>
			)}
		</Tabs>
	);
}
