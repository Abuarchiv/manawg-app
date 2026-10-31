'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface ActivityErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function ActivityError({ error, retry }: ActivityErrorProps) {
	const t = useTranslations('activity.error');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-activity"
			title={t('title')}
			body={t('body')}
		/>
	);
}
