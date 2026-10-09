import { InputGroupAddon, InputGroupButton } from '@/components/ui/input-group';
import { ImageUploader } from '@/components/wg/ImageUploader';
import { ImagePlus } from 'lucide-react';

export function ComposerImageButton({
	disabled,
	expanded,
	onToggle,
}: {
	disabled: boolean;
	expanded: boolean;
	onToggle: () => void;
}) {
	return (
		<InputGroupAddon align="inline-start" className="py-1 ps-1">
			<InputGroupButton
				type="button"
				variant="ghost"
				size="icon-sm"
				onMouseDown={(event) => event.preventDefault()}
				onClick={onToggle}
				disabled={disabled}
				aria-label="Bild anhängen"
				aria-expanded={expanded}
				className="size-8 shrink-0 rounded-full"
			>
				<ImagePlus aria-hidden />
			</InputGroupButton>
		</InputGroupAddon>
	);
}

export function ComposerImagePanel({
	shareCode,
	value,
	onChange,
	disabled,
}: {
	shareCode: string;
	value: string | null;
	onChange: (url: string | null) => void;
	disabled: boolean;
}) {
	return (
		<div className="mx-auto w-full max-w-3xl px-4 pt-2">
			<div className="max-w-56">
				<ImageUploader
					shareCode={shareCode}
					purpose="chat"
					value={value}
					onChange={onChange}
					disabled={disabled}
					imageLabel="Chatbild"
				/>
			</div>
		</div>
	);
}
