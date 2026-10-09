'use client';

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
import { LegacyAccountRecovery } from '@/components/auth/LegacyAccountRecovery';
import { Button } from '@/components/ui/button';
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@/components/ui/item';
import { getLegacyIdentityCandidates } from '@/core/auth/identity';
import { ChevronDown, Home, KeyRound, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { AccountWg } from './start-flow';

interface ChooseStepProps {
	accountWgs: AccountWg[];
	interactive: boolean;
	busy: boolean;
	legacyOpen: boolean;
	onLegacyOpenChange: (open: boolean) => void;
	onCreate: () => void;
	onJoin: () => void;
}

export function ChooseStep({
	accountWgs,
	interactive,
	busy,
	legacyOpen,
	onLegacyOpenChange,
	onCreate,
	onJoin,
}: ChooseStepProps) {
	// Only offered when this device holds an old profile; ChooseStep renders after the client-side session check.
	const [hasLegacyProfile] = useState(() => getLegacyIdentityCandidates().length > 0);
	return (
		<div className="flex flex-col gap-4">
			{accountWgs.length > 0 && (
				<section aria-labelledby="your-wgs-heading" className="flex flex-col gap-3">
					<h2 id="your-wgs-heading" className="sr-only">
						Deine WGs
					</h2>
					<ItemGroup>
						{accountWgs.map((accountWg) => (
							// biome-ignore lint/a11y/useSemanticElements: ItemGroup is a div[role=list], a bare <li> would be invalid HTML
							<div key={accountWg.id} role="listitem" className="w-full min-w-0">
								<Item
									variant="outline"
									render={<Link href={`/wg/${encodeURIComponent(accountWg.code)}`} />}
								>
									<ItemMedia variant="icon">
										<Home aria-hidden />
									</ItemMedia>
									<ItemContent className="min-w-0">
										<ItemTitle className="line-clamp-none break-words">{accountWg.name}</ItemTitle>
										<ItemDescription>WG öffnen</ItemDescription>
									</ItemContent>
								</Item>
							</div>
						))}
					</ItemGroup>
				</section>
			)}
			<div className="flex flex-col gap-2">
				<Button size="lg" disabled={!interactive || busy} onClick={onCreate} className="w-full">
					<Plus data-icon="inline-start" aria-hidden /> Neue WG erstellen
				</Button>
				<Button
					size="lg"
					variant="outline"
					disabled={!interactive || busy}
					onClick={onJoin}
					className="w-full"
				>
					<KeyRound data-icon="inline-start" aria-hidden /> Per Code beitreten
				</Button>
			</div>
			{hasLegacyProfile && (
				<Collapsible open={legacyOpen} onOpenChange={onLegacyOpenChange}>
					<CollapsibleTrigger
						render={
							<Button
								variant="ghost"
								className="h-auto w-full justify-between whitespace-normal py-2 text-left"
							/>
						}
					>
						Altes Profil auf diesem Gerät wiederherstellen
						<ChevronDown
							data-icon="inline-end"
							aria-hidden
							className="transition-transform group-aria-expanded/button:rotate-180 motion-reduce:transition-none"
						/>
					</CollapsibleTrigger>
					<CollapsiblePanel keepRendered>
						<div inert={!legacyOpen} className="pt-3">
							<LegacyAccountRecovery />
						</div>
					</CollapsiblePanel>
				</Collapsible>
			)}
		</div>
	);
}
