'use client';

import { useToast } from '@/components/ui/Toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
	Drawer,
	DrawerContent,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
} from '@/components/ui/drawer';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import {
	INVENTORY_CATEGORIES,
	INVENTORY_UNITS,
	type InventoryCategory,
	type InventoryItemDto,
	type InventoryMutationItemDto,
	type InventoryUnit,
	clampQuantity,
	formatQuantity,
	normalizeForMatch,
} from '@/features/inventory/inventory';
import { useEffect, useRef, useState } from 'react';
import { InventoryFormFields } from './InventoryFormFields';

interface InventoryAddModalProps {
	open: boolean;
	shareCode: string;
	memberId: string;
	mode: 'create' | 'edit';
	initial?: {
		id: string;
		name: string;
		quantity: number;
		unit: string;
		threshold: number;
		category: string;
		updatedAt: string;
	} | null;
	/** Existing items, for the duplicate-name hint (the server enforces it too). */
	items: InventoryItemDto[];
	onClose: () => void;
	onSaved: (item?: InventoryMutationItemDto, deletedId?: string) => void;
	onItemRefreshed: (item: InventoryItemDto) => void;
}

type InventoryEditorItem = NonNullable<InventoryAddModalProps['initial']>;

const DEFAULT_UNIT: InventoryUnit = 'Stück';
const DEFAULT_CATEGORY: InventoryCategory = 'sonstiges';

/** An empty field counts as 0; the value is clamped only on save so the field can stay empty while typing. */
function parseCount(text: string): number {
	return clampQuantity(Number(text || 0));
}

function coerceUnit(unit: string | undefined): InventoryUnit {
	if (unit && (INVENTORY_UNITS as readonly string[]).includes(unit)) {
		return unit as InventoryUnit;
	}
	return DEFAULT_UNIT;
}

function coerceCategory(category: string | undefined): InventoryCategory {
	if (category && (INVENTORY_CATEGORIES as readonly string[]).includes(category)) {
		return category as InventoryCategory;
	}
	return DEFAULT_CATEGORY;
}

