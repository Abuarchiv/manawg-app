import { auditEvents, db } from '@/core/db';
import { logApiError } from '@/core/infra/observability';

interface AuditEventInput {
	wgId: string;
	memberId?: string | null;
	eventType: string;
	entityType: string;
	entityId?: string | null;
	summary: string;
	metadata?: Record<string, unknown>;
}

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
	try {
		await db.insert(auditEvents).values({
			wgId: input.wgId,
			memberId: input.memberId ?? null,
			eventType: input.eventType,
			entityType: input.entityType,
			entityId: input.entityId ?? null,
			summary: input.summary,
			metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
		});
	} catch (err) {
		// Keep mutations best-effort: propagating an audit failure after the
		// mutation would make clients retry successful writes. Surface the loss
		// at error level so the platform log can alert on it.
		logApiError('[audit] event not recorded', err);
	}
}
