// craftsman-ignore: TS002 — Next.js App Router requires default export for error boundaries
'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { captureException } from '@/core/infra/observability';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';

interface Props {
	error: Error & { digest?: string };
	reset: () => void;
}

export default function ImportError({ error, reset }: Props) {
	const { code } = useParams<{ code: string }>();
	const wgBaseHref = `/wg/${encodeURIComponent(code)}`;

	useEffect(() => {
		captureException(error, { boundary: 'wg-import' });
	}, [error]);
	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-8">
			<Alert variant="destructive">
				<AlertTriangle aria-hidden="true" />
				<AlertTitle>Import-Assistent konnte nicht geladen werden</AlertTitle>
				<AlertDescription>
					{process.env.NODE_ENV === 'development' ? error.message : 'Bitte versuche es erneut.'}
				</AlertDescription>
			</Alert>
			<div className="flex flex-col gap-2">
				<Button type="button" className="flex-1" onClick={reset}>
					Erneut versuchen
				</Button>
				<Button
					variant="outline"
					className="flex-1"
					render={<Link href={`${wgBaseHref}/ausgaben`} />}
					nativeButton={false}
				>
					Zurück zu Ausgaben
				</Button>
			</div>
		</div>
	);
}
