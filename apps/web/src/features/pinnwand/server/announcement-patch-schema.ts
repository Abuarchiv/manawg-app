import 'server-only';
import { ANNOUNCEMENT_KINDS } from '@/features/pinnwand/announcement-workflow';
import { CONTENT_MAX } from '@/features/pinnwand/components/constants';
import { z } from 'zod';

/** PATCH body of one announcement. Strict and non-empty: an empty patch would still touch updatedAt and the audit log. */
export const patchAnnouncementSchema = z
	.object({
		status: z.enum(['open', 'resolved']).optional(),
		pinned: z.boolean().optional(),
		kind: z.enum(ANNOUNCEMENT_KINDS).optional(),
		content: z.string().trim().min(1).max(CONTENT_MAX).optional(),
	})
	.strict()
	.refine((value) => Object.values(value).some((field) => field !== undefined));
