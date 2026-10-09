'use client';

import { cn } from '@/shared/lib/cn';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { useState } from 'react';

/**
 * Space the menu keeps free at the bottom: the fixed tab bar (published by AppBottomNav as
 * --app-nav-height) plus a margin, so a tall menu flips or shrinks above it instead of
 * running underneath. Read once when the menu opens (the positioner mounts only then).
 */
function bottomCollisionPadding(): number {
	const nav = Number.parseFloat(
		document.documentElement.style.getPropertyValue('--app-nav-height'),
	);
	return (Number.isFinite(nav) ? nav : 80) + 8;
}

function MenuPositioner(props: MenuPrimitive.Positioner.Props) {
	const [bottom] = useState(bottomCollisionPadding);
	return (
		<MenuPrimitive.Positioner collisionPadding={{ top: 8, right: 8, left: 8, bottom }} {...props} />
	);
}

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
	return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
	return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
	align = 'start',
	alignOffset = 0,
	side = 'bottom',
	sideOffset = 4,
	backdrop = false,
	className,
	...props
}: MenuPrimitive.Popup.Props &
	Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> & {
		/** Dims and blurs the page behind the menu, as a messenger context menu does. */
		backdrop?: boolean;
	}) {
	return (
		<MenuPrimitive.Portal>
			{backdrop && (
				<MenuPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
			)}
			<MenuPositioner
				className="isolate z-50 outline-none"
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
			>
				<MenuPrimitive.Popup
					data-slot="dropdown-menu-content"
					className={cn(
						'z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 [&_[data-slot=dropdown-menu-item]]:min-h-[44px] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95',
						className,
					)}
					{...props}
				/>
			</MenuPositioner>
		</MenuPrimitive.Portal>
	);
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
	return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
	className,
	inset,
	variant = 'default',
	...props
}: MenuPrimitive.Item.Props & {
	inset?: boolean;
	variant?: 'default' | 'destructive';
}) {
	return (
		<MenuPrimitive.Item
			data-slot="dropdown-menu-item"
			data-inset={inset}
			data-variant={variant}
			className={cn(
				"group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
				className,
			)}
			{...props}
		/>
	);
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn('-mx-1 my-1 h-px bg-border', className)}
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
};
