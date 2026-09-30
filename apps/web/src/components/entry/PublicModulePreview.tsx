import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@/components/ui/item';
import { cn } from '@/shared/lib/cn';
import type { LucideIcon } from 'lucide-react';
import { ListChecks, Megaphone, Receipt } from 'lucide-react';
import Link from 'next/link';

export interface PublicPreviewModule {
	slug: string;
	title: string;
	description: string;
	Icon: LucideIcon;
}

interface PreviewCopy {
	title: string;
	detail: string;
	meta: string;
}

const PREVIEW_COPY: Record<string, PreviewCopy> = {
	einkauf: { title: 'Hafermilch', detail: '2 Packungen', meta: 'Noch offen · für alle' },
	ausgaben: {
		title: 'Pizzaabend',
		detail: 'Mika bezahlt · 28,40 €',
		meta: '4 Personen · 7,10 € pro Person',
	},
	putzen: { title: 'Bad putzen', detail: 'Samira · heute', meta: 'Offen · als Nächstes dran' },
	pinnwand: {
		title: 'Übergabe am Freitag',
		detail: 'Alex · gestern',
		meta: 'Schlüssel liegen im Flur bereit.',
	},
	fixkosten: { title: 'Internet', detail: '29,99 € monatlich', meta: 'Nächste Zahlung am 3.' },
	mahnungen: {
		title: 'Noah bekommt 12,50 €',
		detail: 'Geteilt aus dem Einkauf',
		meta: 'Seit 2 Tagen offen',
	},
	vorraete: {
		title: 'Toilettenpapier',
		detail: '2 Packungen vorhanden',
		meta: 'Mindestbestand: 1 Packung',
	},
	kalender: { title: 'Putzplan-Check', detail: 'Freitag · 18:00 Uhr', meta: 'Für die ganze WG' },
	aktivitaet: {
		title: 'Mara hat Einkauf ergänzt',
		detail: 'Hafermilch · 2 Packungen',
		meta: 'Vor 12 Minuten',
	},
	chat: { title: 'In der WG', detail: '„Bin um acht wieder da.“', meta: 'Lea · vor 8 Minuten' },
	einstellungen: {
		title: 'WG-Mitglieder verwalten',
		detail: 'Einladungen und Rollen',
		meta: 'Nur für berechtigte Mitglieder',
	},
};

function previewFor(module: PublicPreviewModule): PreviewCopy {
	return (
		PREVIEW_COPY[module.slug] ?? {
			title: module.title,
			detail: module.description,
			meta: 'Beispielinhalte für eure WG',
		}
	);
}

