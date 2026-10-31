'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface CalendarErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function CalendarError({ error, retry }: CalendarErrorProps) {
	const t = useTranslations('events.errorPage');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-calendar"
			title={t('title')}
			body={t('body')}
		/>
	);
}
