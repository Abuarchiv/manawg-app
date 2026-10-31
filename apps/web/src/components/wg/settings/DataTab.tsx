'use client';

import { Download, Upload } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { LinkRow } from '@/components/wg/settings/LinkRow';
import { OfflineQueueSection } from '@/components/wg/settings/OfflineQueueSection';
import { Section } from '@/components/wg/settings/Section';
import { exportErrorMessage } from '@/components/wg/settings/settings-errors';
import type { WgSummary } from '@/components/wg/WgContextProvider';
import { getLocalAccount, type SessionMember } from '@/core/auth/local-account';
import { NETWORK_ERROR_CODE } from '@/core/http/error-codes';
import { noteSessionExpiry, readApiErrorCode } from '@/core/infra/api-client';
import type { Locale } from '@/shared/i18n/locale';
import type { Message } from '@/shared/i18n/message';
import { useMessage } from '@/shared/i18n/message';
import type de from '@/shared/i18n/messages/de';
import { cn } from '@/shared/lib/cn';
import { legalUrl } from '@/shared/lib/landing-url';
import { memberContextHeader } from '@/shared/lib/member-header';

// Empty when the instance has no legal pages configured.
function legalRows(locale: Locale) {
	return (
		[
			[legalUrl('/impressum', locale), 'legal.imprint'],
			[legalUrl('/datenschutz', locale), 'legal.privacy'],
			[legalUrl('/agb', locale), 'legal.terms'],
		] as const
	).flatMap(([href, label]) => (href ? [{ href, label }] : []));
}

type ExportSectionKey = keyof (typeof de)['settings']['data']['sections'];

/** One exportable section as the export summary lists it; `key` is the CSV `section` parameter. */
interface ExportSectionOption {
	key: ExportSectionKey;
	count: number;
}

interface DataTabProps {
	wg: WgSummary;
	identity: SessionMember;
	exportSummary: ExportSectionOption[];
	exportSummaryError: Message | null;
	/** False until the counts arrived: the summary then still holds placeholder zeros. */
	exportCountsLoaded: boolean;
}

