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

	// `defaultValue` is optional, so the uncontrolled state really can be
	// `undefined` when neither prop is supplied. It is typed `T | undefined`
	// instead of being cast with `defaultValue as T`, which would give callers
	// a runtime `undefined` their prop types do not allow for.
	const [internal, setInternalState] = React.useState<T | undefined>(defaultValue);
	// A controlled value always wins: when the parent rejects a change and keeps
	// the prop, the UI must keep showing the prop rather than the attempted value.
	const state = value !== undefined ? value : internal;

	const setState = React.useCallback(
		(next: T, ...args: Rest) => {
			setInternalState(next);
			onChange?.(next, ...args);
		},
		[onChange],
	);

	return [state, setState] as const;
}
