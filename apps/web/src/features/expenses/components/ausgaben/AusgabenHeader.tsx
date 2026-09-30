'use client';

interface AusgabenHeaderProps {
	expenseCount: number;
	initialLoading: boolean;
}

export function AusgabenHeader({
	expenseCount,
	initialLoading,
}: AusgabenHeaderProps): React.ReactElement {
	return (
		// Der aktive Tab benennt die Seite schon; Titel und Zähler bleiben für Screenreader.
		<header className="sr-only">
			<h1>Ausgaben</h1>
			<p aria-live="polite" aria-atomic="true">
				{initialLoading ? '' : `${expenseCount} ${expenseCount === 1 ? 'Eintrag' : 'Einträge'}`}
			</p>
		</header>
	);
}