export function DataTab({
	wg,
	identity,
	exportSummary,
	exportSummaryError,
	exportCountsLoaded,
}: DataTabProps) {
	const t = useTranslations('settings.data');
	const legal = legalRows(useLocale() as Locale);
	const m = useMessage();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const wgBaseHref = `/wg/${encodedShareCode}`;
	const [exportError, setExportError] = useState<string | null>(null);
	const [exportMessage, setExportMessage] = useState<string | null>(null);
	const [exportPending, setExportPending] = useState<'json' | 'csv' | null>(null);
	const [csvExportSection, setCsvExportSection] = useState('expenses');
	const exportPendingRef = useRef(false);
	const exportAbortRef = useRef<AbortController | null>(null);
	useEffect(() => () => exportAbortRef.current?.abort(), []);
	const sectionLabel = (key: string) =>
		exportSummary.some((item) => item.key === key)
			? t(`sections.${key as ExportSectionKey}`)
			: 'CSV';
	const csvExportLabel = sectionLabel(csvExportSection);

	async function downloadExport(format: 'json' | 'csv', section?: string): Promise<void> {
		if (exportPendingRef.current) return;
		exportPendingRef.current = true;
		setExportError(null);
		setExportMessage(null);
		setExportPending(format);
		const abort = new AbortController();
		exportAbortRef.current = abort;
		const account = getLocalAccount();
		const isCurrent = () => !abort.signal.aborted && getLocalAccount() === account;
		const csvSection = section ?? csvExportSection;
		try {
			const url =
				format === 'csv'
					? `/api/wg/${encodedShareCode}/export?format=csv&section=${encodeURIComponent(csvSection)}`
					: `/api/wg/${encodedShareCode}/export`;
			const res = await fetch(url, {
				headers: memberContextHeader(identity.memberId),
				signal: abort.signal,
			});
			if (!isCurrent()) return;
			noteSessionExpiry(res, account);
			if (!res.ok) {
				const code = await readApiErrorCode(res);
				if (isCurrent()) setExportError(m(exportErrorMessage(res.status, code || null)));
				return;
			}
			const blob = await res.blob();
			if (!isCurrent()) return;
			const href = window.URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = href;
			a.download = `${wg.shareCode}-${format === 'csv' ? `${csvSection}.csv` : 'export.json'}`;
			a.style.display = 'none';
			document.body.appendChild(a);
			a.click();
			a.remove();
			window.setTimeout(() => window.URL.revokeObjectURL(href), 0);
			setExportMessage(
				format === 'csv' ? t('csvStarted', { label: sectionLabel(csvSection) }) : t('jsonStarted'),
			);
		} catch {
			if (isCurrent()) setExportError(m(exportErrorMessage(0, NETWORK_ERROR_CODE)));
		} finally {
			if (exportAbortRef.current === abort) exportAbortRef.current = null;
			exportPendingRef.current = false;
			setExportPending(null);
		}
	}

	return (
		<>
			<Section title={t('exportTitle')} hint={t('exportHint')}>
				{exportCountsLoaded && !exportSummaryError && (
					<div className="border-border grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-x-4 gap-y-1.5 border-b p-3 text-xs">
						{exportSummary.map((section) => (
							<div key={section.key} className="flex min-w-0 items-baseline gap-2">
								<span className="text-foreground font-mono font-medium tabular-nums">
									{section.count}
								</span>
								<span className="text-muted-foreground min-w-0 break-words">
									{t(`sections.${section.key}`)}
								</span>
							</div>
						))}
					</div>
				)}
				{exportSummaryError && (
					<p
						className="text-muted-foreground border-border block border-b p-3 text-xs"
						aria-live="polite"
					>
						{t('summaryError', { error: m(exportSummaryError) })}
					</p>
				)}
				<div className="grid gap-2 p-3">
					<Button
						type="button"
						variant="outline"
						onClick={() => void downloadExport('json')}
						disabled={exportPending !== null}
						aria-label={exportPending === 'json' ? t('jsonPendingAria') : t('jsonAria')}
						className="h-11 w-full"
					>
						{exportPending === 'json' ? <Spinner aria-hidden /> : <Download aria-hidden />}
						{t('json')}
					</Button>
					<div className="flex flex-wrap gap-2">
						<NativeSelect
							id="csv-export-section"
							aria-label={t('csvSectionAria')}
							value={csvExportSection}
							disabled={exportPending !== null}
							onChange={(event) => setCsvExportSection(event.target.value)}
							className="min-w-0 max-w-full flex-1 basis-36 text-base"
						>
							{exportSummary.map((section) => (
								<NativeSelectOption key={section.key} value={section.key}>
									{t(`sections.${section.key}`)}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<Button
							type="button"
							variant="outline"
							onClick={() => void downloadExport('csv')}
							disabled={exportPending !== null}
							aria-label={
								exportPending === 'csv'
									? t('csvPendingAria', { label: csvExportLabel })
									: t('csvAria', { label: csvExportLabel })
							}
							className="h-11 min-w-fit flex-1"
						>
							{exportPending === 'csv' ? <Spinner aria-hidden /> : <Download aria-hidden />}
							{t('csv')}
						</Button>
					</div>
				</div>
				{exportMessage && (
					<div className="p-3 pt-0">
						<Alert>
							<AlertDescription>{exportMessage}</AlertDescription>
						</Alert>
					</div>
				)}
				{exportError && (
					<div className="p-3 pt-0">
						<Alert variant="destructive">
							<AlertTitle>{t('failedTitle')}</AlertTitle>
							<AlertDescription>{exportError}</AlertDescription>
						</Alert>
					</div>
				)}
			</Section>

			<Section title={t('importTitle')}>
				<div className="p-3">
					<Link
						href={`${wgBaseHref}/import`}
						className={cn(buttonVariants({ variant: 'outline' }), 'h-11 w-full')}
					>
						<Upload aria-hidden />
						{t('importExpenses')}
					</Link>
				</div>
			</Section>

			<OfflineQueueSection shareCode={wg.shareCode} memberId={identity.memberId} />

			{legal.length > 0 && (
				<Section title={t('legalTitle')}>
					<ul className="divide-border divide-y">
						{legal.map(({ href, label }) => (
							<LinkRow key={href} href={href} label={t(label)} external />
						))}
					</ul>
				</Section>
			)}
		</>
	);
}
