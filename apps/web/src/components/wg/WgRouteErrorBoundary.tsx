'use client';

import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

interface WgRouteErrorBoundaryProps {
	error: Error & { digest?: string };
	retry: () => void;
	/** Identifies the failing route in the error log — e.g. `wg-chat`, `wg-supplies`. */
	boundary: string;
	/** Heading shown to the user. */
	title: string;
	/** Supporting copy under the heading. */
	body: string;
	/** Target of the secondary button; defaults to the WG home of the current route. */
	homeHref?: string;
	/** Label of the secondary button. */
	homeLabel?: string;
}

/**
 * Shared error boundary used by every `/wg/[code]/<segment>/error.tsx`.
 *
 * Next.js App Router requires each segment to ship its own default-export
 * client `error.tsx`; this component lets them shrink to a small wrapper
 * that just passes the per-route copy + boundary name.
 */
export function WgRouteErrorBoundary({
	error,
	retry,
	boundary,
	title,
	body,
	homeHref,
	homeLabel,
}: WgRouteErrorBoundaryProps) {
	const t = useTranslations('shell.errorPage');
	const params = useParams<{ code: string }>();
	const code = params?.code ?? '';
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (reloadOnStaleChunk(error)) return;
		captureException(error, { boundary });
	}, [error, boundary]);

	// Focus sat on the removed content; without moving it, focus falls back to the top of the page.
	useEffect(() => {
		rootRef.current?.focus();
	}, []);

	return (
		<div
			ref={rootRef}
			tabIndex={-1}
			className="flex items-center justify-center bg-background px-4 py-8 focus:outline-none"
		>
			<Card className="w-full max-w-md">
				<CardContent className="pt-6">
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<TriangleAlert aria-hidden />
							</EmptyMedia>
							<h1
								data-slot="empty-title"
								className="min-w-0 max-w-full text-base font-semibold [overflow-wrap:anywhere]"
							>
								{title}
							</h1>
							<EmptyDescription>{body}</EmptyDescription>
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
							<div className="flex w-full flex-col items-stretch gap-2">
								<Button
									type="button"
									size="lg"
									onClick={() => (isChunkLoadError(error) ? window.location.reload() : retry())}
									className="w-full"
								>
									{t('tryAgain')}
								</Button>
								<Button
									variant="outline"
									size="lg"
									render={<Link href={homeHref ?? `/wg/${code}`} />}
									nativeButton={false}
									className="w-full"
								>
									{homeLabel ?? t('overview')}
								</Button>
								{SUPPORT_MAILTO && (
									<a
										href={SUPPORT_MAILTO}
										className={buttonVariants({
											variant: 'outline',
											size: 'lg',
											className: 'w-full',
										})}
									>
										{t('report')}
									</a>
								)}
							</div>
						</EmptyContent>
					</Empty>
				</CardContent>
			</Card>
		</div>
	);
}
