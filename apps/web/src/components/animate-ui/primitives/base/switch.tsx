'use client';

import { Switch as SwitchPrimitives } from '@base-ui-components/react/switch';
import {
	type HTMLMotionProps,
	type LegacyAnimationControls,
	type TargetAndTransition,
	type VariantLabels,
	motion,
	useReducedMotion,
} from 'motion/react';
import * as React from 'react';

import { useControlledState } from '@/hooks/use-controlled-state';
import { getStrictContext } from '@/lib/get-strict-context';

type SwitchContextType = {
	isChecked: boolean;
	setIsChecked: SwitchProps['onCheckedChange'];
	isPressed: boolean;
	setIsPressed: (isPressed: boolean) => void;
};

const [SwitchProvider, useSwitch] = getStrictContext<SwitchContextType>('SwitchContext');

type SwitchProps = Omit<React.ComponentProps<typeof SwitchPrimitives.Root>, 'render'> &
	HTMLMotionProps<'button'>;

function Switch({
	name,
	defaultChecked,
	checked,
	onCheckedChange,
	nativeButton,
	disabled,
	readOnly,
	required,
	inputRef,
	id,
	...props
}: SwitchProps) {
	const [isPressed, setIsPressed] = React.useState(false);
	// A quick tap is over before the glass shows, so every toggle plays it: lift, slide, settle.
	const [isGliding, setIsGliding] = React.useState(false);
	const glideTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
	React.useEffect(() => () => clearTimeout(glideTimer.current), []);
	const reduceMotion = useReducedMotion();
	const [isChecked, setIsChecked] = useControlledState({
		...(checked === undefined ? {} : { value: checked }),
		...(defaultChecked === undefined ? {} : { defaultValue: defaultChecked }),
		...(onCheckedChange === undefined ? {} : { onChange: onCheckedChange }),
	});
	const rootProps = {
		...(name === undefined ? {} : { name }),
		...(defaultChecked === undefined ? {} : { defaultChecked }),
		...(checked === undefined ? {} : { checked }),
		onCheckedChange: (...args: Parameters<typeof setIsChecked>) => {
			if (!reduceMotion) {
				clearTimeout(glideTimer.current);
				setIsGliding(true);
				glideTimer.current = setTimeout(() => setIsGliding(false), 320);
			}
			setIsChecked(...args);
		},
		// The render target below is always a real <button> (motion.button). Base UI's
		// Switch defaults nativeButton to false, which (a) leaves `type` unset on that
		// <button> -- defaulting to type="submit", so a Switch dropped inside a <form>
		// later would submit it on Space/Enter/click -- and (b) logs a dev-mode warning
		// that the render target doesn't match the (incorrect) nativeButton assumption.
		nativeButton: nativeButton ?? true,
		...(disabled === undefined ? {} : { disabled }),
		...(readOnly === undefined ? {} : { readOnly }),
		...(required === undefined ? {} : { required }),
		...(inputRef === undefined ? {} : { inputRef }),
		...(id === undefined ? {} : { id }),
	};

	return (
		<SwitchProvider
			value={{
				isChecked: isChecked ?? false,
				setIsChecked,
				isPressed: isPressed || isGliding,
				setIsPressed,
			}}
		>
			<SwitchPrimitives.Root
				{...rootProps}
				render={
					<motion.button
						data-slot="switch"
						data-pressed={isPressed ? '' : undefined}
						initial={false}
						onTapStart={() => setIsPressed(true)}
						onTapCancel={() => setIsPressed(false)}
						onTap={() => setIsPressed(false)}
						{...props}
					/>
				}
			/>
		</SwitchProvider>
	);
}

type SwitchThumbProps = Omit<React.ComponentProps<typeof SwitchPrimitives.Thumb>, 'render'> &
	HTMLMotionProps<'div'> & {
		pressedWidth?: number;
		pressedAnimation?: TargetAndTransition | VariantLabels | boolean | LegacyAnimationControls;
	};

