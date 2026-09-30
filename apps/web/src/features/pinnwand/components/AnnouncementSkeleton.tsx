import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function AnnouncementSkeleton() {
	return (
		<output className="flex flex-col gap-4" aria-label="Pinnwand wird geladen" aria-busy="true">
			{['first', 'second', 'third'].map((key) => (
				<Card key={key}>
					<CardHeader>
						<div className="flex min-w-0 items-center gap-3">
							<Skeleton className="size-8 rounded-full" />
							<Skeleton className="h-4 w-32 min-w-0" />
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-3/4" />
						<Skeleton className="h-11 w-28" />
					</CardContent>
				</Card>
			))}
		</output>
	);
}
