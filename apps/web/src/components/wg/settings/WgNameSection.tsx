'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Section } from '@/components/wg/settings/Section';
import { subjectError } from '@/components/wg/settings/settings-errors';
import { apiFetch } from '@/core/infra/api-client';
import { useMessage } from '@/shared/i18n/message';
import { WG_NAME_MAX_LENGTH } from '@/shared/lib/limits';

interface WgNameSectionProps {
	wgName: string;
	shareCode: string;
	memberId: string;
}

/** Admin-only rename of the flat. */
export function WgNameSection({ wgName, shareCode, memberId }: WgNameSectionProps) {
	const t = useTranslations('settings');
	const m = useMessage();
	const router = useRouter();
	const [name, setName] = useState(wgName);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		setName(wgName);
	}, [wgName]);

	const trimmed = name.trim();
	const unchanged = trimmed === wgName;

	async function submit(event: FormEvent): Promise<void> {
		event.preventDefault();
		if (pending || unchanged || !trimmed) return;
		setPending(true);
		setError(null);
		setSaved(false);
		try {
			const res = await apiFetch<unknown>(`/api/wg/${encodeURIComponent(shareCode)}`, {
				method: 'PATCH',
				memberId,
				body: JSON.stringify({ name: trimmed }),
			});
			if (!res.ok) {
				setError(
					res.status === 403
						? t('wgName.errors.adminOnly')
						: m(
								subjectError(
									'settings.wgName.errors.subject',
									res.status === 0 ? 'common.errors.network' : 'common.errors.retry',
								),
							),
				);
				return;
			}
			setSaved(true);
			router.refresh();
		} finally {
			setPending(false);
		}
	}

	return (
		<Section title={t('wgName.title')}>
			<form onSubmit={(event) => void submit(event)} className="grid gap-2 p-3">
				<Field orientation="horizontal" className="flex-wrap items-center gap-2">
					<FieldLabel htmlFor="wg-name" className="sr-only">
						{t('wgName.label')}
					</FieldLabel>
					<Input
						id="wg-name"
						value={name}
						maxLength={WG_NAME_MAX_LENGTH}
						onChange={(event) => {
							setName(event.target.value);
							setSaved(false);
						}}
						autoComplete="off"
						enterKeyHint="done"
						disabled={pending}
						className="min-w-0 flex-1 basis-40"
					/>
					<Button
						type="submit"
						disabled={pending || unchanged || !trimmed}
						className="h-11 shrink-0"
					>
						{pending && <Spinner data-icon="inline-start" aria-hidden />}
						{t('actions.save')}
					</Button>
				</Field>
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				{saved && <output className="text-xs text-muted-foreground">{t('wgName.saved')}</output>}
			</form>
		</Section>
	);
}
