'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useWg } from '@/components/wg/WgContextProvider';
import { mutationError, NETWORK_ERROR_CODE } from '@/core/http/error-codes';
import { apiFetch } from '@/core/infra/api-client';
import type { Message } from '@/shared/i18n/message';
import { useMessage } from '@/shared/i18n/message';
import { MEMBER_NAME_MAX_LENGTH } from '@/shared/lib/limits';

function renameErrorMessage(status: number, error: string): Message {
	if (status === 409 && error === 'name_taken') return { key: 'settings.memberName.errors.taken' };
	if (error === 'name_changed') return { key: 'settings.memberName.errors.changed' };
	const subject: Message = { key: 'settings.memberName.errors.subject' };
	return mutationError(
		subject,
		status === 0 ? NETWORK_ERROR_CODE : error,
		{},
		{
			key: 'common.errors.withSubject',
			values: { subject, detail: { key: 'common.errors.retry' } },
		},
	);
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
	const t = useTranslations('settings');
	const m = useMessage();
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
				{
					method: 'PATCH',
					memberId,
					body: JSON.stringify({ name: trimmed, expectedName: memberName }),
				},
			);
			if (!res.ok) {
				setError(m(renameErrorMessage(res.status, res.error)));
				return;
			}
			setSaved(true);
			await refreshMembers();
		} finally {
			setPending(false);
		}
	}

	return (
		<form onSubmit={(event) => void submit(event)} className="grid gap-2 px-3 pb-3">
			<Field orientation="horizontal" className="flex-wrap items-center gap-2">
				<FieldLabel htmlFor="member-name" className="sr-only">
					{t('memberName.label')}
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
					{t('actions.save')}
				</Button>
			</Field>
			<p className="text-muted-foreground text-xs">{t('memberName.mentionsHint')}</p>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			{saved && <output className="text-xs text-muted-foreground">{t('memberName.saved')}</output>}
		</form>
	);
}
