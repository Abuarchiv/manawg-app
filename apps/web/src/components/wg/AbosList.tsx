'use client';

import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { AboRow } from '@/components/wg/AboRow';
import type { Abo, AboFilter, MemberOption } from '@/components/wg/abos-types';
import { RefreshCw } from 'lucide-react';

interface AbosListProps {
	abos: Abo[];
	members: MemberOption[];
	filter: AboFilter;
	pendingId: string | null;
	loadError?: string | null;
	onFilterChange: (next: AboFilter) => void;
	onEdit: (abo: Abo) => void;
	onTogglePause: (abo: Abo) => void;
	onDelete: (abo: Abo) => void;
}

const FILTER_OPTIONS: ReadonlyArray<{ value: AboFilter; label: string }> = [
	{ value: 'active', label: 'Aktiv' },
	{ value: 'paused', label: 'Pausiert' },
	{ value: 'all', label: 'Alle' },
];

function applyFilter(abos: Abo[], filter: AboFilter): Abo[] {
	if (filter === 'all') return abos;
	if (filter === 'paused') return abos.filter((abo) => abo.pausedAt !== null);
	return abos.filter((abo) => abo.pausedAt === null);
}

export function AbosList({
	abos,
	members,
	filter,
	pendingId,
	loadError,
	onFilterChange,
	onEdit,
	onTogglePause,
	onDelete,
}: AbosListProps) {
	// Der Filter lohnt erst, wenn es pausierte Abos gibt.
	const showFilter = abos.some((abo) => abo.pausedAt !== null);
	const filtered = applyFilter(abos, showFilter ? filter : 'all');

	return (
		<section className="flex flex-col gap-4">
			{showFilter && (
				<ToggleGroup
					variant="segmented"
					value={[filter]}
					onValueChange={(values) => {
						const value = values[0];
						if (value === 'active' || value === 'paused' || value === 'all') onFilterChange(value);
					}}
					className="w-full"
					aria-label="Fixkosten filtern"
				>
					{FILTER_OPTIONS.map((option) => (
						<ToggleGroupItem key={option.value} value={option.value} className="flex-1">
							{option.label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			)}
			<output aria-live="polite" className="sr-only">
				{filtered.length} Fixkosten sichtbar
			</output>
			{filtered.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<RefreshCw />
						</EmptyMedia>
						<EmptyTitle>
							{loadError && abos.length === 0
								? 'Fixkosten noch nicht geladen'
								: abos.length === 0
									? 'Noch keine Fixkosten'
									: `Keine ${filter === 'paused' ? 'pausierten' : 'aktiven'} Fixkosten`}
						</EmptyTitle>
						<EmptyDescription>
							{loadError && abos.length === 0
								? 'Versuche es erneut.'
								: abos.length === 0
									? 'Miete, Internet oder Streaming über das Plus unten rechts anlegen.'
									: 'Wähle einen anderen Filter.'}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ul className="divide-y overflow-hidden rounded-xl border">
					{filtered.map((abo) => (
						<AboRow
							key={abo.id}
							abo={abo}
							members={members}
							pending={pendingId === abo.id}
							onEdit={onEdit}
							onTogglePause={onTogglePause}
							onDelete={onDelete}
						/>
					))}
				</ul>
			)}
		</section>
	);
}
