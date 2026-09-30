'use client';

import { useEffect, useRef } from 'react';

export interface MentionMember {
	id: string;
	name: string;
}

interface MentionAutocompleteProps {
	listboxId: string;
	items: MentionMember[];
	activeIndex: number;
	onSelect: (member: MentionMember) => void;
	onHoverIndex: (index: number) => void;
}

const MAX_MENTION_SUGGESTIONS = 6;

/** Build a stable option ID for ARIA aria-activedescendant wiring. */
export function mentionOptionId(listboxId: string, index: number): string {
	return `${listboxId}-opt-${index}`;
}

/** Filter members by query — exposed so the parent combobox can drive activeIndex/keyboard. */
export function filterMentionMembers(members: MentionMember[], query: string): MentionMember[] {
	const needle = query.toLowerCase();
	return members
		.filter((member) => member.name.toLowerCase().includes(needle))
		.slice(0, MAX_MENTION_SUGGESTIONS);
}

export function MentionAutocomplete({
	listboxId,
	items,
	activeIndex,
	onSelect,
	onHoverIndex,
}: MentionAutocompleteProps) {
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		if (activeIndex < 0) return;
		const option = listRef.current?.querySelector(
			`[id="${mentionOptionId(listboxId, activeIndex)}"]`,
		);
		option?.scrollIntoView({ block: 'nearest' });
	}, [activeIndex, listboxId]);

	if (items.length === 0) return null;

	return (
		// biome-ignore lint/a11y/useFocusableInteractive: WAI-ARIA combobox listbox — focus stays on the parent textarea via aria-activedescendant, so the listbox itself is intentionally not focusable.
		<ul
			id={listboxId}
			ref={listRef}
			// biome-ignore lint/a11y/useSemanticElements: no native HTML listbox element exists; role="listbox" is the correct ARIA pattern for a combobox popup.
			// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: <ul role="listbox"> is the standard WAI-ARIA combobox popup markup.
			role="listbox"
			aria-label="WG-Mitglied erwähnen"
			className="absolute inset-x-3 bottom-[calc(100%+0.5rem)] z-10 mx-auto max-h-[min(12rem,calc(100dvh_-_7rem))] max-w-3xl overscroll-contain overflow-y-auto rounded-xl border border-border bg-popover py-1 text-popover-foreground shadow-md"
		>
			{items.map((member, index) => {
				const isActive = index === activeIndex;
				return (
					// biome-ignore lint/a11y/useFocusableInteractive: WAI-ARIA combobox option — selection is driven by the textarea's aria-activedescendant, so options are intentionally not in the tab order.
					<li
						key={member.id}
						id={mentionOptionId(listboxId, index)}
						// biome-ignore lint/a11y/useSemanticElements: no native HTML option-in-listbox element exists outside <select>; role="option" is the correct ARIA pattern here.
						// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: <li role="option"> is the standard WAI-ARIA combobox option markup.
						role="option"
						aria-selected={isActive}
						onMouseDown={(event) => {
							// Prevent textarea blur before click handler fires.
							event.preventDefault();
							onSelect(member);
						}}
						onMouseEnter={() => onHoverIndex(index)}
						className={`flex min-h-[44px] cursor-pointer items-center gap-2 px-3 py-2 text-[12px] transition-colors ${
							isActive ? 'bg-muted' : 'hover:bg-muted active:bg-muted'
						}`}
					>
						<span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
							@{member.name}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
