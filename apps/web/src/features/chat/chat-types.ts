/** A chat message as the bubble renders it. */
export interface BubbleMessage {
	id: string;
	senderMemberId: string | null;
	kind: string;
	body: string | null;
	imageUrl: string | null;
	createdAt: string;
	editedAt: string | null;
	deletedAt: string | null;
	replyToMessageId: string | null;
}

/** One emoji under a message: how many reacted and whether the viewer did. */
export interface ReactionSummary {
	emoji: string;
	count: number;
	mine: boolean;
	/** Who reacted, the viewer first. */
	memberIds: string[];
}

export interface ChatMessageDto extends BubbleMessage {
	wgId: string;
	systemKind?: string | null;
	systemPayload?: Record<string, unknown> | null;
}

export interface ChatReactionRow {
	messageId: string;
	memberId: string;
	emoji: string;
}
