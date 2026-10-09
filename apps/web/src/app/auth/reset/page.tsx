import { PasswordResetForm } from '@/components/auth/PasswordResetForm';
import { EntryFrame } from '@/components/entry/EntryFrame';
import { getAuthenticatedUserFromCookies } from '@/core/auth/server';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
	title: 'Passwort zurücksetzen — ManaWG',
	robots: { index: false, follow: false },
};

export default async function PasswordResetPage() {
	const [cookieStore, user] = await Promise.all([cookies(), getAuthenticatedUserFromCookies()]);
	const recoveryRequested = Boolean(
		user && cookieStore.get('manawg_password_recovery')?.value === user.id,
	);

	return (
		<EntryFrame
			title="Passwort zurücksetzen"
			description={
				recoveryRequested
					? 'Lege ein neues Passwort für dein Konto fest.'
					: 'Fordere einen neuen Link an.'
			}
			headingId="password-reset-heading"
			backHref="/neu"
			backLabel="ManaWG, zurück zur Anmeldung"
		>
			<PasswordResetForm recoveryRequested={recoveryRequested} signedIn={Boolean(user)} />
		</EntryFrame>
	);
}
