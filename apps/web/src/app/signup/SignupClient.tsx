'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { startSocialLogin } from '@/app/login/start-flow';
import { CredentialsAuth } from '@/components/auth/CredentialsAuth';
import { useGoogleSignIn } from '@/components/auth/google-sign-in';
import { SocialLoginButtons } from '@/components/auth/SocialLoginButtons';
import { EntryFrame } from '@/components/entry/EntryFrame';
import { LegalLinks } from '@/components/entry/LegalLinks';
import { FieldGroup, FieldSeparator } from '@/components/ui/field';
import { authPageHref } from '@/core/auth/auth-intent';

function intentKey(intent: URLSearchParams): 'inviteIntent' | 'createIntent' | 'defaultIntent' {
	if (intent.get('next')?.startsWith('/invite/')) return 'inviteIntent';
	if (intent.get('action') === 'create') return 'createIntent';
	return 'defaultIntent';
}

/** Registration page: Google or e-mail/password, then back into the `/login` start flow. */
export function SignupClient({ intentQuery }: { intentQuery: string }) {
	const t = useTranslations('entry');
	const router = useRouter();
	const [credentialsBusy, setCredentialsBusy] = useState(false);
	const googleSignIn = useGoogleSignIn();
	const intent = new URLSearchParams(intentQuery);
	const afterAuthPath = authPageHref('/login', intentQuery);

	return (
		<EntryFrame
			title={t('register.title')}
			headingId="signup-heading"
			description={t(`register.${intentKey(intent)}`)}
			backHref="/"
		>
			<FieldGroup>
				{googleSignIn && (
					<>
						<SocialLoginButtons
							variant="sign-up"
							next={afterAuthPath}
							onOAuthStart={startSocialLogin}
							disabled={credentialsBusy}
						/>
						<FieldSeparator>{t('start.or')}</FieldSeparator>
					</>
				)}
				<CredentialsAuth
					mode="sign-up"
					next={afterAuthPath}
					onAuthenticated={() => router.replace(afterAuthPath)}
					onBusyChange={setCredentialsBusy}
				/>
			</FieldGroup>
			<p className="text-sm text-muted-foreground">
				{t('register.hasAccount')}{' '}
				<Link
					href={authPageHref('/login', intentQuery)}
					className="-my-3 inline-block py-3 font-medium text-foreground underline underline-offset-4"
				>
					{t('register.signIn')}
				</Link>
			</p>
			<LegalLinks registration />
		</EntryFrame>
	);
}
