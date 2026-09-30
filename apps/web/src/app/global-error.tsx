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

export default function GlobalError({
	error,
	reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
	useEffect(() => {
		captureException(error, { boundary: 'global' });
	}, [error]);

	return (
		<html lang="de">
			<body className="min-h-[100dvh] bg-background text-foreground antialiased">
				<main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col items-center justify-center px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
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
							<EmptyDescription>Bitte lade die Seite neu.</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
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
			</body>
		</html>
	);
}
