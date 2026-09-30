import type { AnnouncementKind } from '@/features/pinnwand/components/announcement-types';

export const CONTENT_MAX = 2000;
export const REFRESH_INTERVAL_MS = 30_000;

export const KIND_OPTIONS: ReadonlyArray<{ value: AnnouncementKind; label: string }> = [
	{ value: 'info', label: 'Info' },
	{ value: 'question', label: 'Frage' },
	{ value: 'problem', label: 'Problem' },
	{ value: 'request', label: 'Bitte' },
	{ value: 'decision', label: 'Entscheidung' },
];

export const KIND_LABELS: Record<AnnouncementKind, string> = {
	info: 'Info',
	question: 'Frage',
	problem: 'Problem',
	request: 'Bitte',
	decision: 'Entscheidung',
};
