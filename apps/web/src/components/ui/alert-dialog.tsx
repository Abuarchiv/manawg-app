'use client';

import { cn } from '@/shared/lib/cn';
import { useDismissOnBack } from '@/shared/lib/use-dismiss-on-back';
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import * as React from 'react';

import { Button } from '@/components/ui/button';

function AlertDialog({
	open: openProp,
	defaultOpen = false,
	onOpenChange,
	actionsRef: _ignoredActionsRef,
	...props
}: AlertDialogPrimitive.Root.Props) {
	// Back-button dismissal needs the primitive's imperative close() action, so
	// this wrapper always owns actionsRef (no caller uses it today).
	const actionsRef = React.useRef<AlertDialogPrimitive.Root.Actions>(null);
	const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
	const open = openProp ?? uncontrolledOpen;

	useDismissOnBack(open, actionsRef);

	return (
		<AlertDialogPrimitive.Root
			data-slot="alert-dialog"
			open={openProp}
			defaultOpen={defaultOpen}
			actionsRef={actionsRef}
			onOpenChange={(nextOpen, eventDetails) => {
				setUncontrolledOpen(nextOpen);
				onOpenChange?.(nextOpen, eventDetails);
			}}
			{...props}
		/>
	);
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
	return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
	return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) {
	return (
		<AlertDialogPrimitive.Backdrop
			data-slot="alert-dialog-overlay"
			className={cn(
				'fixed inset-0 isolate z-50 bg-black/40 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogContent({
	className,
	size = 'default',
	...props
}: AlertDialogPrimitive.Popup.Props & {
	size?: 'default' | 'sm';
}) {
	return (
		<AlertDialogPortal>
			<AlertDialogOverlay />
			<AlertDialogPrimitive.Popup
				data-slot="alert-dialog-content"
				data-size={size}
				className={cn(
					'group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid grid-cols-[minmax(0,1fr)] w-full min-w-0 max-w-[calc(100%-2rem)] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 duration-[220ms] outline-none *:min-w-0 data-[size=default]:max-w-[min(calc(100%-2rem),24rem)] data-[size=sm]:max-w-[min(calc(100%-2rem),20rem)] data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0',
					className,
				)}
				{...props}
			/>
		</AlertDialogPortal>
	);
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="alert-dialog-header"
			className={cn(
				'grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] min-w-0 place-items-center gap-1.5 text-center *:min-w-0 has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4',
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="alert-dialog-footer"
			className={cn(
				'-mx-4 -mb-4 flex min-w-0 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 *:min-w-0 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2',
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogMedia({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="alert-dialog-media"
			className={cn(
				"mb-2 inline-flex size-10 items-center justify-center rounded-md bg-muted *:[svg:not([class*='size-'])]:size-6",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogTitle({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
	return (
		<AlertDialogPrimitive.Title
			data-slot="alert-dialog-title"
			className={cn(
				'max-w-full min-w-0 font-heading text-base font-medium [overflow-wrap:anywhere]',
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogDescription({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
	return (
		<AlertDialogPrimitive.Description
			data-slot="alert-dialog-description"
			className={cn(
				'max-w-full min-w-0 text-sm text-balance text-muted-foreground [overflow-wrap:anywhere] *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogAction({
	className,
	variant = 'default',
	size = 'default',
	...props
}: AlertDialogPrimitive.Close.Props &
	Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
	return (
		<AlertDialogPrimitive.Close
			data-slot="alert-dialog-action"
			className={cn(className)}
			render={<Button variant={variant} size={size} />}
			{...props}
		/>
	);
}

function AlertDialogCancel({
	className,
	variant = 'outline',
	size = 'default',
	...props
}: AlertDialogPrimitive.Close.Props &
	Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
	return (
		<AlertDialogPrimitive.Close
			data-slot="alert-dialog-cancel"
			className={cn(className)}
			render={<Button variant={variant} size={size} />}
			{...props}
		/>
	);
}

export {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogOverlay,
	AlertDialogPortal,
	AlertDialogTitle,
	AlertDialogTrigger,
};
