'use client';

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

export function PayPalDisconnectDialog({
	open,
	onOpenChange,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent className="max-w-[calc(100%-2rem)]">
				<AlertDialogHeader>
					<AlertDialogTitle>PayPal trennen?</AlertDialogTitle>
					<AlertDialogDescription>
						Andere Mitglieder können dir dann kein Geld mehr per PayPal senden.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel className="min-h-11">Abbrechen</AlertDialogCancel>
					<AlertDialogAction variant="destructive" className="min-h-11" onClick={onConfirm}>
						Trennen
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
