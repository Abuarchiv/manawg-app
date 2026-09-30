'use client';

import { Checkbox } from '@/components/animate-ui/components/base/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useWg } from '@/components/wg/WgContextProvider';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import type { ParsedExpense } from '@/features/expenses/import-parsers';
import { OcrInitializationError, runOcrOnImage } from '@/features/expenses/ocr';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ImportMemberMapping } from './ImportMemberMapping';
import { ImportPreviewTable } from './ImportPreviewTable';
import { ImportProgress } from './ImportProgress';
import { type ImportSourceKind, ImportSourcePicker } from './ImportSourcePicker';

type Step = 'source' | 'input' | 'mapping' | 'preview' | 'commit';

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface PreviewResponse {
	parsed: ParsedExpense[];
	payloadHash: string;
	memberMapping: Record<string, string | null>;
	conflicts: string[];
	members: Array<{ id: string; name: string }>;
}

type CommitWarning = null | 'notification_delivery_failed' | 'notification_delivery_unknown';

interface CommitResponse {
	importId: string;
	inserted: number;
	skipped: number;
	errors: Array<{ index: number; reason: string }>;
	warning: CommitWarning;
}

type ImportOperation = 'preview' | 'commit';
type RecoveryAction =
	| { kind: 'retry_preview'; label: string }
	| { kind: 'retry_commit'; label: string }
	| { kind: 'input'; label: string }
	| { kind: 'mapping'; label: string }
	| { kind: 'preview'; label: string };

const IMPORT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
	Netzwerkfehler: 'Prüfe deine Verbindung und versuche es erneut.',
	'Failed to fetch': 'Prüfe deine Verbindung und versuche es erneut.',
	too_many_requests: 'Zu viele Importversuche. Warte kurz und versuche es erneut.',
	unexpected_error: 'Der Import konnte gerade nicht verarbeitet werden. Versuche es gleich erneut.',
	server_error: 'Der Import konnte gerade nicht verarbeitet werden. Versuche es gleich erneut.',
	db_error: 'Der Import konnte gerade nicht verarbeitet werden. Versuche es gleich erneut.',
	wg_not_found: 'Die WG wurde nicht gefunden. Öffne den aktuellen WG-Link erneut.',
	invalid_share_code: 'Der WG-Link ist ungültig. Öffne die WG erneut.',
	auth_required: 'Öffne die WG erneut, damit deine Mitgliedschaft geladen wird.',
	not_a_member: 'Deine WG-Zuordnung fehlt. Tritt der WG erneut bei.',
	member_id_required: 'Deine WG-Zuordnung fehlt. Tritt der WG erneut bei.',
	member_id_invalid: 'Deine WG-Zuordnung ist ungültig. Tritt der WG erneut bei.',
	member_deactivated: 'Deine Mitgliedschaft ist nicht mehr aktiv. Tritt der WG erneut bei.',
	member_not_verified: 'Bestätige deine Mitgliedschaft erneut, bevor du importierst.',
	member_not_in_wg:
		'Mindestens eine Zuordnung gehört nicht mehr zu dieser WG. Prüfe die Zuordnung.',
	mapping_incomplete: 'Bitte ordne alle Namen einem WG-Mitglied zu.',
	payload_changed: 'Die Eingabe wurde nach der Vorschau geändert. Erstelle die Vorschau neu.',
	payload_too_large:
		'Die Datei ist zu groß. Wähle eine kleinere Datei (CSV bis 5 MB, Bild bis 10 MB).',
	unsupported_currency:
		'Diese Datei enthält keine unterstützte Währung. Verwende einen Export in Euro (EUR).',
	empty_payload: 'Keine Ausgaben gefunden. Prüfe die Datei und versuche es erneut.',
	invalid_skip_indexes: 'Die Auswahl ist veraltet. Öffne die Vorschau erneut.',
	preview_hash_required: 'Die Vorschau fehlt. Erstelle sie erneut.',
	invalid_body:
		'Die Importdaten konnten nicht gelesen werden. Prüfe den Export und versuche es erneut.',
	invalid_json:
		'Die Importdaten konnten nicht gelesen werden. Prüfe den Export und versuche es erneut.',
	payer_unmapped: 'Der Zahler konnte nicht zugeordnet werden. Prüfe die Zuordnung.',
	no_valid_splits: 'Keine gültige Aufteilung gefunden. Prüfe die Anteile.',
	split_sum_mismatch: 'Die Anteile ergeben nicht den Gesamtbetrag. Prüfe die Datei.',
	insert_failed: 'Dieser Eintrag konnte nicht gespeichert werden. Versuche es erneut.',
	import_insert_failed:
		'Der Import konnte gerade nicht gespeichert werden. Versuche es gleich erneut.',
};

