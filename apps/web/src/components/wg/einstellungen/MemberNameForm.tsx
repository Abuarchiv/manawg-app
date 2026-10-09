'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useWg } from '@/components/wg/WgContextProvider';
import { RATE_LIMITED_MESSAGE } from '@/core/http/error-codes';
import { apiFetch } from '@/core/infra/api-client';
import { joinErrorMessage } from '@/core/infra/join-flow';
import { MEMBER_NAME_MAX_LENGTH } from '@/shared/lib/limits';
import { type FormEvent, useEffect, useState } from 'react';

function renameErrorMessage(status: number, error: string): string {
	if (error === 'name_taken') return joinErrorMessage(status, error);
	if (status === 429) return RATE_LIMITED_MESSAGE;
	if (status === 0) {
		return 'Name konnte nicht geändert werden: Prüfe deine Verbindung und versuche es erneut.';
	}
	return 'Name konnte nicht geändert werden: Versuche es gleich erneut.';
}

/** Lets a member fix their own display name (typo, nickname). */
export function MemberNameForm({
	memberName,
	shareCode,
	memberId,
}: {
	memberName: string;
	shareCode: string;
	memberId: string;
}) {
	const { refreshMembers } = useWg();
	const [name, setName] = useState(memberName);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		setName(memberName);
	}, [memberName]);

	const trimmed = name.trim();
	const unchanged = trimmed === memberName;

	async function submit(event: FormEvent): Promise<void> {
		event.preventDefault();
		if (pending || unchanged || !trimmed) return;
		setPending(true);
		setError(null);
		setSaved(false);
		try {
			const res = await apiFetch<unknown>(
				`/api/wg/${encodeURIComponent(shareCode)}/members/${encodeURIComponent(memberId)}`,
				{ method: 'PATCH', memberId, body: JSON.stringify({ name: trimmed }) },
			);
			if (!res.ok) {
				setError(renameErrorMessage(res.status, res.error));
				return;
			}
			setSaved(true);
			await refreshMembers(memberId);
		} finally {
			setPending(false);
		}
	}

	return (
		<form onSubmit={(event) => void submit(event)} className="grid gap-2 px-3 pb-3">
			<Field orientation="horizontal" className="flex-wrap items-center gap-2">
				<FieldLabel htmlFor="member-name" className="sr-only">
					Dein Name
				</FieldLabel>
				<Input
					id="member-name"
					value={name}
					maxLength={MEMBER_NAME_MAX_LENGTH}
					onChange={(event) => {
						setName(event.target.value);
						setSaved(false);
					}}
					autoComplete="off"
					enterKeyHint="done"
					disabled={pending}
					className="min-w-0 flex-1 basis-40"
				/>
				<Button type="submit" disabled={pending || unchanged || !trimmed} className="h-11 shrink-0">
					{pending && <Spinner data-icon="inline-start" aria-hidden />}
					Speichern
				</Button>
			</Field>
			<p className="text-muted-foreground text-xs">
				Alte @Erwähnungen im Chat bleiben mit dem alten Namen stehen.
			</p>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			{saved && <output className="text-xs text-muted-foreground">Name gespeichert.</output>}
		</form>
	);
}
