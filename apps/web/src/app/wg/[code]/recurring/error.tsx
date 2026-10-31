'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface RecurringErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function RecurringError({ error, retry }: RecurringErrorProps) {
	const t = useTranslations('expenses-recurring');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-recurring"
			title={t('page.boundary.title')}
			body={t('page.boundary.body')}
		/>
	);
}
