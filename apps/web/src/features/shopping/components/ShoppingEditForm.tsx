import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { NAME_MAX, QUANTITY_MAX } from '@/features/shopping/components/constants';
import type { ShoppingItem } from '@/features/shopping/components/shopping-types';
import type { ShoppingEditResult } from '@/features/shopping/hooks/use-shopping-edit';
import { useEffect, useRef, useState } from 'react';

interface ShoppingEditFormProps {
	item: ShoppingItem;
	onSave: (fields: { name: string; quantity: string | null }) => Promise<ShoppingEditResult>;
	onDone: () => void;
}

/** Name and amount of one item, shown inside the item's action drawer. */
export function ShoppingEditForm({ item, onSave, onDone }: ShoppingEditFormProps) {
	const [name, setName] = useState(item.name);
	const [quantity, setQuantity] = useState(item.quantity ?? '');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const idBase = `shopping-edit-${item.id}`;

	// The trigger button is gone once the form opens: move focus into the form.
	useEffect(() => {
		nameRef.current?.focus();
	}, []);

	async function submit(): Promise<void> {
		setSaving(true);
		setError(null);
		const message = await onSave({ name, quantity: quantity.trim() || null });
		setSaving(false);
		if (message === null) onDone();
		else setError(message);
	}

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idBase}-name`}>Name</Label>
				<Input
					ref={nameRef}
					id={`${idBase}-name`}
					value={name}
					onChange={(event) => setName(event.target.value)}
					maxLength={NAME_MAX}
					enterKeyHint="next"
					required
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idBase}-quantity`}>Menge (optional)</Label>
				<Input
					id={`${idBase}-quantity`}
					value={quantity}
					onChange={(event) => setQuantity(event.target.value)}
					maxLength={QUANTITY_MAX}
					enterKeyHint="done"
				/>
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			<div className="flex gap-2">
				<Button type="submit" disabled={saving || name.trim().length === 0}>
					{saving && <Spinner data-icon="inline-start" aria-hidden />}
					Speichern
				</Button>
				<Button type="button" variant="outline" onClick={onDone} disabled={saving}>
					Abbrechen
				</Button>
			</div>
		</form>
	);
}
