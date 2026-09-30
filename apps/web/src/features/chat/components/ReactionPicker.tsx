'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerHeader,
	DrawerTitle,
} from '@/components/ui/drawer';
import { Field, FieldLabel } from '@/components/ui/field';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { haptic } from '@/shared/lib/haptics';
import { type RefObject, useRef, useState } from 'react';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏', '🔥', '😢', '👀'] as const;

interface ReactionPickerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (emoji: string) => Promise<boolean>;
	/** Wird aus einem Menü geöffnet; danach geht der Fokus dorthin zurück. */
	returnFocusRef: RefObject<HTMLElement | null>;
}

export function ReactionPicker({
	open,
	onOpenChange: setOpen,
	onSelect,
	returnFocusRef,
}: ReactionPickerProps) {
	const [custom, setCustom] = useState('');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState(false);
	const pendingRef = useRef(false);

	async function select(emoji: string) {
		const value = emoji.trim();
		if (!value || pendingRef.current) return;
		pendingRef.current = true;
		setPending(true);
		setError(false);
		haptic('selection');
		try {
			if (await onSelect(value)) {
				setCustom('');
				setOpen(false);
			} else setError(true);
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	}

	return (
		<Drawer
			open={open}
			onOpenChange={(next) => {
				if (!pendingRef.current) {
					setOpen(next);
					setError(false);
				}
			}}
		>
			<DrawerContent finalFocus={returnFocusRef}>
				<DrawerHeader>
					<DrawerTitle>Reaktion wählen</DrawerTitle>
					<DrawerDescription>Ein Emoji für diese Nachricht.</DrawerDescription>
				</DrawerHeader>
				<div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
					<div className="grid grid-cols-4 gap-2">
						{QUICK_EMOJIS.map((emoji) => (
							<Button
								key={emoji}
								variant="outline"
								disabled={pending}
								aria-label={`Reaktion ${emoji}`}
								onClick={() => void select(emoji)}
							>
								{emoji}
							</Button>
						))}
					</div>
					<Field>
						<FieldLabel>Eigene Emoji-Reaktion</FieldLabel>
						<InputGroup>
							<InputGroupInput
								value={custom}
								onChange={(event) => setCustom(event.target.value)}
								disabled={pending}
								onKeyDown={(event) => {
									if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
										event.preventDefault();
										void select(custom);
									}
								}}
								aria-label="Eigene Emoji-Reaktion"
								placeholder="Emoji eingeben"
								className="text-base"
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									variant="default"
									size="sm"
									className="min-h-11"
									disabled={pending || !custom.trim()}
									onClick={() => void select(custom)}
								>
									{pending ? <Spinner /> : 'OK'}
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
					</Field>
					{error && (
						<Alert variant="destructive">
							<AlertDescription>Reaktion nicht gespeichert. Versuche es erneut.</AlertDescription>
						</Alert>
					)}
					<Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
						Schließen
					</Button>
				</div>
			</DrawerContent>
		</Drawer>
	);
}
