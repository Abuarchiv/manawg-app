'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface StatementErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function StatementError({ error, retry }: StatementErrorProps) {
	const t = useTranslations('statement');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-statement"
			title={t('page.boundary.title')}
			body={t('page.boundary.body')}
		/>
	);
}
