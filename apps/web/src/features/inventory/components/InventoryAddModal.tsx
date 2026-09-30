'use client';

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
	DrawerDescription,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
} from '@/components/ui/drawer';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import {
	INVENTORY_CATEGORIES,
	INVENTORY_CATEGORY_LABELS,
	INVENTORY_LIMITS,
	INVENTORY_UNITS,
	type InventoryCategory,
	type InventoryItemDto,
	type InventoryMutationItemDto,
	type InventoryUnit,
	isBelowThreshold,
} from '@/features/inventory/inventory';
import { useEffect, useRef, useState } from 'react';

interface InventoryAddModalProps {
	open: boolean;
	shareCode: string;
	memberId: string;
	memberToken?: string | undefined;
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
	onClose: () => void;
	onSaved: (item?: InventoryMutationItemDto, deletedId?: string) => void;
	onItemRefreshed: (item: InventoryItemDto) => void;
}

type InventoryEditorItem = NonNullable<InventoryAddModalProps['initial']>;

const DEFAULT_UNIT: InventoryUnit = 'Stück';
const DEFAULT_CATEGORY: InventoryCategory = 'sonstiges';

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
	memberToken,
	mode,
	initial,
	onClose,
	onSaved,
	onItemRefreshed,
}: InventoryAddModalProps) {
	const encodedShareCode = encodeURIComponent(shareCode);
	const [name, setName] = useState('');
	const [quantity, setQuantity] = useState(0);
	const [unit, setUnit] = useState<InventoryUnit>(DEFAULT_UNIT);
	const [threshold, setThreshold] = useState(1);
	const [category, setCategory] = useState<InventoryCategory>(DEFAULT_CATEGORY);
	const [baseline, setBaseline] = useState<InventoryEditorItem | null>(initial ?? null);
	const [saving, setSaving] = useState(false);
	const [conflictNeedsReload, setConflictNeedsReload] = useState(false);
	const [discardOpen, setDiscardOpen] = useState(false);
	const [nameError, setNameError] = useState<string | null>(null);
	const [serverError, setServerError] = useState<string | null>(null);
	const createRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const initialRef = useRef(initial);

	useEffect(() => {
		initialRef.current = initial;
	}, [initial]);

	useEffect(() => {
		if (!open) return;
		const current = initialRef.current ?? null;
		setBaseline(current);
		setName(current?.name ?? '');
		setQuantity(current?.quantity ?? 0);
		setUnit(coerceUnit(current?.unit));
		setThreshold(current?.threshold ?? 1);
		setCategory(coerceCategory(current?.category));
		setConflictNeedsReload(false);
		setNameError(null);
		setServerError(null);
	}, [open]);

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
		setSaving(true);
		setNameError(null);
		setServerError(null);
		const current = baseline ?? initial;
		const body = {
			name: trimmedName,
			quantity,
			unit,
			threshold,
			category,
			...(mode === 'edit' && current
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
						{ method: 'PATCH', memberId, memberToken, body: JSON.stringify(body) },
					)
				: await apiFetch<{ item: InventoryMutationItemDto }>(
						`/api/wg/${encodedShareCode}/inventory`,
						{
							method: 'POST',
							memberId,
							memberToken,
							headers: { 'Idempotency-Key': idempotencyKey as string },
							body: JSON.stringify(body),
						},
					);
		if (res.ok) {
			setSaving(false);
			if (mode === 'create') createRequestRef.current = null;
			onSaved(res.data.item);
			onClose();
		} else if (mode === 'edit' && current && res.error === 'version_conflict') {
			const refreshed = await apiFetch<{ items: InventoryItemDto[] }>(
				`/api/wg/${encodedShareCode}/inventory`,
				{ memberId, memberToken },
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
			setName(latest.name);
			setQuantity(latest.quantity);
			setUnit(coerceUnit(latest.unit));
			setThreshold(latest.threshold);
			setCategory(coerceCategory(latest.category));
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
		<Drawer
			open={open}
			onOpenChange={(next) => {
				if (!next) requestClose();
			}}
		>
			<DrawerContent className="mx-auto w-full max-w-md">
				<DrawerHeader>
					<DrawerTitle>{mode === 'edit' ? 'Vorrat bearbeiten' : 'Neuer Vorrat'}</DrawerTitle>
					<DrawerDescription>
						{mode === 'edit'
							? 'Menge, Einheit, Kategorie und „Nachkaufen ab“ anpassen.'
							: 'Name, Menge, Einheit, Kategorie und „Nachkaufen ab“ festlegen.'}
					</DrawerDescription>
				</DrawerHeader>

				<form
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
					className="flex min-h-0 flex-col"
				>
					<div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
						<FieldGroup>
							<Field data-invalid={Boolean(nameError)}>
								<FieldLabel htmlFor="inventory-name">Name</FieldLabel>
								<Input
									id="inventory-name"
									type="text"
									value={name}
									onChange={(event) => {
										setName(event.target.value);
										if (nameError) setNameError(null);
									}}
									maxLength={INVENTORY_LIMITS.NAME_MAX}
									required
									aria-required="true"
									aria-invalid={Boolean(nameError)}
									aria-describedby={nameError ? 'inventory-name-error' : undefined}
									placeholder="z. B. Nudeln"
									disabled={saving || conflictNeedsReload}
									enterKeyHint="next"
									className="text-base"
								/>
								{nameError && <FieldError id="inventory-name-error">{nameError}</FieldError>}
							</Field>
							<div className="grid grid-cols-1 gap-2">
								<Field className="min-w-0">
									<FieldLabel htmlFor="inventory-qty">Menge</FieldLabel>
									<Input
										id="inventory-qty"
										type="number"
										inputMode="numeric"
										value={quantity}
										min={INVENTORY_LIMITS.QUANTITY_MIN}
										max={INVENTORY_LIMITS.QUANTITY_MAX}
										onChange={(event) => setQuantity(Number(event.target.value) || 0)}
										disabled={saving || conflictNeedsReload}
										className="text-base"
									/>
								</Field>
								<Field className="min-w-0">
									<FieldLabel htmlFor="inventory-threshold">Nachkaufen ab</FieldLabel>
									<Input
										id="inventory-threshold"
										type="number"
										inputMode="numeric"
										value={threshold}
										min={INVENTORY_LIMITS.THRESHOLD_MIN}
										max={INVENTORY_LIMITS.THRESHOLD_MAX}
										onChange={(event) => setThreshold(Number(event.target.value) || 0)}
										disabled={saving || conflictNeedsReload}
										className="text-base"
									/>
								</Field>
							</div>
							<div className="grid grid-cols-1 gap-2">
								<Field className="min-w-0">
									<FieldLabel htmlFor="inventory-unit">Einheit</FieldLabel>
									<NativeSelect
										id="inventory-unit"
										value={unit}
										onChange={(event) => setUnit(event.target.value as InventoryUnit)}
										disabled={saving || conflictNeedsReload}
										className="w-full [&_select]:min-h-11 [&_select]:text-base"
									>
										{INVENTORY_UNITS.map((u) => (
											<NativeSelectOption key={u} value={u}>
												{u}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</Field>
								<Field className="min-w-0">
									<FieldLabel htmlFor="inventory-category">Kategorie</FieldLabel>
									<NativeSelect
										id="inventory-category"
										value={category}
										onChange={(event) => setCategory(event.target.value as InventoryCategory)}
										disabled={saving || conflictNeedsReload}
										className="w-full [&_select]:min-h-11 [&_select]:text-base"
									>
										{INVENTORY_CATEGORIES.map((cat) => (
											<NativeSelectOption key={cat} value={cat}>
												{INVENTORY_CATEGORY_LABELS[cat]}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</Field>
							</div>
							<FieldDescription aria-live="polite">
								{mode === 'create' && isBelowThreshold({ quantity, threshold })
									? 'Die Menge liegt nicht über „Nachkaufen ab“ – der Vorrat kommt beim Speichern direkt auf die Einkaufsliste.'
									: 'Wenn der Bestand diesen Wert erreicht, wird der Vorrat als niedrig markiert und auf die Einkaufsliste gesetzt.'}
							</FieldDescription>
						</FieldGroup>
						{serverError && (
							<Alert id="inventory-save-error" variant="destructive">
								<AlertDescription>{serverError}</AlertDescription>
							</Alert>
						)}
					</div>
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
			</DrawerContent>
		</Drawer>
	);
}
