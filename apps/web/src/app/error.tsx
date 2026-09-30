// craftsman-ignore: TS002 — Next.js App Router requires default export for error boundaries
'use client';

import { Button, buttonVariants } from '@/components/ui/button';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
} from '@/components/ui/empty';
import { captureException } from '@/core/infra/observability';
import { TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';

export default function ErrorBoundary({
	error,
	reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
	useEffect(() => {
		captureException(error, { boundary: 'root' });
	}, [error]);

	return (
		<main
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
						Etwas ist schiefgelaufen
					</h1>
					<EmptyDescription>Bitte versuche es erneut.</EmptyDescription>
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
					<Button type="button" size="lg" onClick={() => reset()}>
						Erneut versuchen
					</Button>
					<a
						href="mailto:info@manawg.com?subject=Fehler%20in%20ManaWG"
						className={buttonVariants({ variant: 'outline', size: 'lg' })}
					>
						Fehler per E-Mail melden
					</a>
				</EmptyContent>
			</Empty>
		</main>
	);
}
