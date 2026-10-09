'use client';

import { BackButton } from '@/components/app/BackButton';
import { ErrorBox } from '@/components/app/ErrorBox';
import { Button } from '@/components/ui/button';
import { FieldDescription, FieldGroup, FieldLabel, Field as UiField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { extractInviteCode } from '@/core/infra/join-flow';
import { normalizeShareCode } from '@/core/utils/share-code';
import { ArrowRight } from 'lucide-react';
import type { StartField } from './start-flow';

interface JoinCodeStepProps {
	joinCode: string;
	onJoinCodeChange: (value: string) => void;
	error: string | null;
	invalidField: StartField | null;
	clearError: () => void;
	busy: boolean;
	onSubmit: () => void;
	onBack: () => void;
}

export function JoinCodeStep({
	joinCode,
	onJoinCodeChange,
	error,
	invalidField,
	clearError,
	busy,
	onSubmit,
	onBack,
}: JoinCodeStepProps) {
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
			className="flex flex-col gap-5"
		>
			<FieldGroup>
				<UiField data-invalid={invalidField === 'joinCode'}>
					<FieldLabel htmlFor="join-code">WG-Code</FieldLabel>
					<Input
						id="join-code"
						type="text"
						value={joinCode}
						onChange={(event) => {
							// Pasted codes often carry spaces or dashes ("ABCD 1234"); drop them (and
							// leave maxLength slack) so a paste is not cut off. Look-alikes (I/L/O/U)
							// are swapped right away so the field shows the code that gets checked.
							onJoinCodeChange(
								normalizeShareCode(event.target.value.replace(/[^a-z0-9]/gi, '')).slice(0, 8),
							);
							if (error) clearError();
						}}
						onPaste={(event) => {
							// maxLength cuts long pasted invites before onChange, so read the clipboard here.
							const code = extractInviteCode(event.clipboardData.getData('text'));
							if (!code) return;
							event.preventDefault();
							onJoinCodeChange(code);
							if (error) clearError();
						}}
						maxLength={16}
						required
						autoFocus
						autoComplete="off"
						autoCapitalize="characters"
						inputMode="text"
						enterKeyHint="done"
						placeholder="ABCD1234"
						aria-describedby={
							invalidField === 'joinCode' ? 'join-code-hint join-code-error' : 'join-code-hint'
						}
						aria-invalid={invalidField === 'joinCode'}
						className="font-mono text-base"
					/>
					<FieldDescription id="join-code-hint">Der Code hat 8 Zeichen.</FieldDescription>
				</UiField>
				{error && invalidField === 'joinCode' && <ErrorBox id="join-code-error">{error}</ErrorBox>}
			</FieldGroup>
			{error && invalidField !== 'joinCode' && (
				<ErrorBox id="join-code-form-error">{error}</ErrorBox>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<BackButton onClick={onBack} disabled={busy} />
				<Button
					type="submit"
					disabled={busy}
					aria-label={busy ? 'WG-Code wird geprüft…' : 'WG-Code prüfen'}
					className="flex-1"
				>
					{busy ? (
						<Spinner data-icon="inline-start" aria-hidden />
					) : (
						<ArrowRight data-icon="inline-start" aria-hidden />
					)}
					{busy ? 'Wird geprüft…' : 'Code prüfen'}
				</Button>
			</div>
		</form>
	);
}
