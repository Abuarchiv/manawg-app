'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface PinboardErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function PinboardError({ error, retry }: PinboardErrorProps) {
	const t = useTranslations('pinboard.errorPage');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-pinboard"
			title={t('title')}
			body={t('body')}
		/>
	);
}
