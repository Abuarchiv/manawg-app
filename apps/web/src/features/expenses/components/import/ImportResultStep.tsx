'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { formatEuroCents } from '@/core/utils/money';
import { importActionErrorMessage } from '@/features/expenses/import-errors';
import type { RecoveryAction } from '@/features/expenses/import-errors';
import type { ParsedExpense } from '@/features/expenses/import-parsers';
import Link from 'next/link';
import type { Ref } from 'react';
import { formatDate } from './ImportPreviewTable';
import { ImportProgress } from './ImportProgress';
import { ImportStepHeading } from './ImportStepHeading';
import type { CommitResponse } from './import-wizard-types';

interface ImportResultStepProps {
	headingRef: Ref<HTMLHeadingElement>;
	result: CommitResponse;
	recoveryAction: RecoveryAction | null;
	onRecover: (action: RecoveryAction) => void;
	expensesHref: string;
	/** Rows of the preview, so an error can name the expense behind its index. */
	parsed?: readonly ParsedExpense[] | undefined;
}

export function ImportResultStep({
	headingRef,
	result,
	recoveryAction,
	onRecover,
	expensesHref,
	parsed = [],
}: ImportResultStepProps) {
	return (
		<section className="flex flex-col gap-4">
			<ImportStepHeading headingRef={headingRef}>Import abgeschlossen</ImportStepHeading>
			<ImportProgress
				state="done"
				inserted={result.inserted}
				skipped={result.skipped}
				errors={result.errors.length}
			/>
			{result.warning && (
				<Alert>
					<AlertTitle>Hinweis zur Benachrichtigung</AlertTitle>
					<AlertDescription>
						{result.warning === 'notification_delivery_failed'
							? 'Der Import wurde gespeichert, aber die WG-Benachrichtigung konnte nicht an alle zugestellt werden.'
							: 'Der Import wurde gespeichert, aber die Zustellung der WG-Benachrichtigung konnte nicht bestätigt werden.'}
					</AlertDescription>
				</Alert>
			)}
			{result.errors.length > 0 && (
				<Alert variant="destructive">
					<AlertTitle>Nicht übernommene Einträge</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3">
						<ul className="flex flex-col gap-2">
							{result.errors.map((item) => {
								const row = parsed[item.index];
								return (
									<li key={item.index}>
										Eintrag {item.index + 1}
										{row &&
											` (${row.description}, ${formatDate(row.date)}, ${formatEuroCents(row.amountCents, row.currency)})`}
										: {importActionErrorMessage(item.reason)}
									</li>
								);
							})}
						</ul>
						{recoveryAction && (
							<Button variant="outline" onClick={() => onRecover(recoveryAction)}>
								{recoveryAction.label}
							</Button>
						)}
					</AlertDescription>
				</Alert>
			)}
			<Link href={expensesHref} className={buttonVariants({ className: 'min-h-11' })}>
				Zu den Ausgaben
			</Link>
		</section>
	);
}
