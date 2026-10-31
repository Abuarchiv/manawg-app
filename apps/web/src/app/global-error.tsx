'use client';

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
import { htmlLang, LOCALE_COOKIE, type Locale } from '@/shared/i18n/locale';
import { SUPPORT_MAILTO } from '@/shared/lib/support-mailto';
import { applyStoredTheme, THEME_BOOTSTRAP_SCRIPT } from '@/shared/lib/theme';
import '@/shared/globals.css';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';

// This boundary sits above the root layout, so it has no message provider: two tiny inline copies.
const COPY: Record<Locale, Record<'wrong' | 'reload' | 'retry' | 'home' | 'report', string>> = {
	de: {
		// i18n-ignore German copy of the provider-less boundary
		wrong: 'Etwas ist schiefgelaufen',
		// i18n-ignore German copy of the provider-less boundary
		reload: 'Bitte lade die Seite neu.',
		// i18n-ignore German copy of the provider-less boundary
		retry: 'Erneut versuchen',
		// i18n-ignore German copy of the provider-less boundary
		home: 'Zur Startseite',
		// i18n-ignore German copy of the provider-less boundary
		report: 'Fehler per E-Mail melden',
	},
	en: {
		wrong: 'Something went wrong',
		reload: 'Please reload the page.',
		retry: 'Try again',
		home: 'Go to home page',
		report: 'Report error by email',
	},
};

function readLocale(): Locale {
	if (document.documentElement.lang.startsWith('en')) return 'en';
	return document.cookie.split('; ').includes(`${LOCALE_COOKIE}=en`) ? 'en' : 'de';
}

const subscribeNever = () => () => {};

export default function GlobalError({
	error,
	retry,
}: {
	error: Error & { digest?: string };
	retry: () => void;
}) {
	// The server pass renders German; the client picks the reader's language right after hydration.
	const locale = useSyncExternalStore(subscribeNever, readLocale, () => 'de' as const);
	const copy = COPY[locale];
	// The head script only runs on a server render; a client-rendered error page needs this
	// before paint so dark devices do not flash white.
	useLayoutEffect(applyStoredTheme, []);
	useEffect(() => {
		if (reloadOnStaleChunk(error)) return;
		captureException(error, { boundary: 'global' });
	}, [error]);

	return (
		<html lang={htmlLang(locale)} suppressHydrationWarning>
			<head>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: static constant, no dynamic data */}
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
			</head>
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
								{copy.wrong}
							</h1>
							<EmptyDescription>{copy.reload}</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								type="button"
								size="lg"
								onClick={() => (isChunkLoadError(error) ? window.location.reload() : retry())}
							>
								{copy.retry}
							</Button>
							{/* No next/link: this error sits above the root layout, so only a hard page load helps. */}
							<a href="/" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
								{copy.home}
							</a>
							{SUPPORT_MAILTO && (
								<a
									href={SUPPORT_MAILTO}
									className={buttonVariants({ variant: 'outline', size: 'lg' })}
								>
									{copy.report}
								</a>
							)}
						</EmptyContent>
					</Empty>
				</main>
			</body>
		</html>
	);
}
