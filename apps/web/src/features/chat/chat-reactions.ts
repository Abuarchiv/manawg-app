import type { ChatReactionRow, ReactionSummary } from './chat-types';

/** Groups reaction rows per message and emoji, most used emoji first. */
export function summarizeReactions(
	rows: readonly ChatReactionRow[],
	currentMemberId: string,
): Map<string, ReactionSummary[]> {
	const byMessage = new Map<string, Map<string, { memberIds: string[]; mine: boolean }>>();
	for (const row of rows) {
		const messageMap = byMessage.get(row.messageId) ?? new Map();
		const entry = messageMap.get(row.emoji) ?? { memberIds: [], mine: false };
		if (row.memberId === currentMemberId) {
			entry.mine = true;
			entry.memberIds.unshift(row.memberId);
		} else entry.memberIds.push(row.memberId);
		messageMap.set(row.emoji, entry);
		byMessage.set(row.messageId, messageMap);
	}
	const result = new Map<string, ReactionSummary[]>();
	for (const [messageId, emojiMap] of byMessage) {
		const list: ReactionSummary[] = [];
		for (const [emoji, { memberIds, mine }] of emojiMap) {
			list.push({ emoji, count: memberIds.length, mine, memberIds });
		}
		list.sort((a, b) => b.count - a.count);
		result.set(messageId, list);
	}
	return result;
}

/** The rows after the viewer's own reaction was confirmed as added or removed. */
export function withOwnReaction(
	rows: ChatReactionRow[],
	kind: 'add' | 'remove',
	own: ChatReactionRow,
): ChatReactionRow[] {
	const isOwnRow = (row: ChatReactionRow) =>
		row.messageId === own.messageId && row.memberId === own.memberId && row.emoji === own.emoji;
	if (kind === 'remove') return rows.filter((row) => !isOwnRow(row));
	return rows.some(isOwnRow) ? rows : [...rows, own];
}

/** Names of the reacting members; viewers who left are shown as "Ehemaliges Mitglied". */
export function reactorNames(
	memberIds: readonly string[],
	members: ReadonlyArray<{ id: string; name: string }>,
	currentMemberId: string,
): string {
	const names = new Map(members.map((member) => [member.id, member.name]));
	return memberIds
		.map((id) => (id === currentMemberId ? 'Du' : (names.get(id) ?? 'Ehemaliges Mitglied')))
		.join(', ');
}
