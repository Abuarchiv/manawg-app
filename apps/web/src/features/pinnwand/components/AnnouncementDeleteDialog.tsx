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
import { Spinner } from '@/components/ui/spinner';
import { useEffect, useRef, useState } from 'react';

interface AnnouncementDeleteDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	actionSubject: string;
	deletePending: boolean;
	/** null = removed, otherwise the error message for the dialog. */
	onDelete: () => Promise<string | null>;
}

/** Confirmation before a post and its replies are removed; stays open with an error on failure. */
export function AnnouncementDeleteDialog({
	open,
	onOpenChange,
	actionSubject,
	deletePending,
	onDelete,
}: AnnouncementDeleteDialogProps) {
	const deletingRef = useRef(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	// Every opening starts without the previous attempt's error.
	useEffect(() => {
		if (open) setDeleteError(null);
	}, [open]);
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!deletePending && !deletingRef.current) onOpenChange(next);
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Beitrag entfernen?</AlertDialogTitle>
					<AlertDialogDescription>
						„{actionSubject}“ und die zugehörigen Antworten werden entfernt.
					</AlertDialogDescription>
				</AlertDialogHeader>
				{deleteError && (
					<Alert variant="destructive">
						<AlertDescription>{deleteError}</AlertDescription>
					</Alert>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={deletePending} className="min-h-11">
						Abbrechen
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={deletePending}
						className="min-h-11"
						aria-label={`Beitrag entfernen bestätigen: ${actionSubject}`}
						onClick={async () => {
							// Lock synchronously: the built-in close runs before the next render.
							deletingRef.current = true;
							setDeleteError(null);
							try {
								const message = await onDelete();
								if (message === null) onOpenChange(false);
								else setDeleteError(message);
							} finally {
								deletingRef.current = false;
							}
						}}
					>
						{deletePending && <Spinner data-icon="inline-start" />}
						{deletePending ? 'Wird entfernt…' : 'Entfernen'}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
