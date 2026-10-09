'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import {
	type InventoryItemDto,
	boughtRestockMatches,
	formatQuantity,
	restockAmount,
} from '@/features/inventory/inventory';
import { PackagePlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const MAX_ROWS = 3;

/**
 * After shopping: scarce stock whose name was just ticked off (by the caller) is still low, because
 * buying does not raise it. Offers to raise it by the amount the shopping entry asked for.
 * The caller passes only the member's own recent purchases, so two housemates never both restock.
 */
export function InventoryRestockPrompt({
	items,
	boughtNames,
	shareCode,
	memberId,
	onRestocked,
}: {
	items: InventoryItemDto[];
	boughtNames: string[];
	shareCode: string;
	memberId: string;
	onRestocked: () => void;
}) {
	const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const keysRef = useRef(new Map<string, string>());
	const storageKey = (id: string): string => `manawg:restock-prompt:${shareCode}:${id}`;

	const matches = boughtRestockMatches(items, boughtNames);
	const matchIds = matches.map((item) => item.id).join(',');
	// biome-ignore lint/correctness/useExhaustiveDependencies: storageKey only depends on shareCode
	useEffect(() => {
		const dismissed = matchIds.split(',').filter((id) => {
			try {
				return id !== '' && window.localStorage.getItem(storageKey(id)) !== null;
			} catch {
				return false;
			}
		});
		if (dismissed.length > 0) setHidden((prev) => new Set([...prev, ...dismissed]));
	}, [matchIds, shareCode]);

	const visible = matches.filter((item) => !hidden.has(item.id)).slice(0, MAX_ROWS);
	if (visible.length === 0) return null;

	function hide(id: string): void {
		setHidden((prev) => new Set([...prev, id]));
	}

	function dismiss(id: string): void {
		hide(id);
		try {
			window.localStorage.setItem(storageKey(id), new Date().toISOString());
		} catch {
			// The notice is then hidden for this session only.
		}
	}

	async function restock(item: InventoryItemDto): Promise<void> {
		if (pendingId !== null) return;
		const amount = restockAmount(item);
		const requestKey = `${item.id}:${amount}`;
		const idempotencyKey = keysRef.current.get(requestKey) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setError('Aktualisierung konnte nicht sicher gesendet werden. Versuche es erneut.');
			return;
		}
		keysRef.current.set(requestKey, idempotencyKey);
		setPendingId(item.id);
		setError(null);
		const res = await apiFetch(
			`/api/wg/${encodeURIComponent(shareCode)}/inventory/${encodeURIComponent(item.id)}`,
			{
				method: 'PATCH',
				memberId,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ quantityDelta: amount }),
			},
		);
		setPendingId(null);
		if (res.ok || (res.status === 404 && res.error === 'item_not_found')) {
			keysRef.current.delete(requestKey);
			hide(item.id);
			onRestocked();
		} else {
			if (res.status > 0 && res.status < 500) keysRef.current.delete(requestKey);
			setError('Aktualisierung fehlgeschlagen. Versuche es erneut.');
		}
	}

	return (
		<Alert>
			<PackagePlus aria-hidden />
			<AlertDescription className="flex flex-col gap-2 text-[13px]">
				{visible.map((item) => (
					<span key={item.id} className="flex flex-col gap-2">
						<span>
							{item.name} gekauft. Vorrat um {formatQuantity(restockAmount(item), item.unit)}{' '}
							erhöhen?
						</span>
						<span className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => void restock(item)}
								disabled={pendingId !== null}
								focusableWhenDisabled
								aria-busy={pendingId === item.id}
								aria-label={`${item.name}: Vorrat erhöhen`}
							>
								{pendingId === item.id && <Spinner aria-hidden />}
								Vorrat erhöhen
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => dismiss(item.id)}
								aria-label={`${item.name}: Nicht jetzt`}
							>
								Nicht jetzt
							</Button>
						</span>
					</span>
				))}
				{error && (
					<span role="alert" className="text-xs text-destructive">
						{error}
					</span>
				)}
			</AlertDescription>
		</Alert>
	);
}
