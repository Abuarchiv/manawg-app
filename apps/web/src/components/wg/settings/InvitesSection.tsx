'use client';

import { Copy, Plus, Share2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/Toast';
import { InviteByMailForm } from '@/components/wg/InviteByMailForm';
import { createInvite, inviteShareMessage, shareInvite } from '@/components/wg/invite-share';
import { Section } from '@/components/wg/settings/Section';
import type { WgSummary } from '@/components/wg/WgContextProvider';
import type { SessionMember } from '@/core/auth/local-account';
import { useCachedFetch } from '@/core/hooks/use-cached-fetch';
import { apiFetch } from '@/core/infra/api-client';
import { copyText } from '@/core/utils/clipboard';
import { INVITE_VALID_DAYS } from '@/core/utils/invite-token';
import { dateTimeFormat } from '@/shared/i18n/intl';
import type { Locale } from '@/shared/i18n/locale';
import { useMessage } from '@/shared/i18n/message';

interface InviteListItem {
	id: string;
	expiresAt: string;
	maxUses: number;
	useCount: number;
	createdByName: string | null;
}

function expiryDate(expiresAt: string, locale: Locale): string {
	return dateTimeFormat(locale, {
		day: 'numeric',
		month: 'short',
		timeZone: 'Europe/Berlin',
	}).format(new Date(expiresAt));
}

/** Invitation links of the WG: create and share one, see the active ones, revoke them. */
export function InvitesSection({ wg, identity }: { wg: WgSummary; identity: SessionMember }) {
	const t = useTranslations('settings.invites');
	const locale = useLocale();
	const toast = useToast();
	const render = useMessage();
	const encodedCode = encodeURIComponent(wg.shareCode);
	const listUrl = `/api/wg/${encodedCode}/invites`;
	const {
		data,
		error: loadError,
		refresh,
	} = useCachedFetch<{ invites: InviteListItem[] }>(listUrl, { memberId: identity.memberId });
	const [creating, setCreating] = useState(false);
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const busyRef = useRef(false);

	async function create(): Promise<void> {
		if (busyRef.current) return;
		busyRef.current = true;
		setCreating(true);
		setError(null);
		setMessage(null);
		try {
			const result = await createInvite(wg.shareCode, identity.memberId);
			if (!result.ok) {
				setError(render(result.message));
				return;
			}
			setFresh({ id: result.invite.id, url: result.invite.url });
			void refresh({ afterMutation: true });
		} finally {
			busyRef.current = false;
			setCreating(false);
		}
	}

	async function share(url: string): Promise<void> {
		const outcome = await shareInvite(render(inviteShareMessage(wg.name, url)), url);
		if (outcome === 'copied') toast.success(t('shared'));
		if (outcome === 'failed') toast.error(t('shareFailed'));
	}

	async function copy(url: string): Promise<void> {
		if (await copyText(url)) toast.success(t('copied'));
		else toast.error(t('copyFailed'));
	}

	async function revoke(id: string): Promise<void> {
		if (busyRef.current) return;
		busyRef.current = true;
		setRevokingId(id);
		setError(null);
		setMessage(null);
		try {
			const res = await apiFetch<{ revoked: true }>(`${listUrl}/${encodeURIComponent(id)}`, {
				method: 'DELETE',
				memberId: identity.memberId,
			});
			if (!res.ok && res.status !== 404) {
				setError(t('revokeFailed'));
				return;
			}
			setMessage(t('revoked'));
			setFresh((current) => (current?.id === id ? null : current));
			void refresh({ afterMutation: true });
		} finally {
			busyRef.current = false;
			setRevokingId(null);
		}
	}

	const invites = data?.invites ?? [];

	return (
		<>
			<Section id="invites" title={t('title')} hint={t('hint', { days: INVITE_VALID_DAYS })}>
				{/* minmax(0,1fr): otherwise a non-wrapping button widens the whole card at 200 % text. */}
				<div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3">
					<Button
						type="button"
						onClick={() => void create()}
						disabled={creating || revokingId !== null}
						aria-busy={creating}
						className="h-auto min-h-11 w-full whitespace-normal"
					>
						{creating ? <Spinner aria-hidden /> : <Plus aria-hidden />}
						{t('create')}
					</Button>
					{fresh && (
						<div className="grid gap-2 rounded-lg border border-border p-3">
							<p className="text-muted-foreground text-xs">{t('newLink')}</p>
							<div
								role="img"
								aria-label={t('qrAlt')}
								className="mx-auto w-fit rounded-lg bg-white p-3"
							>
								<QRCode value={fresh.url} size={148} level="M" />
							</div>
							<p className="text-foreground break-all text-sm">{fresh.url}</p>
							<div className="flex gap-2">
								<Button
									type="button"
									variant="outline"
									className="flex-1"
									onClick={() => void share(fresh.url)}
								>
									<Share2 aria-hidden />
									{t('share')}
								</Button>
								<Button
									type="button"
									variant="outline"
									className="flex-1"
									aria-label={t('copyAria')}
									onClick={() => void copy(fresh.url)}
								>
									<Copy aria-hidden />
									{t('copy')}
								</Button>
							</div>
						</div>
					)}
					{message && (
						<Alert>
							<AlertDescription>{message}</AlertDescription>
						</Alert>
					)}
					{(error || loadError) && (
						<Alert variant="destructive">
							<AlertDescription>{error ?? t('loadFailed')}</AlertDescription>
						</Alert>
					)}
					<ul className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-label={t('listLabel')}>
						{invites.map((invite) => (
							<li
								key={invite.id}
								className="flex min-h-11 flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
							>
								<div className="min-w-0">
									<p className="text-foreground text-sm font-medium">
										{t('createdBy', {
											creator: invite.createdByName ? 'named' : 'former',
											name: invite.createdByName ?? '',
										})}
									</p>
									<p className="text-muted-foreground text-xs">
										{t('usage', {
											date: expiryDate(invite.expiresAt, locale),
											used: String(invite.useCount),
											max: String(invite.maxUses),
										})}
									</p>
								</div>
								<Button
									type="button"
									variant="outline"
									className="shrink-0"
									disabled={creating || revokingId !== null}
									aria-label={t('revokeAria', {
										creator: invite.createdByName ? 'named' : 'former',
										name: invite.createdByName ?? '',
									})}
									onClick={() => void revoke(invite.id)}
								>
									{revokingId === invite.id && <Spinner aria-hidden />}
									{t('revoke')}
								</Button>
							</li>
						))}
					</ul>
					{data && invites.length === 0 && (
						<p className="text-muted-foreground text-sm">{t('empty')}</p>
					)}
					<InviteByMailForm
						shareCode={wg.shareCode}
						memberId={identity.memberId}
						onSent={() => void refresh({ afterMutation: true })}
					/>
				</div>
			</Section>

			<Section title={t('addressTitle')}>
				<div className="p-3">
					<p className="text-foreground font-mono text-base font-medium tracking-[0.05em]">
						{wg.shareCode}
					</p>
					<p className="text-muted-foreground mt-1 text-xs">{t('addressHint')}</p>
				</div>
			</Section>
		</>
	);
}
