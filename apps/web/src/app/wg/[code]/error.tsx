'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
} from '@/components/ui/empty';
import { captureException } from '@/core/infra/capture-client';
import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';

interface WgErrorProps {
	error: Error & { digest?: string };
	reset: () => void;
}

export default function WgError({ error, reset }: WgErrorProps) {
	const headingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		captureException(error, { boundary: 'wg-code' });
	}, [error]);
	// Focus was on the element that disappeared; move it here so the error is announced.
	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	return (
		<div className="flex items-center justify-center bg-background px-4 py-8">
			<Card className="w-full max-w-md">
				<CardContent className="pt-6">
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<TriangleAlert aria-hidden />
							</EmptyMedia>
							<h1
								ref={headingRef}
								tabIndex={-1}
								data-slot="empty-title"
								className="min-w-0 max-w-full text-base font-semibold [overflow-wrap:anywhere] focus:outline-none"
							>
								Etwas ist schiefgelaufen
							</h1>
							<EmptyDescription>
								Ein Fehler ist aufgetreten. Bitte versuche es erneut oder gehe zur Startseite.
							</EmptyDescription>
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
									render={<Link href="/" />}
									nativeButton={false}
									className="w-full"
								>
									Zur Startseite
								</Button>
							</div>
						</EmptyContent>
					</Empty>
				</CardContent>
			</Card>
		</div>
	);
}
