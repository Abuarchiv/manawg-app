'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/** Drops a stale `?error=auth_callback` after a successful sign-in, so it does not survive reloads. */
export function useClearCallbackError(authenticated: boolean): void {
	const router = useRouter();
	const searchParams = useSearchParams();
	useEffect(() => {
		if (!authenticated || searchParams.get('error') !== 'auth_callback') return;
		const params = new URLSearchParams(searchParams.toString());
		params.delete('error');
		router.replace(params.size ? `/neu?${params}` : '/neu', { scroll: false });
	}, [authenticated, router, searchParams]);
}
