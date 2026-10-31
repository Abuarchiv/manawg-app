'use client';

import { LogoutNotice } from '@/components/entry/LogoutNotice';
import { PublicApp } from '@/components/entry/PublicApp';

/**
 * App entry point. On its own origin the app needs a real `/`: it is the
 * manifest's start_url, so it is where every PWA launch and every push
 * notification without a deeper target lands.
 */
export function EntryClient() {
	return (
		<>
			<LogoutNotice />
			<PublicApp />
		</>
	);
}
