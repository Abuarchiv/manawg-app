// craftsman-ignore: TS002 — wrapper consumed by Next.js App Router error.tsx default exports
'use client';

import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
} from '@/components/ui/empty';
import { captureException } from '@/core/infra/observability';
import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';

interface WgRouteErrorBoundaryProps {
	error: Error & { digest?: string };
	reset: () => void;
	/** Identifies the failing route in the error log — e.g. `wg-chat`, `wg-vorraete`. */
	boundary: string;
	/** Heading shown to the user. */
	title: string;
	/** Supporting copy under the heading. */
	body: string;
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
	reset,
	boundary,
	title,
	body,
}: WgRouteErrorBoundaryProps) {
	const params = useParams<{ code: string }>();
	const code = params?.code ?? '';

	useEffect(() => {
		captureException(error, { boundary });
	}, [error, boundary]);

	return (
		<div className="flex min-h-[calc(100svh-4.25rem)] items-center justify-center bg-background px-4 pb-[env(safe-area-inset-bottom)]">
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
								<pre
									// biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable error details must be focusable so keyboard users can scroll them.
									tabIndex={0}
									// biome-ignore lint/a11y/useSemanticElements: <pre> must stay a preformatted block; role="region" names its scroll area.
									role="region"
									aria-label="Fehlerdetails"
									className="max-w-full overflow-auto rounded-lg border border-border bg-muted px-3 py-2 text-left text-xs text-foreground/75"
								>
									{error.message}
								</pre>
							)}
							<div className="flex w-full flex-col items-stretch gap-2">
								<Button type="button" size="lg" onClick={reset} className="w-full">
									Erneut versuchen
								</Button>
								<Button
									variant="outline"
									size="lg"
									render={<Link href={`/wg/${code}`} />}
									nativeButton={false}
									className="w-full"
								>
									Zur Übersicht
								</Button>
								<a
									href="mailto:info@manawg.com?subject=Fehler%20in%20ManaWG"
									className={buttonVariants({
										variant: 'outline',
										size: 'lg',
										className: 'w-full',
									})}
								>
									Fehler per E-Mail melden
								</a>
							</div>
						</EmptyContent>
					</Empty>
				</CardContent>
			</Card>
		</div>
	);
}