function SwitchThumb({
	pressedWidth = 59,
	pressedAnimation: _pressedAnimation,
	transition: _transition,
	children,
	...props
}: SwitchThumbProps) {
	const { isChecked, isPressed } = useSwitch();
	const left = isPressed ? (isChecked ? 17 : -8) : isChecked ? 27.5 : 2.5;
	const top = isPressed ? 2.5 : 9.5;
	// Figma "iOS 26 Toggle (Liquid Glass)", pressed variants; its green is swapped for --primary.
	const deep = 'color-mix(in oklch, var(--primary), black 55%)';
	const rimShadow = (
		isChecked
			? [
					`inset 0.5px 0.5px 0 color-mix(in oklch, ${deep} 30%, transparent)`,
					'inset -1px -1px 0 #fff',
					'inset -2px 4px 4px rgba(0,0,0,0.08)',
					'inset -1px 1.5px 0.5px var(--primary)',
					'inset -1.5px -2px 0.5px var(--primary)',
					'inset -1.75px -2.75px 1px color-mix(in oklch, var(--primary), white 45%)',
				]
			: [
					`inset 0.5px 0.5px 0 color-mix(in oklch, ${deep} 60%, transparent)`,
					'inset -1.5px -1.5px 0 #fff',
					'inset -2px 4px 4px rgba(0,0,0,0.08)',
					'inset -3px 2.5px 0.5px var(--input)',
					'inset -3px -2.5px 0.5px var(--input)',
				]
	).join(', ');
	const thumbStyle = {
		...props.style,
		left,
		top,
		width: isPressed ? pressedWidth : 38,
		height: isPressed ? 39 : 25,
		overflow: 'hidden',
		boxShadow: isPressed
			? [
					'0 0 0 1px rgba(0,0,0,0.05)',
					'0.5px 0.5px 2px rgba(0,0,0,0.03)',
					'0 2px 32px color-mix(in oklch, var(--primary) 20%, transparent)',
				].join(', ')
			: '0.5px 0.5px 2px rgba(0,0,0,0.03)',
		// Gedrückt wird der Thumb zu Glas: deckender Rand, die Spur scheint eingerückt durch (Brandbook 11.3).
		...(isPressed
			? {
					backgroundColor: 'var(--background)',
					...(isChecked
						? {
								backgroundImage:
									'linear-gradient(180deg, transparent, color-mix(in oklch, var(--primary) 10%, transparent))',
							}
						: {}),
				}
			: {}),
	};

	return (
		<SwitchPrimitives.Thumb
			render={
				<motion.div
					data-slot="switch-thumb"
					data-pressed={isPressed ? '' : undefined}
					{...props}
					style={thumbStyle}
				>
					{/* The glass refracts the track 2.5px inward; the offset keeps it fixed while the thumb moves. */}
					<span
						aria-hidden="true"
						style={{
							position: 'absolute',
							left: 2.5 - left,
							top: 9.5 - top,
							width: 63,
							height: 25,
							borderRadius: 12.5,
							background: 'var(--switch-track)',
							opacity: isPressed ? 1 : 0,
							// No colour fade: the lens must match the real track, which switches instantly.
							// The glass clears fast so a dark track doesn't flash grey through the thumb.
							transitionProperty: 'left, top, opacity',
							transitionDuration: '280ms, 280ms, 120ms',
							transitionTimingFunction: 'inherit',
						}}
					/>
					{/* Rim highlights sit above the refracted track. */}
					<span
						aria-hidden="true"
						style={{
							position: 'absolute',
							inset: 0,
							borderRadius: 'inherit',
							boxShadow: isPressed ? rimShadow : 'none',
							transition: 'inherit',
						}}
					/>
					{children}
				</motion.div>
			}
		/>
	);
}

type SwitchIconPosition = 'left' | 'right' | 'thumb';

type SwitchIconProps = HTMLMotionProps<'div'> & {
	position: SwitchIconPosition;
};

function SwitchIcon({
	position,
	transition = { duration: 0.28, ease: 'easeOut' },
	...props
}: SwitchIconProps) {
	const { isChecked } = useSwitch();

	const isAnimated = React.useMemo(() => {
		if (position === 'right') return !isChecked;
		if (position === 'left') return isChecked;
		if (position === 'thumb') return true;
		return false;
	}, [position, isChecked]);

	return (
		<motion.div
			data-slot={`switch-${position}-icon`}
			animate={isAnimated ? { scale: 1, opacity: 1 } : { scale: 0, opacity: 0 }}
			transition={transition}
			{...props}
		/>
	);
}

export {
	Switch,
	SwitchThumb,
	SwitchIcon,
	useSwitch,
	type SwitchProps,
	type SwitchThumbProps,
	type SwitchIconProps,
	type SwitchIconPosition,
	type SwitchContextType,
};
