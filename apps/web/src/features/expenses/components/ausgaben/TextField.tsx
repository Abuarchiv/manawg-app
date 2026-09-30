'use client';

import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from '@/components/ui/input-group';
import { cn } from '@/shared/lib/cn';

interface TextFieldProps {
	id?: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	maxLength?: number;
	inputMode?: 'text' | 'decimal' | 'numeric';
	suffix?: string;
	disabled?: boolean;
	error?: string | undefined;
	enterKeyHint?: 'done' | 'next' | 'go' | 'search' | 'send';
}

export function TextField({
	id: providedId,
	label,
	value,
	onChange,
	placeholder,
	maxLength,
	inputMode = 'text',
	suffix,
	disabled = false,
	error,
	enterKeyHint,
}: TextFieldProps) {
	const id = providedId ?? `f-${label.toLowerCase().replace(/\s+/g, '-')}`;
	const errorId = `${id}-error`;
	return (
		<Field data-disabled={disabled} data-invalid={Boolean(error)}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<InputGroup>
				<InputGroupInput
					id={id}
					type="text"
					inputMode={inputMode}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					maxLength={maxLength}
					placeholder={placeholder}
					disabled={disabled}
					enterKeyHint={enterKeyHint}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? errorId : undefined}
					className={cn('min-h-11 text-base', inputMode === 'decimal' && 'font-mono tabular-nums')}
				/>
				{suffix && (
					<InputGroupAddon align="inline-end">
						<InputGroupText>{suffix}</InputGroupText>
					</InputGroupAddon>
				)}
			</InputGroup>
			{error && <FieldError id={errorId}>{error}</FieldError>}
		</Field>
	);
}
