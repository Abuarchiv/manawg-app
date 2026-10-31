'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface RemindersErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function RemindersError({ error, retry }: RemindersErrorProps) {
	const t = useTranslations('expenses-debts.page.boundary');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-reminders"
			title={t('title')}
			body={t('body')}
		/>
	);
}
