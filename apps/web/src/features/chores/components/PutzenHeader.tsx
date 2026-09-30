'use client';
import type { getChorePlanHealth } from '@/features/chores/chore-status';

interface PutzenHeaderProps {
	itemCount: number;
	loading: boolean;
	health: ReturnType<typeof getChorePlanHealth> | null;
}

export function PutzenHeader({ itemCount, loading, health }: PutzenHeaderProps) {
	return (
		// Der aktive Tab benennt die Seite schon; Titel und Zähler bleiben für Screenreader.
		<header className="sr-only">
			<h1>Putzplan</h1>
			<p aria-live="polite" aria-atomic="true">
				{loading
					? 'Lädt…'
					: [
							`${itemCount} Aufgabe${itemCount === 1 ? '' : 'n'}`,
							health?.gaps ? `${health.gaps} überfällig` : null,
							health?.dueToday ? `${health.dueToday} heute` : null,
						]
							.filter(Boolean)
							.join(' · ')}
			</p>
		</header>
	);
}
