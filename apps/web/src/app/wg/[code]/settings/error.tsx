'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface SettingsErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function SettingsError({ error, retry }: SettingsErrorProps) {
	const t = useTranslations('settings.error');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-settings"
			title={t('title')}
			body={t('body')}
		/>
	);
}
