import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { SearchX } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
	title: 'WG nicht gefunden — ManaWG',
	robots: { index: false, follow: false },
};

// craftsman-ignore: TS002 — Next.js App Router requires default export for not-found pages
export default function WgNotFound() {
	return (
		<div className="flex min-h-[calc(100svh-4.25rem)] items-center justify-center bg-background px-4 pb-[env(safe-area-inset-bottom)]">
			<Card className="w-full max-w-md">
				<CardContent className="pt-6">
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<SearchX aria-hidden />
							</EmptyMedia>
							<EmptyTitle>WG nicht gefunden</EmptyTitle>
							<EmptyDescription>
								Der 8-stellige Code ist falsch oder die WG wurde gelöscht.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								variant="outline"
								size="lg"
								render={<Link href="/neu" />}
								nativeButton={false}
							>
								Neue WG erstellen oder beitreten
							</Button>
						</EmptyContent>
					</Empty>
				</CardContent>
			</Card>
		</div>
	);
}
