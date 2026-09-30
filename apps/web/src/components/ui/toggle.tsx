'use client';

import { cn } from '@/shared/lib/cn';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { type VariantProps, cva } from 'class-variance-authority';

const toggleVariants = cva(
	"group/toggle relative inline-flex min-w-0 after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] max-w-full items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-normal [overflow-wrap:anywhere] transition-colors duration-[120ms] ease-out outline-none hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-muted data-[state=on]:bg-muted dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: 'bg-transparent',
				outline: 'border border-input bg-transparent hover:bg-muted',
				segmented:
					'flex-1 bg-transparent text-foreground/75 hover:bg-transparent aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-border',
			},
			size: {
				default:
					'min-h-9 min-w-9 h-auto px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				sm: "min-h-9 min-w-9 h-auto rounded-[min(var(--radius-md),12px)] px-2.5 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				lg: 'min-h-9 min-w-9 h-auto px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
			},
		},
		defaultVariants: {
			variant: 'default',
			size: 'default',
		},
	},
);

function Toggle({
	className,
	variant = 'default',
	size = 'default',
	...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
	return (
		<TogglePrimitive
			data-slot="toggle"
			className={cn(toggleVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Toggle, toggleVariants };
