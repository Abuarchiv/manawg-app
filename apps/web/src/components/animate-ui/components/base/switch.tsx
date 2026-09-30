import type * as React from 'react';

import {
	SwitchIcon as SwitchIconPrimitive,
	Switch as SwitchPrimitive,
	type SwitchProps as SwitchPrimitiveProps,
	SwitchThumb as SwitchThumbPrimitive,
} from '@/components/animate-ui/primitives/base/switch';
import { cn } from '@/shared/lib/cn';

type SwitchProps = SwitchPrimitiveProps & {
	pressedWidth?: number;
	startIcon?: React.ReactElement;
	endIcon?: React.ReactElement;
	thumbIcon?: React.ReactElement;
};

function Switch({
	className,
	pressedWidth = 59,
	startIcon,
	endIcon,
	thumbIcon,
	...props
}: SwitchProps) {
	return (
		<SwitchPrimitive
			className={cn(
				// No border: it would shrink the 68px track and push the thumb off-centre.
				'group/switch relative peer inline-flex h-11 w-[68px] shrink-0 items-center rounded-[22px] border-0 bg-transparent px-0 outline-none before:absolute before:inset-x-0 before:top-1/2 before:h-[30px] before:-translate-y-1/2 before:pointer-events-none before:rounded-[15px] before:bg-(--switch-track) before:content-[""] focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
				// The thumb's pressed glass paints this colour too.
				'[--switch-track:var(--input)] data-[checked]:[--switch-track:var(--primary)] dark:data-[unchecked]:[--switch-track:color-mix(in_oklab,var(--muted-foreground)_60%,transparent)]',
				className,
			)}
			{...props}
		>
			<SwitchThumbPrimitive
				className={cn(
					'pointer-events-none absolute z-10 block rounded-full bg-background transition-[left,top,width,height,box-shadow,background-color,opacity] duration-[280ms] ease-[cubic-bezier(0.34,1.28,0.64,1)] dark:data-[checked]:bg-primary-foreground dark:data-[unchecked]:bg-foreground',
				)}
				pressedWidth={pressedWidth}
			>
				{thumbIcon && (
					<SwitchIconPrimitive
						position="thumb"
						className="absolute [&_svg]:size-[9px] left-1/2 top-1/2 -translate-1/2 dark:text-neutral-500 text-neutral-400"
					>
						{thumbIcon}
					</SwitchIconPrimitive>
				)}
			</SwitchThumbPrimitive>

			{startIcon && (
				<SwitchIconPrimitive
					position="left"
					className="absolute [&_svg]:size-[9px] left-0.5 top-1/2 -translate-y-1/2 dark:text-neutral-500 text-neutral-400"
				>
					{startIcon}
				</SwitchIconPrimitive>
			)}
			{endIcon && (
				<SwitchIconPrimitive
					position="right"
					className="absolute [&_svg]:size-[9px] right-0.5 top-1/2 -translate-y-1/2 dark:text-neutral-400 text-neutral-500"
				>
					{endIcon}
				</SwitchIconPrimitive>
			)}
		</SwitchPrimitive>
	);
}

export { Switch, type SwitchProps };
