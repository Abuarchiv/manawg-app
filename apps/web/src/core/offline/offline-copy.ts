export function formatQueuedOfflineActions(count: number): string {
	if (count === 1) return '1 Offline-Aktion wartet auf Synchronisierung.';
	return `${count} Offline-Aktionen warten auf Synchronisierung.`;
}

export function formatOfflineQueueCount(count: number): string {
	if (count === 0) return 'Keine wartenden Offline-Aktionen.';
	if (count === 1) return '1 Aktion wartet.';
	return `${count} Aktionen warten.`;
}

export function formatQueuedOfflineEntries(count: number): string {
	if (count === 1) return '1 Offline-Eintrag wartet auf Synchronisierung.';
	return `${count} Offline-Einträge warten auf Synchronisierung.`;
}

export function formatSyncedOfflineActions(count: number): string {
	if (count === 1) return '1 Offline-Aktion synchronisiert.';
	return `${count} Offline-Aktionen synchronisiert.`;
}

function formatSyncedActions(count: number, offlineLabel: boolean): string {
	if (offlineLabel) return formatSyncedOfflineActions(count);
	if (count === 1) return '1 Aktion synchronisiert.';
	return `${count} Aktionen synchronisiert.`;
}

function formatRemainingActions(count: number): string {
	if (count === 1) return '1 Aktion wartet weiter.';
	return `${count} Aktionen warten weiter.`;
}

export function formatManualOfflineSyncResult(
	synced: number,
	remaining: number,
	options?: { offlineLabel?: boolean },
): string {
	if (synced > 0 && remaining > 0) {
		return `${formatSyncedActions(synced, options?.offlineLabel ?? true)} ${formatRemainingActions(
			remaining,
		)}`;
	}
	if (synced > 0) return formatSyncedActions(synced, options?.offlineLabel ?? true);
	if (remaining === 0) return 'Keine wartenden Aktionen mehr.';
	return 'Noch nichts synchronisiert. Die Aktionen bleiben sicher gespeichert.';
}

export function getOfflineSyncFailureMessage(): string {
	return 'Synchronisierung konnte nicht gestartet werden. Prüfe deine Verbindung; die Aktionen bleiben gespeichert.';
}

/** Shown when enqueueing a new offline action fails because storage is blocked (private mode, quota, ...). */
export const OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE =
	'Offline-Speicher ist blockiert. Lass den Entwurf offen und versuche es später erneut.';

/** Shown after a successful offline enqueue when clearing the now-stale local draft fails. */
export const OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE =
	'Offline gespeichert, aber der alte Entwurf konnte nicht entfernt werden. Prüfe die Offline-Warteschlange.';

/** Shown when a queued entry that is being edited was synced (or discarded) in the meantime. */
export const QUEUE_EDIT_ALREADY_SENT_MESSAGE =
	'Der Eintrag wurde inzwischen schon gesendet – bitte prüfe die Liste.';

/** Shown after a successful online save when clearing the now-stale local draft fails. */
export const DRAFT_CLEANUP_FAILED_MESSAGE =
	'Gespeichert, aber der alte Offline-Entwurf konnte nicht entfernt werden.';
