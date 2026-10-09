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

export function DiscardChangesDialog({
	open,
	onOpenChange,
	onDiscard,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDiscard: () => void;
}) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent className="w-[calc(100%-2rem)]">
				<AlertDialogHeader>
					<AlertDialogTitle>Änderungen verwerfen?</AlertDialogTitle>
					<AlertDialogDescription>
						Deine Eingaben sind noch nicht gespeichert.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel className="min-h-11">Weiter bearbeiten</AlertDialogCancel>
					<AlertDialogAction variant="destructive" className="min-h-11" onClick={onDiscard}>
						Verwerfen
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
