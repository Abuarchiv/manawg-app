'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface ShoppingErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function ShoppingError({ error, retry }: ShoppingErrorProps) {
	const t = useTranslations('shopping.errorPage');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-shopping"
			title={t('title')}
			body={t('body')}
		/>
	);
}
