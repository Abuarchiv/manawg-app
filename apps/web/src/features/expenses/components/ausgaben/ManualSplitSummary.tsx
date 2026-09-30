'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { parseEuroAmount } from '@/core/utils/amount';
import { CENTS_PER_EURO } from '@/core/utils/money';
import { formatEuroCents } from '@/core/utils/money';
import type { Dispatch, SetStateAction } from 'react';
import { distributeRemainderCents } from './manual-split-distribute';

interface ManualSplitSummaryProps {
	amountStr: string;
	currency: string;
	manualSplits: Record<string, string>;
	members: ReadonlyArray<{ id: string; name: string }>;
	setManualSplits: Dispatch<SetStateAction<Record<string, string>>>;
	disabled?: boolean;
}

export function ManualSplitSummary({
	amountStr,
	currency,
	manualSplits,
	members,
	setManualSplits,
	disabled = false,
}: ManualSplitSummaryProps) {
	const totalEuros = parseEuroAmount(amountStr) ?? 0;
	const totalCents = Math.round(totalEuros * CENTS_PER_EURO);
	const splitCents = Object.values(manualSplits).reduce((sum, raw) => {
		const v = parseEuroAmount(raw);
		return v === null ? sum : sum + Math.round(v * CENTS_PER_EURO);
	}, 0);
	const remainderCents = totalCents - splitCents;
	const balanced = totalCents > 0 && remainderCents === 0;
	const label = balanced ? '✓ Ausgeglichen' : remainderCents < 0 ? 'Zu viel' : 'Offen';

	function distributeRemainder(): void {
		if (totalCents <= 0 || remainderCents === 0) return;
		// Compute the next state from the same snapshot remainderCents came
		// from, outside any updater, so StrictMode's double-invoked updaters
		// cannot apply the remainder against a different base.
		setManualSplits(distributeRemainderCents(manualSplits, members, remainderCents));
	}

	return (
		<div className="flex flex-col gap-2">
			<Alert
				aria-live="polite"
				variant={balanced ? undefined : remainderCents < 0 ? 'destructive' : undefined}
			>
				<AlertDescription className="flex items-center justify-between gap-2">
					<span>
						Summe:{' '}
						<span className="font-mono tabular-nums">{formatEuroCents(splitCents, currency)}</span>
					</span>
					<span>
						{label}
						{!balanced && (
							<>
								:{' '}
								<span className="font-mono tabular-nums">
									{formatEuroCents(Math.abs(remainderCents), currency)}
								</span>
							</>
						)}
					</span>
				</AlertDescription>
			</Alert>
			{!balanced && totalCents > 0 && (
				<Button
					type="button"
					variant="outline"
					size="lg"
					onClick={distributeRemainder}
					disabled={disabled}
				>
					Rest aufteilen
				</Button>
			)}
		</div>
	);
}
