import type { Catalog } from '../catalog';
import type de from '../de/auth';

export default {
	tabs: { code: 'Code by email', password: 'Password' },
	sections: {
		signUp: 'Register with email',
		code: 'Sign in with an email code',
		password: 'Sign in with a password',
	},
	fields: {
		email: 'Email address',
		password: 'Password',
		name: 'Your name',
		passwordRepeat: 'Confirm password',
		code: '{length, number}-digit code',
		newPassword: 'New password',
		confirmPassword: 'Confirm password',
	},
	failure: {
		credentials:
			'The email address or password is incorrect. Check what you entered or reset your password.',
		unconfirmed:
			'Your email address is not confirmed yet. Open the link in the confirmation email, then sign in.',
		rateLimit: 'Too many attempts. Wait a few minutes and try again.',
		network: 'No connection to the sign-in service. Check your connection and try again.',
		weakPassword: 'Choose a longer or different password that you do not use anywhere else.',
		signIn: 'Sign-in could not be completed right now. Try again.',
		mail: 'The email could not be sent right now. Try again.',
		signUp: 'Registration could not be completed right now. Try again.',
	},
	validEmail: 'Enter a valid email address.',
	mismatch: 'The passwords do not match.',
	otherEmail: 'Use a different email address',
	resendIn: 'Resend in {seconds, number} s',
	signIn: {
		invalid: 'Enter a valid email address and your password.',
		incomplete: 'Sign-in is not complete yet. Check your email and try again.',
		confirmationResent:
			'If this address is waiting for confirmation, we have sent the email again. Also check your spam folder.',
		resetSent:
			'If an account exists for this email address, you will receive a link to reset your password shortly.',
		forgot: 'Forgot your password?',
		requestingLink: 'Requesting link…',
		resend: 'Resend confirmation email',
		submit: 'Sign in',
	},
	code: {
		invalid: 'Enter the {length, number}-digit code from the email.',
		wrong: 'The code is wrong or has expired. Request a new one.',
		rateLimit: 'Too many attempts. Wait a moment.',
		send: 'Send code by email',
		sent: 'If an account exists for {email}, we have sent a code there. Also check your spam folder. No account yet? {create}',
		createLink: 'Create one now.',
		hint: 'The code is only valid for a short time.',
		resent: 'The code has been sent again.',
		resendIn: 'Resend code in {seconds, number} s',
		resend: 'Resend code',
		submit: 'Sign in',
	},
	signUp: {
		name: 'Enter your name.',
		tooShort: 'Your password needs at least {min, number} characters.',
		inboxTitle: 'Check your inbox',
		inboxBody:
			'If no account exists for {email} yet, we have sent a confirmation link there. Open the link, then carry on here. Also check your spam folder. If you already have an account, sign in instead.',
		resent: 'The email has been sent again.',
		resend: 'Resend email',
		hint: 'At least {min, number} characters.',
		submit: 'Create account',
	},
	reset: {
		tooShort: 'The password must be at least {min, number} characters long.',
		saved: 'Password saved.',
		same: 'The new password must be different from the current one.',
		failed: 'The password could not be changed right now. Request a new link.',
		invalidLink: 'This link is not valid or has expired. Request a new link.',
		back: 'Back',
		hint: 'At least {min, number} characters.',
		saving: 'Saving password…',
		save: 'Save password',
		sendLink: 'Send link',
	},
	social: {
		signIn: 'Sign in with {provider}',
		signUp: 'Register with {provider}',
		link: 'Link {provider}',
		pendingSignIn: 'Starting sign-in with {provider}…',
		pendingLink: 'Linking {provider}…',
		linkFailed: 'The account could not be linked. Try again later.',
		unreachable: 'Sign-in is not available right now. Check your connection and try again.',
	},
	prompt: { noAccount: 'No account yet?', create: 'Create account' },
} satisfies Catalog<typeof de>;
