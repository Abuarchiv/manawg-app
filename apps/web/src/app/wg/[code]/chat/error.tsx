'use client';

import { useTranslations } from 'next-intl';
import { WgRouteErrorBoundary } from '@/components/wg/WgRouteErrorBoundary';

interface ChatErrorProps {
	error: Error & { digest?: string };
	retry: () => void;
}

export default function ChatError({ error, retry }: ChatErrorProps) {
	const t = useTranslations('chat.errorPage');
	return (
		<WgRouteErrorBoundary
			error={error}
			retry={retry}
			boundary="wg-chat"
			title={t('title')}
			body={t('body')}
		/>
	);
}
