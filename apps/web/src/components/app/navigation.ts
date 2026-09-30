import {
	CalendarDays,
	ListChecks,
	Megaphone,
	MessageCircle,
	Package,
	Receipt,
	Repeat2,
	Sparkles,
} from 'lucide-react';

export const WG_SECTIONS = [
	{
		label: 'Haushalt',
		iconKey: 'haushalt',
		pages: [
			{ slug: 'putzen', label: 'Putzplan', icon: Sparkles },
			{ slug: 'einkauf', label: 'Einkäufe', icon: ListChecks },
			{ slug: 'vorraete', label: 'Vorräte', icon: Package },
		],
		related: [],
	},
	{
		label: 'Finanzen',
		iconKey: 'finanzen',
		pages: [
			{ slug: 'ausgaben', label: 'Ausgaben', icon: Receipt },
			{ slug: 'abos', label: 'Fixkosten', icon: Repeat2 },
		],
		// Aktionen der Finanzen mit eigener Seite: kein Segment, aber der Tab bleibt aktiv.
		related: ['mahnungen', 'import'],
	},
	{
		label: 'Austausch',
		iconKey: 'austausch',
		pages: [
			{ slug: 'pinnwand', label: 'Pinnwand', icon: Megaphone },
			{ slug: 'chat', label: 'Chat', icon: MessageCircle },
			{ slug: 'kalender', label: 'Kalender', icon: CalendarDays },
		],
		related: [],
	},
] as const;

export function getWgSection(pathname: string) {
	const match = pathname.match(/^(\/wg\/[^/]+)\/([^/]+)/);
	if (!match) return null;
	const section = WG_SECTIONS.find((item) => item.pages.some((page) => page.slug === match[2]));
	return section ? { ...section, baseHref: match[1] } : null;
}
