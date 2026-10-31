'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface SuppliesErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function SuppliesError({ error, retry }: SuppliesErrorProps) {
	const t = useTranslations('inventory.errorPage');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-supplies"
			title={t('title')}
			body={t('body')}
		/>
	);
}
