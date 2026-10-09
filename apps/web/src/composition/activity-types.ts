export type ActivityKind =
	| 'expense'
	| 'shopping'
	| 'announcement'
	| 'chore'
	| 'recurring'
	| 'absence'
	| 'audit';

export interface ActivityItem {
	id: string;
	kind: ActivityKind;
	timestamp: string;
	memberId?: string | null;
	memberName: string;
	text: string;
	/** True when `text` is a server-built sentence ("hat …"), not user content. */
	sentence?: boolean;
	completed: boolean;
	detail?: string;
	amountCents?: number;
	currency?: string;
	href?: string;
}

export interface ActivityFilter {
	kind: ActivityKind | 'all';
	mineOnly: boolean;
	query: string;
}

export type ActivityScope = 'all' | 'system' | 'mine' | 'changes' | 'done';