function importActionErrorMessage(error: string): string {
	return (
		IMPORT_ERROR_MESSAGES[error] ??
		'Der Import konnte nicht abgeschlossen werden. Versuche es erneut.'
	);
}

function recoveryActionFor(error: string, operation: ImportOperation): RecoveryAction | null {
	if (
		error === 'mapping_incomplete' ||
		error === 'member_not_in_wg' ||
		error === 'payer_unmapped'
	) {
		return { kind: 'mapping', label: 'Zuordnung prüfen' };
	}
	if (error === 'invalid_skip_indexes' || error === 'preview_hash_required') {
		return { kind: 'preview', label: 'Vorschau öffnen' };
	}
	if (
		error === 'payload_changed' ||
		error === 'payload_too_large' ||
		error === 'unsupported_currency' ||
		error === 'empty_payload' ||
		error === 'invalid_body' ||
		error === 'invalid_json' ||
		error === 'no_valid_splits' ||
		error === 'split_sum_mismatch'
	) {
		return { kind: 'input', label: 'Eingabe korrigieren' };
	}
	if (
		error === 'Netzwerkfehler' ||
		error === 'Failed to fetch' ||
		error === 'too_many_requests' ||
		error === 'unexpected_error' ||
		error === 'server_error' ||
		error === 'db_error'
	) {
		return {
			kind: operation === 'preview' ? 'retry_preview' : 'retry_commit',
			label: 'Erneut versuchen',
		};
	}
	return null;
}

function payloadKey(source: ImportSourceKind): 'splitwise_csv' | 'splid_csv' | 'ocr_text' {
	if (source === 'splitwise_csv') return 'splitwise_csv';
	if (source === 'splid_csv') return 'splid_csv';
	return 'ocr_text';
}

