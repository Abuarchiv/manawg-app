import type { CSSProperties } from 'react';

interface MemberAvatarProps {
	name: string;
	size?: number;
	className?: string;
}

const DEFAULT_SIZE = 28;
const HIDE_INITIALS_BELOW = 18;
// Colored avatars are intentional: the rest of the UI stays monochrome, so a stable
// per-person hue is what lets flatmates tell each other apart at a glance in chat,
// Pinnwand and balances. Keyed on the name so every avatar of a person matches.
const HUES = [25, 60, 95, 145, 190, 240, 285, 330];

function hashCode(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (h << 5) - h + s.charCodeAt(i);
		h |= 0;
	}
	return Math.abs(h);
}

/** Background and initials color for a member; mixed with the theme tokens so it fits light and dark. */
export function memberTint(name: string): CSSProperties {
	const hue = HUES[hashCode(name.trim().toLocaleLowerCase('de-DE')) % HUES.length];
	const tone = `oklch(0.62 0.14 ${hue})`;
	return {
		backgroundColor: `color-mix(in oklab, ${tone} 24%, var(--background))`,
		borderColor: `color-mix(in oklab, ${tone} 40%, var(--background))`,
		color: `color-mix(in oklab, ${tone} 60%, var(--foreground))`,
	};
}

function initials(name: string): string {
	// Split on whitespace AND hyphens so "Maximilian-Christopher von Hohenzollern-Sigmaringen"
	// yields "MS" (first+last word) consistently with hyphenated names.
	const parts = name
		.trim()
		.split(/[\s-]+/)
		.filter(Boolean);
	if (parts.length === 0) return '?';
	const first = parts[0] ?? '';
	if (parts.length === 1) return first.slice(0, 2).toUpperCase();
	const last = parts[parts.length - 1] ?? first;
	return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

export function MemberAvatar({ name, size = DEFAULT_SIZE, className = '' }: MemberAvatarProps) {
	const showInitials = size >= HIDE_INITIALS_BELOW;
	const fontSize = Math.round(size * 0.42);

	return (
		<span
			aria-hidden
			className={`inline-flex shrink-0 items-center justify-center rounded-full border font-medium ${className}`}
			style={{
				...memberTint(name),
				width: size,
				height: size,
				fontSize,
			}}
		>
			{showInitials ? initials(name) : null}
		</span>
	);
}
