'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Button, buttonVariants } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/shared/lib/cn';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ImportInputStep } from './ImportInputStep';
import { ImportProgress } from './ImportProgress';
import { ImportResultStep } from './ImportResultStep';
import { ImportMappingStep, ImportPreviewStep } from './ImportReviewSteps';
import { type ImportSourceKind, ImportSourcePicker } from './ImportSourcePicker';
import { ImportStepHeading } from './ImportStepHeading';
import type { ImportStep } from './import-wizard-types';
import { useImportWizard } from './use-import-wizard';

/** Moves focus to the new step's heading whenever the step changes (not on first render). */
function useStepHeadingFocus(step: ImportStep) {
	const stepHeadingRef = useRef<HTMLHeadingElement>(null);
	const previousStepRef = useRef<ImportStep | null>(null);
	useEffect(() => {
		const previousStep = previousStepRef.current;
		previousStepRef.current = step;
		if (previousStep === null || previousStep === step) return;
		const heading = stepHeadingRef.current;
		if (!heading) return;
		heading.focus({ preventScroll: true });
		heading.scrollIntoView({ block: 'nearest', behavior: 'auto' });
	}, [step]);
	return stepHeadingRef;
}

const PREVIOUS_STEP: Partial<Record<ImportStep, ImportStep>> = {
	input: 'source',
	mapping: 'input',
	preview: 'mapping',
};

/**
 * Browser back / iOS edge swipe steps back within the wizard instead of leaving the page with its
 * input. While `active`, a marker entry sits in history (state copied so the Next router recognizes
 * it); a back navigation pops it, the hook pushes it again and calls `onBack`. If a pop lands on
 * another marked entry (the dialog's overlay marker), it is ignored.
 */
function useImportBackGuard(active: boolean, onBack: () => void) {
	const onBackRef = useRef(onBack);
	useEffect(() => {
		onBackRef.current = onBack;
	});
	useEffect(() => {
		if (!active) return;
		const pushGuard = () =>
			window.history.pushState({ ...window.history.state, importGuard: true }, '');
		pushGuard();
		function onPopState() {
			if (window.history.state?.importGuard) return;
			pushGuard();
			onBackRef.current();
		}
		window.addEventListener('popstate', onPopState);
		return () => {
			window.removeEventListener('popstate', onPopState);
			// Deferred so a concurrently started navigation can replace the state first.
			setTimeout(() => {
				if (window.history.state?.importGuard) window.history.back();
			}, 50);
		};
	}, [active]);
}

export function ImportWizard() {
	const wizard = useImportWizard();
	const { step, source, input, busy, error, recoveryAction, stepNumber } = wizard;
	const { rawPayload, ocrRunning } = input;
	const stepHeadingRef = useStepHeadingFocus(step);
	const router = useRouter();
	const [leaveOpen, setLeaveOpen] = useState(false);
	const [sourceToChange, setSourceToChange] = useState<ImportSourceKind | null>(null);
	const returnHref = `/wg/${wizard.encodedCode}/ausgaben`;
	const backGuardActive =
		step !== 'commit' &&
		wizard.commitState !== 'done' &&
		(step !== 'source' || Boolean(rawPayload));
	useImportBackGuard(backGuardActive, () => {
		if (busy || ocrRunning) return;
		const previous = PREVIOUS_STEP[step];
		if (previous) wizard.goTo(previous);
		else if (rawPayload) setLeaveOpen(true);
	});
	// With a marker in history, leaving replaces it instead of stacking another entry.
	const leave = () => (backGuardActive ? router.replace(returnHref) : router.push(returnHref));

	return (
		<div className="flex flex-col gap-5">
			{/* Header like the other subpages: back arrow left of the title. */}
			<header className="flex min-w-0 items-start gap-2">
				<Link
					href={returnHref}
					aria-label="Zurück zu Ausgaben"
					className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), '-ml-2')}
					aria-disabled={busy || ocrRunning || undefined}
					tabIndex={busy || ocrRunning ? -1 : undefined}
					onClick={(event) => {
						if (busy || ocrRunning) {
							event.preventDefault();
							return;
						}
						if (rawPayload && wizard.commitState !== 'done') {
							event.preventDefault();
							setLeaveOpen(true);
						} else if (backGuardActive) {
							event.preventDefault();
							leave();
						}
					}}
				>
					<ArrowLeft aria-hidden />
				</Link>
				<div className="min-w-0 flex-1">
					<h1 className="font-heading text-base leading-8 font-semibold [overflow-wrap:normal] hyphens-auto">
						Ausgaben importieren
					</h1>
					<p className="text-[12px] text-muted-foreground tabular-nums">
						Schritt {stepNumber} von 5
					</p>
				</div>
			</header>
			<Progress value={stepNumber} max={5} aria-label={`Import: Schritt ${stepNumber} von 5`} />
			{step === 'source' && (
				<section className="flex flex-col gap-3">
					<ImportStepHeading headingRef={stepHeadingRef}>Importquelle wählen</ImportStepHeading>
					<ImportSourcePicker
						value={source}
						onChange={(value) => {
							if (value !== source && rawPayload) setSourceToChange(value);
							else wizard.chooseSource(value);
						}}
					/>
				</section>
			)}
			{step === 'input' && source && (
				<ImportInputStep
					headingRef={stepHeadingRef}
					source={source}
					input={input}
					busy={busy}
					onPreview={() => void wizard.submitPreview()}
					onBack={() => wizard.goTo('source')}
				/>
			)}
			{step === 'mapping' && wizard.preview && (
				<ImportMappingStep headingRef={stepHeadingRef} wizard={wizard} />
			)}
			{step === 'preview' && wizard.preview && (
				<ImportPreviewStep headingRef={stepHeadingRef} wizard={wizard} />
			)}
			{step === 'commit' && wizard.commitResult && (
				<ImportResultStep
					headingRef={stepHeadingRef}
					result={wizard.commitResult}
					recoveryAction={wizard.commitRecoveryAction}
					onRecover={wizard.applyRecoveryAction}
					expensesHref={returnHref}
					parsed={wizard.preview?.parsed}
				/>
			)}
			{wizard.commitState === 'pending' && <ImportProgress state="pending" />}
			{error && (
				<Alert id="import-error" variant="destructive">
					<AlertDescription className="flex flex-col items-start gap-2">
						<span>{error}</span>
						{recoveryAction && (
							<Button
								variant="outline"
								disabled={busy || ocrRunning}
								onClick={() => wizard.applyRecoveryAction(recoveryAction)}
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
									wizard.chooseSource(sourceToChange);
									setSourceToChange(null);
								} else leave();
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
