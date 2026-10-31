'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface ImportErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function ImportError({ error, retry }: ImportErrorProps) {
	const t = useTranslations('expenses-import.boundary');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-import"
			title={t('title')}
			body={t('body')}
		/>
	);
}