function PreviewRows({
	module,
	copy,
	featured,
}: {
	module: PublicPreviewModule;
	copy: PreviewCopy;
	featured: boolean;
}) {
	if (!featured) {
		return (
			<ItemGroup className="gap-2">
				<Item size="sm" className="rounded-none px-0">
					<ItemMedia variant="icon">
						<module.Icon aria-hidden />
					</ItemMedia>
					<ItemContent className="min-w-0">
						<ItemTitle className="line-clamp-none break-words">{copy.title}</ItemTitle>
						<ItemDescription className="line-clamp-none break-words">{copy.meta}</ItemDescription>
					</ItemContent>
				</Item>
			</ItemGroup>
		);
	}

	if (module.slug === 'einkauf') {
		return (
			<ItemGroup className="gap-2">
				{[
					['Hafermilch', '2 Packungen', 'Offen'],
					['Bananen', '6 Stück', 'Offen'],
					['Spülmittel', '1 Flasche', 'Erledigt'],
				].map(([title, detail, state]) => (
					<Item key={title} size="sm" className="rounded-none px-0">
						<ItemMedia variant="icon">
							<ListChecks aria-hidden />
						</ItemMedia>
						<ItemContent className="min-w-0">
							<ItemTitle className="line-clamp-none break-words">{title}</ItemTitle>
							<ItemDescription className="line-clamp-none break-words">{detail}</ItemDescription>
						</ItemContent>
						<Badge variant={state === 'Erledigt' ? 'secondary' : 'outline'}>{state}</Badge>
					</Item>
				))}
			</ItemGroup>
		);
	}

	if (module.slug === 'ausgaben') {
		return (
			<ItemGroup className="gap-2">
				<Item size="sm" className="rounded-none px-0">
					<ItemMedia variant="icon">
						<Receipt aria-hidden />
					</ItemMedia>
					<ItemContent className="min-w-0">
						<ItemTitle className="line-clamp-none break-words">Pizzaabend</ItemTitle>
						<ItemDescription className="line-clamp-none break-words">
							Mika bezahlt · 28,40 €
						</ItemDescription>
					</ItemContent>
					<ItemActions>
						<Badge variant="outline">4 Personen</Badge>
					</ItemActions>
				</Item>
				<Item size="sm" className="rounded-none px-0">
					<ItemContent className="min-w-0">
						<ItemTitle className="line-clamp-none break-words">Aufteilung</ItemTitle>
						<ItemDescription className="line-clamp-none break-words">
							7,10 € pro Person
						</ItemDescription>
					</ItemContent>
				</Item>
			</ItemGroup>
		);
	}

	if (module.slug === 'putzen') {
		return (
			<ItemGroup className="gap-2">
				<Item size="sm" className="rounded-none px-0">
					<ItemMedia>
						<Avatar size="sm">
							<AvatarFallback>S</AvatarFallback>
						</Avatar>
					</ItemMedia>
					<ItemContent className="min-w-0">
						<ItemTitle className="line-clamp-none break-words">Bad putzen</ItemTitle>
						<ItemDescription className="line-clamp-none break-words">
							Samira · heute
						</ItemDescription>
					</ItemContent>
					<Badge variant="outline">Offen</Badge>
				</Item>
			</ItemGroup>
		);
	}

	if (module.slug === 'pinnwand') {
		return (
			<ItemGroup className="gap-2">
				<Item size="sm" className="rounded-none px-0">
					<ItemMedia variant="icon">
						<Megaphone aria-hidden />
					</ItemMedia>
					<ItemContent className="min-w-0">
						<ItemTitle className="line-clamp-none break-words">Übergabe am Freitag</ItemTitle>
						<ItemDescription className="line-clamp-none break-words">
							Alex · gestern · Schlüssel liegen im Flur bereit.
						</ItemDescription>
					</ItemContent>
				</Item>
			</ItemGroup>
		);
	}

	return (
		<ItemGroup className="gap-2">
			<Item size="sm" className="rounded-none px-0 @container">
				<ItemMedia variant="icon">
					<module.Icon aria-hidden />
				</ItemMedia>
				<ItemContent className="min-w-0">
					<ItemTitle className="line-clamp-none break-words">{copy.title}</ItemTitle>
					<ItemDescription className="line-clamp-none break-words">{copy.detail}</ItemDescription>
				</ItemContent>
				<ItemActions className="@max-[320px]:basis-full @max-[320px]:justify-end">
					<Badge variant="outline">Beispiel</Badge>
				</ItemActions>
			</Item>
		</ItemGroup>
	);
}

function ExampleCard({
	module,
	featured = false,
}: { module: PublicPreviewModule; featured?: boolean }) {
	const copy = previewFor(module);
	return (
		<article aria-label={`${module.title}, Beispiel-WG`}>
			<Card size={featured ? 'default' : 'sm'} className="h-full">
				{!featured && (
					<CardHeader>
						<CardTitle>{module.title}</CardTitle>
						<CardDescription>{copy.detail}</CardDescription>
					</CardHeader>
				)}
				<CardContent>
					<PreviewRows module={module} copy={copy} featured={featured} />
				</CardContent>
			</Card>
		</article>
	);
}

export function PublicModulePreviews({ modules }: { modules: PublicPreviewModule[] }) {
	return (
		<section aria-labelledby="public-examples-heading" className="flex flex-col gap-3">
			<div className="flex items-end justify-between gap-3">
				<div className="flex flex-col gap-1">
					<h2 id="public-examples-heading" className="text-base font-semibold">
						So kann euer Alltag aussehen
					</h2>
					<p className="text-sm text-muted-foreground">
						Vier kleine Einblicke aus einer Beispiel-WG.
					</p>
				</div>
				<Badge variant="secondary" className="shrink-0">
					Beispiel-WG
				</Badge>
			</div>
			<div className="grid grid-cols-1 gap-3">
				{modules.map((module) => (
					<ExampleCard key={module.slug} module={module} />
				))}
			</div>
		</section>
	);
}

export function PublicModulePreview({
	module,
	homeHref = '/',
}: {
	module: PublicPreviewModule;
	homeHref?: string;
}) {
	return (
		<section aria-label={`Beispielansicht für ${module.title}`} className="flex flex-col gap-3">
			<div className="flex justify-end">
				<Badge variant="secondary" className="shrink-0">
					Beispiel-WG · fiktiv
				</Badge>
			</div>
			<ExampleCard module={module} featured />
			<Link href={homeHref} className={cn(buttonVariants({ variant: 'link' }), 'self-start px-0')}>
				Alle Bereiche ansehen
			</Link>
		</section>
	);
}
