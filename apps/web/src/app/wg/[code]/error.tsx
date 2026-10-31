'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface WgErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

/** Boundary for failures of the WG layout itself, so the way out leads to the site root. */
export default function WgError({ error, retry }: WgErrorProps) {
	const t = useTranslations('shell.errorPage');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-code"
			title={t('somethingWrong')}
			body={t('wgBody')}
			homeHref="/"
			homeLabel={t('toHome')}
		/>
	);
}
