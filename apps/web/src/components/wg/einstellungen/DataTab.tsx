'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import type { WgSummary } from '@/components/wg/WgContextProvider';
import { LinkRow } from '@/components/wg/einstellungen/LinkRow';
import { OfflineQueueSection } from '@/components/wg/einstellungen/OfflineQueueSection';
import { Section } from '@/components/wg/einstellungen/Section';
import { exportErrorMessage, readResponseErrorCode } from '@/core/guards/settings-errors';
import type { ExportSectionKey, ExportSectionSummary } from '@/core/reads/export';
import { cn } from '@/shared/lib/cn';
import type { StoredIdentity } from '@/shared/lib/identity';
import { memberAuthHeader } from '@/shared/lib/identity';
import { Download, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';

interface DataTabProps {
	wg: WgSummary;
	identity: StoredIdentity;
	exportSummary: ExportSectionSummary[];
	exportSummaryError: string | null;
}

export function DataTab({ wg, identity, exportSummary, exportSummaryError }: DataTabProps) {
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const wgBaseHref = `/wg/${encodedShareCode}`;
	const [exportError, setExportError] = useState<string | null>(null);
	const [exportMessage, setExportMessage] = useState<string | null>(null);
	const [exportPending, setExportPending] = useState<'json' | 'csv' | null>(null);
	const [csvExportSection, setCsvExportSection] = useState<ExportSectionKey>('expenses');
	const exportPendingRef = useRef(false);
	const csvExportLabel =
		exportSummary.find((item) => item.key === csvExportSection)?.label ?? 'CSV';

	async function downloadExport(format: 'json' | 'csv', section?: ExportSectionKey): Promise<void> {
		if (exportPendingRef.current) return;
		exportPendingRef.current = true;
		setExportError(null);
		setExportMessage(null);
		setExportPending(format);
		const csvSection = section ?? csvExportSection;
		try {
			const url =
				format === 'csv'
					? `/api/wg/${encodedShareCode}/export?format=csv&section=${encodeURIComponent(csvSection)}`
					: `/api/wg/${encodedShareCode}/export`;
			const res = await fetch(url, { headers: memberAuthHeader(identity.memberId) });
			if (!res.ok) {
				setExportError(exportErrorMessage(res.status, await readResponseErrorCode(res)));
				return;
			}
			const blob = await res.blob();
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
				format === 'csv'
					? `${exportSummary.find((item) => item.key === csvSection)?.label ?? 'CSV'}-Export gestartet. Die CSV-Datei wird im Browser-Download gespeichert.`
					: 'JSON-Export gestartet. Die Datei wird im Browser-Download gespeichert.',
			);
		} catch {
			setExportError(exportErrorMessage(0, 'Netzwerkfehler'));
		} finally {
			exportPendingRef.current = false;
			setExportPending(null);
		}
	}

	return (
		<>
			<Section
				title="Datenexport"
				hint="Ausgewählte WG-Daten, inklusive erledigter Zahlungen. Datei-Inhalte und Systemwiederherstellung sind nicht enthalten."
			>
				{exportSummary.length > 0 && (
					<div className="border-border grid grid-cols-2 gap-x-4 gap-y-1.5 border-b p-3 text-xs">
						{exportSummary.map((section) => (
							<div key={section.key} className="flex min-w-0 items-baseline gap-2">
								<span className="text-foreground font-mono font-medium tabular-nums">
									{section.count}
								</span>
								<span className="text-muted-foreground min-w-0 break-words">{section.label}</span>
							</div>
						))}
					</div>
				)}
				{exportSummaryError && (
					<p
						className="text-muted-foreground border-border block border-b px-4 py-2 text-[12px]"
						aria-live="polite"
					>
						{exportSummaryError} Downloads sind trotzdem möglich.
					</p>
				)}
				<div className="grid gap-2 p-3">
					<Button
						type="button"
						variant="outline"
						onClick={() => void downloadExport('json')}
						disabled={exportPending !== null}
						aria-label={
							exportPending === 'json'
								? 'WG-Daten werden als JSON exportiert'
								: 'WG-Daten als JSON exportieren'
						}
						className="w-full"
					>
						{exportPending === 'json' ? <Spinner aria-hidden /> : <Download aria-hidden />}
						JSON exportieren
					</Button>
					<Field>
						<FieldLabel htmlFor="csv-export-section">CSV-Bereich</FieldLabel>
						<NativeSelect
							id="csv-export-section"
							value={csvExportSection}
							disabled={exportPending !== null}
							onChange={(event) => setCsvExportSection(event.target.value as ExportSectionKey)}
							className="w-full text-base"
						>
							{exportSummary.map((section) => (
								<NativeSelectOption key={section.key} value={section.key}>
									{section.label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<Button
						type="button"
						variant="outline"
						onClick={() => void downloadExport('csv')}
						disabled={exportPending !== null}
						aria-label={
							exportPending === 'csv'
								? `${csvExportLabel} wird als CSV exportiert`
								: `${csvExportLabel} als CSV exportieren`
						}
						className="w-full"
					>
						{exportPending === 'csv' ? <Spinner aria-hidden /> : <Download aria-hidden />}
						CSV exportieren
					</Button>
				</div>
				{exportMessage && (
					<div className="px-4 pb-4">
						<Alert>
							<AlertDescription>{exportMessage}</AlertDescription>
						</Alert>
					</div>
				)}
				{exportError && (
					<div className="px-4 pb-4">
						<Alert variant="destructive">
							<AlertTitle>Export fehlgeschlagen</AlertTitle>
							<AlertDescription>{exportError}</AlertDescription>
						</Alert>
					</div>
				)}
			</Section>

			<Section
				title="Aus Splitwise oder Splid importieren"
				hint="Übernehme bestehende Ausgaben per CSV-Export oder Screenshot. Namen werden automatisch zugeordnet."
			>
				<div className="p-3">
					<Link
						href={`${wgBaseHref}/import`}
						className={cn(buttonVariants({ variant: 'default' }), 'w-full')}
					>
						<Upload aria-hidden />
						Ausgaben importieren
					</Link>
				</div>
			</Section>

			<OfflineQueueSection shareCode={wg.shareCode} memberId={identity.memberId} />

			<Section title="Rechtliches">
				<ul className="divide-border divide-y">
					<LinkRow href="https://manawg.com/impressum" label="Impressum" external />
					<LinkRow href="https://manawg.com/datenschutz" label="Datenschutz" external />
					<LinkRow href="https://manawg.com/agb" label="AGB" external />
				</ul>
			</Section>
		</>
	);
}
