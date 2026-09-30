import { cn } from '@/shared/lib/cn';
import { type VariantProps, cva } from 'class-variance-authority';

function Empty({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="empty"
			className={cn(
				'mx-auto flex w-full max-w-3xl min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-dashed p-6 text-center text-balance',
				className,
			)}
			{...props}
		/>
	);
}

function EmptyHeader({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="empty-header"
			className={cn(
				'flex w-full min-w-0 max-w-sm flex-col items-center gap-2 [overflow-wrap:anywhere]',
				className,
			)}
			{...props}
		/>
	);
}

const emptyMediaVariants = cva(
	'mb-1 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0',
	{
		variants: {
			variant: {
				default: 'bg-transparent',
				icon: "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-4",
			},
		},
		defaultVariants: {
			variant: 'default',
		},
	},
);

function EmptyMedia({
	className,
	variant = 'default',
	...props
}: React.ComponentProps<'div'> & VariantProps<typeof emptyMediaVariants>) {
	return (
		<div
			data-slot="empty-icon"
			data-variant={variant}
			className={cn(emptyMediaVariants({ variant, className }))}
			{...props}
		/>
	);
}

function EmptyTitle({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="empty-title"
			className={cn(
				'min-w-0 max-w-full text-[14px] font-semibold [overflow-wrap:anywhere]',
				className,
			)}
			{...props}
		/>
	);
}

function EmptyDescription({ className, ...props }: React.ComponentProps<'p'>) {
	return (
		<div
			data-slot="empty-description"
			className={cn(
				'min-w-0 max-w-full text-[12px]/normal text-muted-foreground [overflow-wrap:anywhere] [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary',
				className,
			)}
			{...props}
		/>
	);
}

function EmptyContent({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="empty-content"
			className={cn(
				'flex w-full max-w-sm min-w-0 flex-col items-center gap-2.5 text-sm text-balance [overflow-wrap:anywhere]',
				className,
			)}
			{...props}
		/>
	);
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
