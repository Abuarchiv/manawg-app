'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface ChoresErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function ChoresError({ error, retry }: ChoresErrorProps) {
	const t = useTranslations('chores.errorPage');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-chores"
			title={t('title')}
			body={t('body')}
		/>
	);
}
