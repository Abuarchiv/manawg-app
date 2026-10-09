'use client';

import { useWg } from '@/components/wg/WgContextProvider';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { MAX_CSV_BYTES } from '@/features/expenses/import-body';
import {
	type ImportOperation,
	type RecoveryAction,
	importActionErrorMessage,
	recoveryActionFor,
} from '@/features/expenses/import-errors';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImportSourceKind } from './ImportSourcePicker';
import {
	type CommitResponse,
	IMPORT_STEPS,
	type ImportStep,
	MAX_IMAGE_BYTES,
	type PreviewResponse,
	mergeMemberMapping,
	namesInPreview,
	payloadKey,
} from './import-wizard-types';
import { useImportInput } from './use-import-input';

/** State and actions of the five-step expense import: source, input, mapping, preview, result. */
export function useImportWizard() {
	const { wg, members, identity } = useWg();
	const encodedCode = encodeURIComponent(wg.shareCode);
	const [step, setStep] = useState<ImportStep>('source');
	const [source, setSource] = useState<ImportSourceKind | null>(null);
	const [preview, setPreview] = useState<PreviewResponse | null>(null);
	const [mapping, setMapping] = useState<Record<string, string | null>>({});
	const previewPayloadRef = useRef<string | null>(null);
	const [mappingValidated, setMappingValidated] = useState(false);
	const [skipIndexes, setSkipIndexes] = useState<Set<number>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [commitState, setCommitState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
	const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);
	const [skipDuplicates, setSkipDuplicates] = useState(true);
	const [recoveryAction, setRecoveryAction] = useState<RecoveryAction | null>(null);
	const commitAttemptRef = useRef<{ signature: string; key: string | null } | null>(null);

	function clearImportError(): void {
		setError(null);
		setRecoveryAction(null);
	}

	/** Everything derived from the current input: preview, mapping, selection, result. */
	function discardDerivedState(): void {
		setPreview(null);
		setMapping({});
		setMappingValidated(false);
		setSkipIndexes(new Set());
		setCommitState('idle');
		setCommitResult(null);
	}

	const input = useImportInput({
		onInputDiscarded: () => {
			discardDerivedState();
			setSkipDuplicates(true);
		},
		onInputEdited: discardDerivedState,
		setError,
		clearError: clearImportError,
	});
	const { rawPayload } = input;

	useEffect(() => {
		if (error) document.getElementById('import-error')?.scrollIntoView({ block: 'center' });
	}, [error]);

	// Import assigns expenses to a member ("aus Listen raus": moved-out members are
	// not offered as targets). Historic names in the CSV still resolve by name.
	const memberOptions = useMemo(
		() => members.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name })),
		[members],
	);
	const namesNeedingMapping = useMemo(() => namesInPreview(preview), [preview]);
	const commitRecoveryAction = useMemo(() => {
		if (!commitResult) return null;
		for (const item of commitResult.errors) {
			const action = recoveryActionFor(item.reason, 'commit');
			if (action) return action;
		}
		return null;
	}, [commitResult]);

	function showImportError(operation: ImportOperation, reason: string, prefix?: string): void {
		setError(`${prefix ? `${prefix}: ` : ''}${importActionErrorMessage(reason)}`);
		setRecoveryAction(recoveryActionFor(reason, operation));
	}

	async function submitPreview(): Promise<void> {
		if (!source) return;
		const payloadSize = new Blob([rawPayload]).size;
		const limit = source === 'ocr_screenshot' ? MAX_IMAGE_BYTES : MAX_CSV_BYTES;
		if (payloadSize > limit) {
			input.setInputStatus('error');
			showImportError('preview', 'payload_too_large');
			return;
		}
		setBusy(true);
		clearImportError();
		const res = await apiFetch<PreviewResponse>(`/api/wg/${encodedCode}/imports/preview`, {
			method: 'POST',
			memberId: identity.memberId,
			body: JSON.stringify({
				source: payloadKey(source),
				payload: rawPayload,
			}),
		});
		setBusy(false);
		if (!res.ok) {
			if (res.error === 'payload_too_large') input.setInputStatus('error');
			showImportError('preview', res.error, 'Vorschau fehlgeschlagen');
			return;
		}
		// Without a recognised expense the mapping step would be empty and claim both
		// "all names recognised" and "no names recognised".
		if (res.data.parsed.length === 0) {
			const unreadable = (res.data.rejected?.length ?? 0) > 0;
			showImportError(
				'preview',
				unreadable ? 'rows_unreadable' : 'empty_payload',
				'Vorschau fehlgeschlagen',
			);
			return;
		}
		setPreview(res.data);
		setMapping((previous) => mergeMemberMapping(res.data.memberMapping, previous));
		setMappingValidated(false);
		if (previewPayloadRef.current !== rawPayload) setSkipIndexes(new Set());
		previewPayloadRef.current = rawPayload;
		input.setInputStatus('ready');
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
			...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
			body: signature,
		});
		setBusy(false);
		if (!res.ok) {
			if (res.error === 'payload_too_large') input.setInputStatus('error');
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
		clearImportError();
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
				discardDerivedState();
				setStep('input');
				// After rendering (and focusing the step heading), jump to the input field.
				requestAnimationFrame(() => {
					const field = document.getElementById(
						source === 'ocr_screenshot' ? 'import-ocr' : 'import-csv-textarea',
					);
					const details = field?.closest('details');
					if (details) details.open = true;
					field?.focus();
				});
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

	// A mapping only counts when it points at an active member (the commit rejects others).
	const allMapped = namesNeedingMapping.every((name) =>
		memberOptions.some((member) => member.id === mapping[name]),
	);

	function continueFromMapping(): void {
		if (!allMapped) {
			setMappingValidated(true);
			// After rendering, jump to the first open name (focus scrolls it into view).
			const firstOpen = namesNeedingMapping.findIndex(
				(name) => !memberOptions.some((member) => member.id === mapping[name]),
			);
			requestAnimationFrame(() => document.getElementById(`import-map-${firstOpen}`)?.focus());
			return;
		}
		setMappingValidated(false);
		setStep('preview');
	}

	function chooseSource(value: ImportSourceKind): void {
		if (value !== source) {
			input.resetInput();
			setBusy(false);
		}
		setSource(value);
		setStep('input');
		clearImportError();
	}

	/** Step navigation by the "Zurück" buttons. */
	function goTo(next: ImportStep): void {
		clearImportError();
		setStep(next);
	}

	return {
		encodedCode,
		step,
		stepNumber: IMPORT_STEPS.indexOf(step) + 1,
		source,
		input,
		preview,
		conflicts: preview?.conflicts ?? [],
		mapping,
		mappingValidated,
		memberOptions,
		namesNeedingMapping,
		skipIndexes,
		selectedCount: (preview?.parsed.length ?? 0) - skipIndexes.size,
		skipDuplicates,
		setSkipDuplicates,
		busy,
		error,
		recoveryAction,
		commitState,
		commitResult,
		commitRecoveryAction,
		submitPreview,
		submitCommit,
		applyRecoveryAction,
		toggleSkip,
		updateMapping,
		continueFromMapping,
		chooseSource,
		goTo,
	};
}

export type ImportWizardState = ReturnType<typeof useImportWizard>;
