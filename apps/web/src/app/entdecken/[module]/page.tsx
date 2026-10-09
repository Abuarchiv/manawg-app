import { PublicApp } from '@/components/entry/PublicApp';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

// Titles/descriptions mirror the module copy in PublicApp — kept here too so
// this Server Component can export per-route metadata (WCAG 2.4.2: every
// route needs its own descriptive title, not the generic app-wide one).
const PUBLIC_MODULES: Record<string, { title: string; description: string }> = {
	ausgaben: { title: 'Ausgaben', description: 'Gemeinsame Kosten im Blick.' },
	einkauf: { title: 'Einkäufe', description: 'Was gekauft werden muss.' },
	pinnwand: { title: 'Pinnwand', description: 'Infos für alle.' },
	putzen: { title: 'Putzplan', description: 'Aufgaben fair verteilen.' },
	fixkosten: { title: 'Fixkosten', description: 'Wiederkehrende Kosten.' },
	mahnungen: { title: 'Erinnerungen', description: 'Wer noch zahlen muss.' },
	vorraete: { title: 'Vorräte', description: 'Was noch da ist.' },
	kalender: { title: 'Kalender', description: 'Gemeinsame Termine.' },
	aktivitaet: { title: 'Aktivität', description: 'Was zuletzt passiert ist.' },
	chat: { title: 'Chat', description: 'Kurz etwas klären.' },
};

// Own-property lookup: `in` / bare indexing would match Object.prototype keys like "constructor".
const publicModule = (slug: string) =>
	Object.hasOwn(PUBLIC_MODULES, slug) ? PUBLIC_MODULES[slug] : undefined;

export async function generateMetadata({
	params,
}: { params: Promise<{ module: string }> }): Promise<Metadata> {
	const { module } = await params;
	const entry = publicModule(module);
	if (!entry) return {};
	return {
		title: `${entry.title} — ManaWG`,
		description: `${entry.description} Die WG-App für Ausgaben, Putzplan, Einkauf und Pinnwand.`,
		alternates: { canonical: `/entdecken/${module}` },
	};
}

export default async function PublicModulePage({
	params,
}: {
	params: Promise<{ module: string }>;
}) {
	const { module } = await params;
	if (!publicModule(module)) notFound();
	return <PublicApp activeModule={module} />;
}