export function InventoryAddModal({
	open,
	shareCode,
	memberId,
	mode,
	initial,
	items,
	onClose,
	onSaved,
	onItemRefreshed,
}: InventoryAddModalProps) {
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(shareCode);
	const [name, setName] = useState('');
	const [quantityText, setQuantityText] = useState('0');
	const [unit, setUnit] = useState<InventoryUnit>(DEFAULT_UNIT);
	const [thresholdText, setThresholdText] = useState('1');
	const [category, setCategory] = useState<InventoryCategory>(DEFAULT_CATEGORY);
	const [baseline, setBaseline] = useState<InventoryEditorItem | null>(initial ?? null);
	const [saving, setSaving] = useState(false);
	const [conflictNeedsReload, setConflictNeedsReload] = useState(false);
	const [discardOpen, setDiscardOpen] = useState(false);
	const [nameError, setNameError] = useState<string | null>(null);
	const [serverError, setServerError] = useState<string | null>(null);
	const alertRef = useRef<HTMLDivElement>(null);
	const createRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const quantity = parseCount(quantityText);
	const threshold = parseCount(thresholdText);
	const initialRef = useRef(initial);

	useEffect(() => {
		initialRef.current = initial;
	}, [initial]);

	useEffect(() => {
		if (!open) return;
		const current = initialRef.current ?? null;
		setBaseline(current);
		setName(current?.name ?? '');
		setQuantityText(String(current?.quantity ?? 0));
		setUnit(coerceUnit(current?.unit));
		setThresholdText(String(current?.threshold ?? 1));
		setCategory(coerceCategory(current?.category));
		setConflictNeedsReload(false);
		setNameError(null);
		setServerError(null);
	}, [open]);

	// The error sits outside the scrolling area; focus it so keyboard and screen-reader users find it.
	useEffect(() => {
		if (serverError) alertRef.current?.focus({ preventScroll: true });
	}, [serverError]);

	function requestClose(): void {
		if (saving) return;
		const current = baseline ?? initial;
		const dirty =
			name !== (current?.name ?? '') ||
			quantity !== (current?.quantity ?? 0) ||
			unit !== coerceUnit(current?.unit) ||
			threshold !== (current?.threshold ?? 1) ||
			category !== coerceCategory(current?.category);
		if (dirty) setDiscardOpen(true);
		else onClose();
	}

	async function save(): Promise<void> {
		if (saving) return;
		const trimmedName = name.trim();
		if (trimmedName.length === 0) {
			setNameError('Bitte gib einen Namen ein.');
			setServerError(null);
			return;
		}
		const current = baseline ?? initial;
		// An edit that keeps its own name is never flagged, so old duplicates stay editable.
		const key = normalizeForMatch(trimmedName);
		const duplicate =
			(mode === 'create' || key !== normalizeForMatch(current?.name ?? '')) &&
			items.find((other) => other.id !== current?.id && normalizeForMatch(other.name) === key);
		if (duplicate) {
			setNameError(
				`Gibt es schon: ${duplicate.name} (${formatQuantity(duplicate.quantity, duplicate.unit)})`,
			);
			setServerError(null);
			return;
		}
		setSaving(true);
		setNameError(null);
		setServerError(null);
		// A name/threshold-only edit must not carry the version check: it would 409
		// whenever a housemate tapped +/- since the form was opened.
		const quantityChanged = mode === 'create' || !current || quantity !== current.quantity;
		const body = {
			name: trimmedName,
			unit,
			threshold,
			category,
			...(quantityChanged ? { quantity } : {}),
			...(mode === 'edit' && current && quantityChanged
				? { expectedQuantity: current.quantity, expectedUpdatedAt: current.updatedAt }
				: {}),
		};
		const fingerprint = JSON.stringify(body);
		const pendingRequest = createRequestRef.current;
		const idempotencyKey =
			mode === 'create'
				? pendingRequest?.fingerprint === fingerprint
					? pendingRequest.key
					: createOfflineIdempotencyKey()
				: null;
		if (mode === 'create' && !idempotencyKey) {
			setSaving(false);
			setServerError('Vorrat konnte nicht sicher gespeichert werden. Versuche es erneut.');
			return;
		}
		if (idempotencyKey) createRequestRef.current = { fingerprint, key: idempotencyKey };
		const res =
			mode === 'edit' && current
				? await apiFetch<{ item: InventoryMutationItemDto }>(
						`/api/wg/${encodedShareCode}/inventory/${encodeURIComponent(current.id)}`,
						{ method: 'PATCH', memberId, body: JSON.stringify(body) },
					)
				: await apiFetch<{ item: InventoryMutationItemDto }>(
						`/api/wg/${encodedShareCode}/inventory`,
						{
							method: 'POST',
							memberId,
							headers: { 'Idempotency-Key': idempotencyKey as string },
							body: JSON.stringify(body),
						},
					);
		if (res.ok) {
			setSaving(false);
			if (mode === 'create') createRequestRef.current = null;
			onSaved(res.data.item);
			toast.success(mode === 'edit' ? 'Vorrat aktualisiert.' : 'Vorrat gespeichert.');
			onClose();
		} else if (mode === 'edit' && current && res.status === 404 && res.error === 'item_not_found') {
			setSaving(false);
			onSaved(undefined, current.id);
			setConflictNeedsReload(true);
			setServerError('Dieser Vorrat wurde inzwischen entfernt. Schließe das Formular.');
		} else if (res.error === 'inventory_item_duplicate') {
			setSaving(false);
			if (mode === 'create') createRequestRef.current = null;
			setNameError('Diesen Vorrat gibt es schon.');
		} else if (mode === 'edit' && current && res.error === 'version_conflict') {
			const refreshed = await apiFetch<{ items: InventoryItemDto[] }>(
				`/api/wg/${encodedShareCode}/inventory`,
				{ memberId },
			);
			setSaving(false);
			const latest = refreshed.ok
				? (refreshed.data.items.find((item) => item.id === current.id) ?? null)
				: null;
			if (!latest) {
				onSaved(undefined, refreshed.ok ? current.id : undefined);
				setConflictNeedsReload(true);
				setServerError(
					'Dieser Vorrat wurde geändert, konnte aber nicht neu geladen werden. Schließe das Formular und öffne ihn erneut.',
				);
				return;
			}
			onSaved(latest);
			setBaseline(latest);
			// Keep what the user typed; only untouched fields follow the server state.
			if (trimmedName === current.name) setName(latest.name);
			setQuantityText(String(latest.quantity));
			if (unit === coerceUnit(current.unit)) setUnit(coerceUnit(latest.unit));
			if (threshold === current.threshold) setThresholdText(String(latest.threshold));
			if (category === coerceCategory(current.category)) {
				setCategory(coerceCategory(latest.category));
			}
			setConflictNeedsReload(false);
			onItemRefreshed(latest);
			setServerError(
				'Dieser Vorrat wurde inzwischen geändert. Der aktuelle Stand ist geladen; prüfe ihn und speichere erneut.',
			);
		} else if (
			mode === 'create' &&
			res.status > 0 &&
			res.status < 500 &&
			res.error !== 'name_invalid'
		) {
			setSaving(false);
			if (res.status !== 429) createRequestRef.current = null;
			setServerError('Speichern fehlgeschlagen. Bitte versuche es erneut.');
		} else if (res.error === 'name_invalid') {
			setSaving(false);
			if (mode === 'create') createRequestRef.current = null;
			setNameError('Bitte gib einen gültigen Namen ein.');
		} else {
			setSaving(false);
			setServerError('Speichern fehlgeschlagen. Bitte versuche es erneut.');
		}
	}

	return (
		<>
			<Drawer
				open={open}
				onOpenChange={(next) => {
					if (!next) requestClose();
				}}
			>
				<DrawerContent className="mx-auto w-full max-w-md">
					<DrawerHeader>
						<DrawerTitle>{mode === 'edit' ? 'Vorrat bearbeiten' : 'Neuer Vorrat'}</DrawerTitle>
					</DrawerHeader>

					<form
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
						className="flex min-h-0 flex-col"
					>
						<div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
							<InventoryFormFields
								mode={mode}
								name={name}
								quantityText={quantityText}
								thresholdText={thresholdText}
								unit={unit}
								category={category}
								quantity={quantity}
								threshold={threshold}
								nameError={nameError}
								disabled={saving || conflictNeedsReload}
								onNameChange={(value) => {
									setName(value);
									if (nameError) setNameError(null);
								}}
								onQuantityTextChange={setQuantityText}
								onThresholdTextChange={setThresholdText}
								onUnitChange={setUnit}
								onCategoryChange={setCategory}
							/>
						</div>
						{serverError && (
							<div className="shrink-0 px-4 pb-3">
								<Alert
									ref={alertRef}
									id="inventory-save-error"
									variant="destructive"
									tabIndex={-1}
									className="outline-none"
								>
									<AlertDescription>{serverError}</AlertDescription>
								</Alert>
							</div>
						)}
						<DrawerFooter className="border-t pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
							<Button type="submit" disabled={saving || conflictNeedsReload} aria-busy={saving}>
								{saving && <Spinner aria-hidden />}
								{saving ? 'Speichert…' : 'Speichern'}
							</Button>
							<Button type="button" variant="outline" onClick={requestClose}>
								Abbrechen
							</Button>
						</DrawerFooter>
					</form>
				</DrawerContent>
			</Drawer>
			<AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
				<AlertDialogContent className="w-[calc(100%-2rem)]">
					<AlertDialogHeader>
						<AlertDialogTitle>Änderungen verwerfen?</AlertDialogTitle>
						<AlertDialogDescription>
							Deine Eingaben wurden noch nicht gespeichert.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel className="min-h-11">Weiter bearbeiten</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							className="min-h-11"
							onClick={() => {
								setDiscardOpen(false);
								onClose();
							}}
						>
							Verwerfen
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
