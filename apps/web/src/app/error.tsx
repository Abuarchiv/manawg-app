'use client';

import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
} from '@/components/ui/empty';
import { captureException } from '@/core/infra/capture-client';
import { isChunkLoadError, reloadOnStaleChunk } from '@/core/infra/stale-chunk';
import { SUPPORT_MAILTO } from '@/shared/lib/support-mailto';

export default function ErrorBoundary({
	error,
	retry,
}: {
	error: Error & { digest?: string };
	retry: () => void;
}) {
	const t = useTranslations('shell.errorPage');
	const mainRef = useRef<HTMLElement>(null);

	useEffect(() => {
		if (reloadOnStaleChunk(error)) return;
		captureException(error, { boundary: 'root' });
	}, [error]);

	// Focus was on the element that disappeared; without moving it, focus lands at the top of the page.
	useEffect(() => {
		mainRef.current?.focus();
	}, []);

	return (
		<main
			ref={mainRef}
			id="main"
			tabIndex={-1}
			className="mx-auto flex min-h-[60dvh] w-full max-w-md flex-col items-center justify-center bg-background px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] focus:outline-none"
		>
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TriangleAlert aria-hidden />
					</EmptyMedia>
					<h1
						data-slot="empty-title"
						className="min-w-0 max-w-full text-base font-semibold [overflow-wrap:anywhere]"
					>
						{t('somethingWrong')}
					</h1>
					<EmptyDescription>{t('tryAgainBody')}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					{process.env.NODE_ENV === 'development' && (
						// biome-ignore lint/a11y/useSemanticElements: <pre> must stay a preformatted block; role="region" names its scroll area.
						<pre
							// biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable error details must be focusable so keyboard users can scroll them.
							tabIndex={0}
							role="region"
							aria-label={t('details')}
							className="max-w-full overflow-auto rounded-lg border border-border bg-muted px-3 py-2 text-left text-xs text-foreground/75"
						>
							{error.message}
						</pre>
					)}
					<Button
						type="button"
						size="lg"
						onClick={() => (isChunkLoadError(error) ? window.location.reload() : retry())}
					>
						{t('tryAgain')}
					</Button>
					<Button variant="outline" size="lg" render={<Link href="/" />} nativeButton={false}>
						{t('toHome')}
					</Button>
					{SUPPORT_MAILTO && (
						<a href={SUPPORT_MAILTO} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
							{t('report')}
						</a>
					)}
				</EmptyContent>
			</Empty>
		</main>
	);
}