export function ImportWizard() {
	const { wg, members, identity } = useWg();
	const encodedCode = encodeURIComponent(wg.shareCode);
	const [step, setStep] = useState<Step>('source');
	const [source, setSource] = useState<ImportSourceKind | null>(null);
	const [rawPayload, setRawPayload] = useState('');
	const [ocrText, setOcrText] = useState('');
	const [ocrRunning, setOcrRunning] = useState(false);
	const [preview, setPreview] = useState<PreviewResponse | null>(null);
	const [mapping, setMapping] = useState<Record<string, string | null>>({});
	const [mappingValidated, setMappingValidated] = useState(false);
	const [skipIndexes, setSkipIndexes] = useState<Set<number>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [commitState, setCommitState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
	const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);
	const [skipDuplicates, setSkipDuplicates] = useState(true);
	const [inputStatus, setInputStatus] = useState<'empty' | 'reading' | 'ready' | 'error'>('empty');
	const [recoveryAction, setRecoveryAction] = useState<RecoveryAction | null>(null);
	const inputRunIdRef = useRef(0);
	const commitAttemptRef = useRef<{ signature: string; key: string | null } | null>(null);
	const stepHeadingRef = useRef<HTMLHeadingElement>(null);
	const previousStepRef = useRef<Step | null>(null);
	const router = useRouter();
	const [leaveOpen, setLeaveOpen] = useState(false);
	const [sourceToChange, setSourceToChange] = useState<ImportSourceKind | null>(null);

	useEffect(() => {
		const previousStep = previousStepRef.current;
		previousStepRef.current = step;
		if (previousStep === null || previousStep === step) return;
		const heading = stepHeadingRef.current;
		if (!heading) return;
		heading.focus({ preventScroll: true });
		heading.scrollIntoView({ block: 'start', behavior: 'auto' });
	}, [step]);

	const conflicts = useMemo(() => preview?.conflicts ?? [], [preview]);
	// Import assigns expenses to a member ("aus Listen raus": moved-out members are
	// not offered as targets). Historic names in the CSV still resolve by name.
	const memberOptions = useMemo(
		() => members.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name })),
		[members],
	);
	const namesNeedingMapping = useMemo(() => {
		if (!preview) return [];
		const names = new Set<string>();
		for (const expense of preview.parsed) {
			if (expense.paidByName) names.add(expense.paidByName);
			for (const s of expense.splits) {
				if (s.memberName) names.add(s.memberName);
			}
		}
		return Array.from(names);
	}, [preview]);
	const commitRecoveryAction = useMemo(() => {
		if (!commitResult) return null;
		for (const item of commitResult.errors) {
			const action = recoveryActionFor(item.reason, 'commit');
			if (action) return action;
		}
		return null;
	}, [commitResult]);

	function clearImportError(): void {
		setError(null);
		setRecoveryAction(null);
	}

	function beginInputReplacement(): number {
		const runId = inputRunIdRef.current + 1;
		inputRunIdRef.current = runId;
		setRawPayload('');
		setOcrText('');
		setOcrRunning(false);
		setPreview(null);
		setMapping({});
		setMappingValidated(false);
		setSkipIndexes(new Set());
		setCommitState('idle');
		setCommitResult(null);
		setSkipDuplicates(true);
		setInputStatus('reading');
		clearImportError();
		return runId;
	}

	function resetImportState(): void {
		inputRunIdRef.current += 1;
		setRawPayload('');
		setOcrText('');
		setOcrRunning(false);
		setPreview(null);
		setMapping({});
		setMappingValidated(false);
		setSkipIndexes(new Set());
		setBusy(false);
		setError(null);
		setRecoveryAction(null);
		setCommitState('idle');
		setCommitResult(null);
		setSkipDuplicates(true);
		setInputStatus('empty');
	}

	function setManualPayload(value: string): void {
		inputRunIdRef.current += 1;
		setRawPayload(value);
		setOcrText(value);
		setPreview(null);
		setMapping({});
		setMappingValidated(false);
		setSkipIndexes(new Set());
		setCommitState('idle');
		setCommitResult(null);
		setInputStatus(value.trim() ? 'ready' : 'empty');
		clearImportError();
	}

	function showImportError(operation: ImportOperation, reason: string, prefix?: string): void {
		setError(`${prefix ? `${prefix}: ` : ''}${importActionErrorMessage(reason)}`);
		setRecoveryAction(recoveryActionFor(reason, operation));
	}

	async function handleOcrFile(file: File): Promise<void> {
		const runId = beginInputReplacement();
		if (file.size > MAX_IMAGE_BYTES) {
			setInputStatus('error');
			setError('Das Bild ist zu groß (max. 10 MB).');
			setOcrRunning(false);
			return;
		}
		setOcrRunning(true);
		try {
			const text = await runOcrOnImage(file);
			if (inputRunIdRef.current !== runId) return;
			setOcrText(text);
			setRawPayload(text);
			setInputStatus(text.trim() ? 'ready' : 'empty');
		} catch (err) {
			if (inputRunIdRef.current !== runId) return;
			console.error('[ImportWizard] OCR failed', err);
			setInputStatus('error');
			setError(
				err instanceof OcrInitializationError
					? err.requiresReload
						? 'Texterkennung konnte nicht geladen werden. Prüfe die Internetverbindung und lade die Seite neu, bevor du es erneut versuchst.'
						: 'Texterkennung konnte nicht initialisiert werden. Prüfe die Internetverbindung und versuche es erneut.'
					: 'Texterkennung fehlgeschlagen. Versuche es mit einem klareren Bild.',
			);
		} finally {
			if (inputRunIdRef.current === runId) {
				setOcrRunning(false);
			}
		}
	}

	function handleCsvFile(file: File): void {
		const runId = beginInputReplacement();
		if (file.size > MAX_CSV_BYTES) {
			setInputStatus('error');
			setError('Die CSV-Datei ist zu groß (max. 5 MB).');
			return;
		}
		void file
			.text()
			.then((text) => {
				if (inputRunIdRef.current !== runId) return;
				setRawPayload(text);
				setInputStatus(text.trim() ? 'ready' : 'empty');
			})
			.catch(() => {
				if (inputRunIdRef.current !== runId) return;
				setInputStatus('error');
				setError('Die Datei konnte nicht gelesen werden. Wähle sie erneut aus.');
			});
	}

	async function submitPreview(): Promise<void> {
		if (!source) return;
		const payloadSize = new Blob([rawPayload]).size;
		const limit = source === 'ocr_screenshot' ? MAX_IMAGE_BYTES : MAX_CSV_BYTES;
		if (payloadSize > limit) {
			setInputStatus('error');
			showImportError('preview', 'payload_too_large');
			return;
		}
		setBusy(true);
		clearImportError();
		const res = await apiFetch<PreviewResponse>(`/api/wg/${encodedCode}/imports/preview`, {
			method: 'POST',
			memberId: identity.memberId,
			memberToken: identity.memberToken,
			body: JSON.stringify({
				source: payloadKey(source),
				payload: rawPayload,
			}),
		});
		setBusy(false);
		if (!res.ok) {
			if (res.error === 'payload_too_large') setInputStatus('error');
			showImportError('preview', res.error, 'Vorschau fehlgeschlagen');
			return;
		}
		setPreview(res.data);
		setMapping(res.data.memberMapping);
		setMappingValidated(false);
		setSkipIndexes(new Set());
		setInputStatus('ready');
		clearImportError();
		setStep('mapping');
	}

	async function submitCommit(): Promise<void> {
		if (!source || !preview) return;
		const commitBody = {
			source: payloadKey(source),
			payload: rawPayload,
			previewPayloadHash: preview.payloadHash,
			memberMapping: mapping,
			skipDuplicates,
			skipIndexes: Array.from(skipIndexes),
		};
		const signature = JSON.stringify(commitBody);
		if (commitAttemptRef.current?.signature !== signature) {
			commitAttemptRef.current = { signature, key: createOfflineIdempotencyKey() };
		}
		const idempotencyKey = commitAttemptRef.current.key;
		setBusy(true);
		setCommitState('pending');
		clearImportError();
		const res = await apiFetch<CommitResponse>(`/api/wg/${encodedCode}/imports/commit`, {
			method: 'POST',
			memberId: identity.memberId,
			memberToken: identity.memberToken,
			...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
			body: signature,
		});
		setBusy(false);
		if (!res.ok) {
			if (res.error === 'payload_too_large') setInputStatus('error');
			setCommitState('error');
			showImportError('commit', res.error, 'Import fehlgeschlagen');
			return;
		}
		commitAttemptRef.current = null;
		setCommitResult(res.data);
		setCommitState('done');
		setStep('commit');
	}

	function applyRecoveryAction(action: RecoveryAction): void {
		setError(null);
		setRecoveryAction(null);
		switch (action.kind) {
			case 'retry_preview':
				void submitPreview();
				return;
			case 'retry_commit':
				void submitCommit();
				return;
			case 'mapping':
				setStep('mapping');
				return;
			case 'preview':
				setStep('preview');
				return;
			case 'input':
				setPreview(null);
				setMapping({});
				setMappingValidated(false);
				setSkipIndexes(new Set());
				setCommitState('idle');
				setCommitResult(null);
				setStep('input');
				return;
		}
	}

	function toggleSkip(index: number): void {
		const next = new Set(skipIndexes);
		if (next.has(index)) next.delete(index);
		else next.add(index);
		setSkipIndexes(next);
	}

	function updateMapping(name: string, memberId: string | null): void {
		setMapping((prev) => ({ ...prev, [name]: memberId }));
	}

	function continueFromMapping(): void {
		if (!allMapped) {
			setMappingValidated(true);
			return;
		}
		setMappingValidated(false);
		setStep('preview');
	}

	// A mapping only counts when it points at an active member (the commit rejects others).
	const allMapped = namesNeedingMapping.every((name) =>
		memberOptions.some((member) => member.id === mapping[name]),
	);

	const stepNumber = ['source', 'input', 'mapping', 'preview', 'commit'].indexOf(step) + 1;
	const selectedCount = (preview?.parsed.length ?? 0) - skipIndexes.size;
	const returnHref = `/wg/${encodedCode}/ausgaben`;
	function chooseSource(value: ImportSourceKind) {
		if (value !== source) resetImportState();
		setSource(value);
		setStep('input');
		clearImportError();
	}

	return (
		<div className="flex flex-col gap-5">
			{/* Kopf wie auf den anderen Unterseiten: Zurück-Pfeil links neben dem Titel. */}
			<header className="flex min-w-0 items-center gap-3">
				<Link
					href={returnHref}
					aria-label="Zurück zu Ausgaben"
					className={buttonVariants({ variant: 'ghost', size: 'icon' })}
					aria-disabled={busy || ocrRunning || undefined}
					tabIndex={busy || ocrRunning ? -1 : undefined}
					onClick={(event) => {
						if (busy || ocrRunning) {
							event.preventDefault();
							return;
						}
						if (rawPayload && commitState !== 'done') {
							event.preventDefault();
							setLeaveOpen(true);
						}
					}}
				>
					<ArrowLeft aria-hidden />
				</Link>
				<div className="min-w-0 flex-1">
					<h1 className="font-heading text-lg font-semibold tracking-tight">
						Ausgaben importieren
					</h1>
					<p className="mt-0.5 text-[12px] text-muted-foreground tabular-nums">
						Aus Splitwise oder Splid · Schritt {stepNumber} von 5
					</p>
				</div>
			</header>
			<Progress value={stepNumber} max={5} aria-label={`Import: Schritt ${stepNumber} von 5`} />
			{step === 'source' && (
				<section className="flex flex-col gap-3">
					<h2
						ref={stepHeadingRef}
						tabIndex={-1}
						className="text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						Importquelle wählen
					</h2>
					<ImportSourcePicker
						value={source}
						onChange={(value) => {
							if (value !== source && rawPayload) setSourceToChange(value);
							else chooseSource(value);
						}}
					/>
				</section>
			)}
			{step === 'input' && source && (
				<section className="flex flex-col gap-4">
					<h2
						ref={stepHeadingRef}
						tabIndex={-1}
						className="text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						{source === 'ocr_screenshot' ? 'Bild hinzufügen' : 'Export-Datei auswählen'}
					</h2>
					<FieldGroup>
						{source === 'ocr_screenshot' ? (
							<>
								<Field data-disabled={busy || ocrRunning}>
									<FieldLabel htmlFor="import-screenshot">Bild auswählen</FieldLabel>
									<Input
										id="import-screenshot"
										type="file"
										accept="image/*"
										aria-label="Screenshot auswählen"
										disabled={busy || ocrRunning}
										onChange={(event) => {
											const file = event.target.files?.[0];
											if (file) void handleOcrFile(file);
										}}
										className="text-base"
									/>
									<FieldDescription>
										Foto oder Bildschirmfoto bis 10 MB. Nur Eurobeträge (EUR) werden erkannt.
									</FieldDescription>
								</Field>
								{ocrRunning && (
									<Alert>
										<Spinner />
										<AlertDescription>
											Bild wird ausgewertet. Das kann 30 Sekunden dauern.
										</AlertDescription>
									</Alert>
								)}
								<details>
									<summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
										Ergebnis prüfen oder korrigieren
									</summary>
									<div className="pt-2">
										<Field
											data-invalid={inputStatus === 'error'}
											data-disabled={busy || ocrRunning}
										>
											<FieldLabel htmlFor="import-ocr">Erkannte Daten</FieldLabel>
											<Textarea
												id="import-ocr"
												value={ocrText}
												onChange={(event) => setManualPayload(event.target.value)}
												disabled={busy || ocrRunning}
												aria-label="Erkannte Daten"
												aria-invalid={inputStatus === 'error' || undefined}
												aria-describedby={inputStatus === 'error' ? 'import-error' : undefined}
												placeholder="Ergebnis hier prüfen und korrigieren"
												className="min-h-32 text-base"
											/>
										</Field>
									</div>
								</details>
							</>
						) : (
							<>
								<Field data-disabled={busy || inputStatus === 'reading'}>
									<FieldLabel htmlFor="import-csv-file">Datei auswählen</FieldLabel>
									<Input
										id="import-csv-file"
										type="file"
										accept=".csv,text/csv"
										aria-label="CSV-Datei auswählen"
										disabled={busy || inputStatus === 'reading'}
										className="text-base"
										onChange={(event) => {
											const file = event.target.files?.[0];
											if (!file) return;
											handleCsvFile(file);
										}}
									/>
									<FieldDescription>Export-Datei bis 5 MB.</FieldDescription>
								</Field>
								<details>
									<summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
										Oder Inhalt einfügen
									</summary>
									<div className="pt-2">
										<Field
											data-invalid={inputStatus === 'error'}
											data-disabled={busy || inputStatus === 'reading'}
										>
											<FieldLabel htmlFor="import-csv-textarea">Inhalt des Exports</FieldLabel>
											<Textarea
												id="import-csv-textarea"
												value={rawPayload}
												onChange={(event) => setManualPayload(event.target.value)}
												placeholder="Füge den Inhalt deines Exports hier ein"
												aria-label="Inhalt des Exports"
												aria-invalid={inputStatus === 'error' || undefined}
												aria-describedby={inputStatus === 'error' ? 'import-error' : undefined}
												disabled={busy || inputStatus === 'reading'}
												className="min-h-32 text-base"
											/>
										</Field>
									</div>
								</details>
							</>
						)}
					</FieldGroup>
					<div className="flex min-w-0 flex-wrap gap-2">
						<Button
							className="flex-1"
							disabled={
								busy || ocrRunning || inputStatus !== 'ready' || rawPayload.trim().length === 0
							}
							onClick={() => void submitPreview()}
						>
							{busy && <Spinner data-icon="inline-start" />}Vorschau erstellen
						</Button>
						<Button
							variant="outline"
							disabled={busy || ocrRunning}
							onClick={() => {
								clearImportError();
								setStep('source');
							}}
						>
							Zurück
						</Button>
					</div>
				</section>
			)}
			{step === 'mapping' && preview && (
				<section className="flex flex-col gap-4">
					<h2
						ref={stepHeadingRef}
						tabIndex={-1}
						className="text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						Namen WG-Mitgliedern zuordnen
					</h2>
					<p className="text-sm text-muted-foreground">
						{conflicts.length > 0
							? 'Ordne die markierten Namen zu.'
							: 'Alle Namen automatisch erkannt. Bitte prüfen.'}
					</p>
					<ImportMemberMapping
						names={namesNeedingMapping}
						mapping={mapping}
						members={memberOptions}
						onChange={updateMapping}
						showErrors={mappingValidated}
					/>
					<div className="flex min-w-0 flex-wrap gap-2">
						<Button className="flex-1" onClick={continueFromMapping}>
							Weiter zur Vorschau
						</Button>
						<Button
							variant="outline"
							onClick={() => {
								clearImportError();
								setStep('input');
							}}
						>
							Zurück
						</Button>
					</div>
				</section>
			)}
			{step === 'preview' && preview && (
				<section className="flex flex-col gap-4">
					<div className="flex items-center justify-between gap-2">
						<h2
							ref={stepHeadingRef}
							tabIndex={-1}
							className="text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						>
							Vorschau
						</h2>
						<Badge variant="secondary">{selectedCount} ausgewählt</Badge>
					</div>
					<p className="text-sm text-muted-foreground">
						Prüfe Betrag, Zahler:in und alle Anteile. Wähle Einträge ab, die du nicht übernehmen
						möchtest.
					</p>
					<ImportPreviewTable
						expenses={preview.parsed}
						mapping={mapping}
						members={memberOptions}
						skipIndexes={skipIndexes}
						onToggleSkip={toggleSkip}
						disabled={busy}
					/>
					<FieldGroup>
						<Field orientation="horizontal" className="min-h-11" data-disabled={busy}>
							<Checkbox
								id="import-duplicates"
								checked={skipDuplicates}
								onCheckedChange={(checked) => setSkipDuplicates(checked === true)}
								disabled={busy}
							/>
							<div className="flex flex-col gap-1">
								<FieldLabel htmlFor="import-duplicates">Duplikate überspringen</FieldLabel>
								<FieldDescription>
									Gleiches Datum, Beschreibung, Betrag und Zahler:in.
								</FieldDescription>
							</div>
						</Field>
					</FieldGroup>
					<div className="sticky bottom-[calc(var(--app-nav-height,5rem)+env(safe-area-inset-bottom))] flex min-w-0 flex-wrap gap-2 bg-background py-3">
						<Button
							className="flex-1"
							disabled={busy || selectedCount === 0}
							onClick={() => void submitCommit()}
						>
							{busy && <Spinner data-icon="inline-start" />}Importieren ({selectedCount})
						</Button>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => {
								clearImportError();
								setStep('mapping');
							}}
						>
							Zurück
						</Button>
					</div>
				</section>
			)}
			{step === 'commit' && commitResult && (
				<section className="flex flex-col gap-4">
					<h2
						ref={stepHeadingRef}
						tabIndex={-1}
						className="text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						Import abgeschlossen
					</h2>
					<ImportProgress
						state="done"
						inserted={commitResult.inserted}
						skipped={commitResult.skipped}
						errors={commitResult.errors.length}
					/>
					{commitResult.warning && (
						<Alert>
							<AlertTitle>Hinweis zur Benachrichtigung</AlertTitle>
							<AlertDescription>
								{commitResult.warning === 'notification_delivery_failed'
									? 'Der Import wurde gespeichert, aber die WG-Benachrichtigung konnte nicht an alle zugestellt werden.'
									: 'Der Import wurde gespeichert, aber die Zustellung der WG-Benachrichtigung konnte nicht bestätigt werden.'}
							</AlertDescription>
						</Alert>
					)}
					{commitResult.errors.length > 0 && (
						<Alert variant="destructive">
							<AlertTitle>Nicht übernommene Einträge</AlertTitle>
							<AlertDescription className="flex flex-col items-start gap-3">
								<ul className="flex flex-col gap-2">
									{commitResult.errors.map((item) => (
										<li key={item.index}>
											Eintrag {item.index + 1}: {importActionErrorMessage(item.reason)}
										</li>
									))}
								</ul>
								{commitRecoveryAction && (
									<Button
										variant="outline"
										onClick={() => applyRecoveryAction(commitRecoveryAction)}
									>
										{commitRecoveryAction.label}
									</Button>
								)}
							</AlertDescription>
						</Alert>
					)}
					<Link
						href={`/wg/${encodedCode}/ausgaben`}
						className={buttonVariants({ className: 'min-h-11' })}
					>
						Zu den Ausgaben
					</Link>
				</section>
			)}
			{commitState === 'pending' && <ImportProgress state="pending" />}
			{error && (
				<Alert id="import-error" variant="destructive">
					<AlertDescription className="flex flex-col items-start gap-2">
						<span>{error}</span>
						{recoveryAction && (
							<Button
								variant="outline"
								disabled={busy || ocrRunning}
								onClick={() => applyRecoveryAction(recoveryAction)}
							>
								{recoveryAction.label}
							</Button>
						)}
					</AlertDescription>
				</Alert>
			)}
			<AlertDialog
				open={leaveOpen || sourceToChange !== null}
				onOpenChange={(open) => {
					if (!open) {
						setLeaveOpen(false);
						setSourceToChange(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Import-Eingaben verwerfen?</AlertDialogTitle>
						<AlertDialogDescription>
							Die bisher eingegebenen Daten und Zuordnungen gehen verloren. Es werden keine neuen
							Ausgaben importiert.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel className="min-h-11">Weiterbearbeiten</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							className="min-h-11"
							onClick={() => {
								if (sourceToChange) {
									chooseSource(sourceToChange);
									setSourceToChange(null);
								} else router.push(returnHref);
							}}
						>
							Verwerfen
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
