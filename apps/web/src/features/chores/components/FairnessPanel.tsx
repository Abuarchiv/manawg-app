'use client';

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import type { ChoreFairness } from '@/features/chores/chore-fairness';
import { ChevronDown } from 'lucide-react';

const FAIRNESS_RULES = [
	'Niemand direkt doppelt',
	'Wenigste Last zuerst',
	'Nach Erledigung neu berechnet',
	'Abwesenheiten überspringen, sobald hinterlegt',
];

export function FairnessPanel({
	fairness,
	monthCompletions,
	members,
	currentMemberId,
}: {
	fairness: ChoreFairness;
	monthCompletions: Record<string, number>;
	members: { id: string; name: string }[];
	/** Die eigene Person heißt überall „du“, nicht beim eigenen Namen. */
	currentMemberId: string;
}) {
	const shares = members
		.map((member) => ({ ...member, count: monthCompletions[member.id] ?? 0 }))
		.filter((member) => member.count > 0)
		.sort((a, b) => b.count - a.count);
	const total = shares.reduce((sum, member) => sum + member.count, 0);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Diesen Monat</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<div className="flex flex-col gap-2">
					{total === 0 ? (
						<p className="text-sm text-muted-foreground">Noch nichts erledigt.</p>
					) : (
						<>
							<div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-muted">
								{shares.map((member, index) => (
									<span
										key={member.id}
										className="h-full border-background border-r-2 last:border-r-0"
										style={{
											width: `${(member.count / total) * 100}%`,
											backgroundColor: `color-mix(in oklab, var(--primary) ${100 - index * 25}%, transparent)`,
										}}
									/>
								))}
							</div>
							<ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
								{shares.map((member) => (
									<li key={member.id}>
										{member.id === currentMemberId ? 'Du' : member.name}:{' '}
										{Math.round((member.count / total) * 100)} % ({member.count})
									</li>
								))}
							</ul>
						</>
					)}
				</div>
				{fairness.suggestedAssignee && (
					<p className="text-sm">
						Als Nächstes dran:{' '}
						<span className="font-medium">
							{fairness.suggestedAssignee.id === currentMemberId
								? 'du'
								: fairness.suggestedAssignee.name}
						</span>
					</p>
				)}
				<Collapsible>
					<CollapsibleTrigger render={<Button variant="outline" className="w-full break-normal" />}>
						<span className="min-w-0 flex-1 text-left break-normal whitespace-normal">
							So wird verteilt
						</span>
						<ChevronDown data-icon="inline-end" aria-hidden />
					</CollapsibleTrigger>
					<CollapsiblePanel>
						<div className="flex flex-col gap-3 pt-3">
							<ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
								{FAIRNESS_RULES.map((rule) => (
									<li key={rule}>{rule}</li>
								))}
							</ul>
							<ItemGroup className="gap-2">
								{fairness.rows.map((row) => (
									<Item key={row.id} variant="outline">
										<ItemContent className="min-w-0">
											<ItemTitle className="line-clamp-none break-words">
												{row.id === currentMemberId ? 'Du' : row.name}
											</ItemTitle>
											<ItemDescription className="line-clamp-none">
												{row.assignedCount} Aufgabe{row.assignedCount === 1 ? '' : 'n'} ·{' '}
												{row.openGapCount}{' '}
												{row.openGapCount === 1 ? 'offener Termin' : 'offene Termine'}
											</ItemDescription>
										</ItemContent>
										{!row.available && <Badge variant="secondary">Abwesend</Badge>}
									</Item>
								))}
							</ItemGroup>
						</div>
					</CollapsiblePanel>
				</Collapsible>
			</CardContent>
		</Card>
	);
}
