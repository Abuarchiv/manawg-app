'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface ExpensesErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function ExpensesError({ error, retry }: ExpensesErrorProps) {
	const t = useTranslations('expenses.page');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-expenses"
			title={t('errorTitle')}
			body={t('errorBody')}
		/>
	);
}
