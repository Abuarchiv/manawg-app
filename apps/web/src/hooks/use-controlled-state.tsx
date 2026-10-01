import * as React from 'react';

interface CommonControlledStateProps<T> {
	value?: T | undefined;
	defaultValue?: T | undefined;
}

export function useControlledState<T, Rest extends unknown[] = []>(
	props: CommonControlledStateProps<T> & {
		onChange?: ((value: T, ...args: Rest) => void) | undefined;
	},
): readonly [T | undefined, (next: T, ...args: Rest) => void] {
	const { value, defaultValue, onChange } = props;

	// `defaultValue` is optional, so the initial state really can be
	// `undefined` when neither prop is supplied. Typing that honestly (`T`)
	// used to hide it behind `defaultValue as T` and left callers with a
	// runtime `undefined` their prop types did not allow for.
	const [state, setInternalState] = React.useState<T | undefined>(
		value !== undefined ? value : defaultValue,
	);

	const isControlled = value !== undefined;

	const setState = React.useCallback(
		(next: T, ...args: Rest) => {
			if (!isControlled) setInternalState(next);
			onChange?.(next, ...args);
		},
		[isControlled, onChange],
	);

	return [isControlled ? value : state, setState] as const;
}
