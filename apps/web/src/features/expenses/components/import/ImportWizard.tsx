'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
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
import { useMessage } from '@/shared/i18n/message';
import { cn } from '@/shared/lib/cn';
import { markOverlayNavigation, overlayNavigationPending } from '@/shared/lib/use-dismiss-on-back';
import { ImportHistory } from './ImportHistory';
import { ImportInputStep } from './ImportInputStep';
import { ImportProgress } from './ImportProgress';
import { ImportResultStep } from './ImportResultStep';
import { ImportMappingStep, ImportPreviewStep, RejectedRowsDetails } from './ImportReviewSteps';
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
	const leavingRef = useRef(false);
	useEffect(() => {
		onBackRef.current = onBack;
	});
	useEffect(() => {
		if (!active) return;
		const pushGuard = () =>
			window.history.pushState({ ...window.history.state, importGuard: true }, '');
		pushGuard();
		function onPopState() {
			if (leavingRef.current) return;
			if (window.history.state?.importGuard) return;
			pushGuard();
			onBackRef.current();
		}
		window.addEventListener('popstate', onPopState);
		return () => {
			window.removeEventListener('popstate', onPopState);
			// Deferred so a concurrently started navigation can replace the state first.
			setTimeout(() => {
				if (leavingRef.current || overlayNavigationPending()) return;
				if (window.history.state?.importGuard) window.history.back();
			}, 50);
		};
	}, [active]);
	/**
	 * Leaves the wizard without leaving marker entries behind: pops the guard entry
	 * (and the dialog's, when open) back to the wizard's own entry, then replaces
	 * that one. Back from the target page skips the wizard.
	 */
	return (markerEntries: number, navigate: () => void) => {
		leavingRef.current = true;
		const onPop = () => {
			window.removeEventListener('popstate', onPop);
			navigate();
		};
		window.addEventListener('popstate', onPop);
		window.history.go(-markerEntries);
	};
}

export function ImportWizard() {
	const t = useTranslations('expenses-import');
	const renderMessage = useMessage();
	const wizard = useImportWizard();
	const { step, source, input, busy, error, recoveryAction, stepNumber } = wizard;
	const { rawPayload, ocrRunning } = input;
	const stepHeadingRef = useStepHeadingFocus(step);
	const router = useRouter();
	const [leaveOpen, setLeaveOpen] = useState(false);
	const [sourceToChange, setSourceToChange] = useState<ImportSourceKind | null>(null);
	const returnHref = `/wg/${wizard.encodedCode}/expenses`;
	const backGuardActive =
		step !== 'commit' &&
		wizard.commitState !== 'done' &&
		(step !== 'source' || Boolean(rawPayload));
	const leaveThroughGuard = useImportBackGuard(backGuardActive, () => {
		if (busy || ocrRunning) return;
		const previous = PREVIOUS_STEP[step];
		if (previous) wizard.goTo(previous);
		else if (rawPayload) setLeaveOpen(true);
	});
	const leave = () => {
		markOverlayNavigation();
		if (!backGuardActive) {
			router.push(returnHref);
			return;
		}
		leaveThroughGuard(leaveOpen ? 2 : 1, () => router.replace(returnHref));
	};

	return (
		<div className="flex flex-col gap-5">
			{/* Header like the other subpages: back arrow left of the title. */}
			<header className="flex min-w-0 items-start gap-2">
				<Link
					href={returnHref}
					aria-label={t('back')}
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
						{t('title')}
					</h1>
					<p className="text-meta text-muted-foreground tabular-nums">
						{t('stepOf', { step: String(stepNumber) })}
					</p>
				</div>
			</header>
			<Progress
				value={stepNumber}
				max={5}
				aria-label={t('progressAria', { step: String(stepNumber) })}
			/>
			{step === 'source' && (
				<section className="flex flex-col gap-3">
					<ImportStepHeading headingRef={stepHeadingRef}>{t('source.heading')}</ImportStepHeading>
					<ImportSourcePicker
						value={source}
						onChange={(value) => {
							if (value !== source && rawPayload) setSourceToChange(value);
							else wizard.chooseSource(value);
						}}
					/>
					<ImportHistory />
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
						<span>{renderMessage(error)}</span>
						{wizard.unreadableRows.length > 0 && (
							<RejectedRowsDetails rejected={wizard.unreadableRows} />
						)}
						{recoveryAction && (
							<Button
								variant="outline"
								disabled={busy || ocrRunning}
								onClick={() => wizard.applyRecoveryAction(recoveryAction)}
							>
								{renderMessage(recoveryAction.label)}
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
						<AlertDialogTitle>{t('leave.title')}</AlertDialogTitle>
						<AlertDialogDescription>{t('leave.description')}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel className="min-h-11">{t('leave.keep')}</AlertDialogCancel>
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
							{t('leave.discard')}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
