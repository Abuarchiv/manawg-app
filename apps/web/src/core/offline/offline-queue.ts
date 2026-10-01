import { parseTimestamp } from '@/core/utils/time';

export type OfflineActionType =
	| 'shopping.create'
	| 'shopping.update'
	| 'announcement.create'
	| 'absence.create'
	| 'chore.create'
	| 'chore.complete'
	| 'expense.create'
	| 'expense.update'
	| 'recurring.create'
	| 'recurring.advance';

export interface OfflineAction {
	id: string;
	/** Stable UUID used exclusively for server-side replay protection. */
	idempotencyKey?: string;
	type: OfflineActionType;
	wgId?: string;
	shareCode: string;
	memberId: string;
	createdAt: string;
	payload: Record<string, unknown>;
	attempts?: number;
	lastAttemptAt?: string;
	lastError?: string;
}

interface OfflineActionRequest {
	path: string;
	method: 'POST' | 'PATCH';
	body: Record<string, unknown>;
}

interface OfflineActionSummary {
	title: string;
	detail: string;
}

interface OfflineFailureExplanation {
	title: string;
	detail: string;
}

interface OfflineActionRisk {
	title: string;
	detail: string;
}

/**
 * Per-type behavior for the offline queue. Declared here in core rather
 * than split across features/<name>/offline.ts: the queue mechanism itself
 * (types, retry/staleness logic, request building) is one small, cohesive
 * unit, and splitting the ~9 handlers out would need a bootstrap module to
 * import every feature's offline.ts just for its registration side effect —
 * indirection with no reader benefit over this single table.
 *
 * Declared as a `Record<OfflineActionType, OfflineActionHandler>` literal
 * (below) rather than a Map so the compiler enforces that every action type
 * has a handler — add a type to the union and `tsc` fails until its entry
 * is added here, which a Map's runtime `.get()`/`.set()` can't guarantee.
 */
interface OfflineActionHandler {
	buildRequest(action: OfflineAction): OfflineActionRequest;
	summary(action: OfflineAction): OfflineActionSummary;
	/** "Check before resending" hint shown once an action is stale or has already failed once. */
	risk(action: OfflineAction): OfflineActionRisk;
}

interface QueuedIdentityInput {
	wgId?: string;
	shareCode: string;
	memberId: string;
}

interface QueuedShoppingInput extends QueuedIdentityInput {
	idempotencyKey?: string;
	name: string;
	quantity: string | null;
	now?: number;
}

interface QueuedShoppingUpdateInput extends QueuedIdentityInput {
	itemId: string;
	name: string;
	bought: boolean;
	now?: number;
}

interface QueuedAnnouncementInput extends QueuedIdentityInput {
	idempotencyKey?: string;
	content: string;
	kind: string;
	imageUrl?: string | null;
	now?: number;
}

interface QueuedChoreCompletionInput extends QueuedIdentityInput {
	idempotencyKey?: string;
	choreId: string;
	expectedNextDueAt: string;
	now?: number;
}

interface QueuedChoreInput extends QueuedIdentityInput {
	idempotencyKey?: string;
	title: string;
	recurrenceType?: 'days' | 'months';
	intervalDays: number;
	assignedMemberId: string | null;
	now?: number;
}

interface QueuedAbsenceInput extends QueuedIdentityInput {
	idempotencyKey?: string;
	absenceMemberId: string;
	startDate: string;
	endDate: string;
	reason: string | null;
	now?: number;
}

interface QueuedExpenseInput extends QueuedIdentityInput {
	idempotencyKey?: string;
	description: string;
	amountCents: number;
	paidByMemberId: string;
	splits: Array<{ debtorMemberId: string; amountCents: number }>;
	imageUrl?: string | null;
	recurringExpenseId?: string;
	expectedRecurringNextDueAt?: string;
	now?: number;
}

interface QueuedExpenseUpdateInput extends QueuedExpenseInput {
	expenseId: string;
	expectedUpdatedAt: string;
}

interface QueuedRecurringInput extends QueuedIdentityInput {
	idempotencyKey?: string;
	description: string;
	amountCents: number;
	paidByMemberId: string;
	intervalMonths: number;
	nextDueAt: string;
	splits: Array<{ debtorMemberId: string; amountCents: number }>;
	now?: number;
}

const OFFLINE_IDEMPOTENCY_KEY_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOfflineIdempotencyKey(value: unknown): value is string {
	return typeof value === 'string' && OFFLINE_IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function createOfflineIdempotencyKey(): string | null {
	try {
		const key = crypto.randomUUID();
		return isOfflineIdempotencyKey(key) ? key : null;
	} catch {
		return null;
	}
}

function slug(value: string): string {
	return (
		value
			.trim()
			.toLocaleLowerCase('de-DE')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || 'item'
	);
}

function pathSegment(value: unknown): string {
	return encodeURIComponent(String(value));
}

function createQueuedAction(
	id: string,
	type: OfflineAction['type'],
	wgId: string | undefined,
	shareCode: string,
	memberId: string,
	payload: OfflineAction['payload'],
	now: number,
	idempotencyKeyOverride?: string,
): OfflineAction {
	const idempotencyKey = isOfflineIdempotencyKey(idempotencyKeyOverride)
		? idempotencyKeyOverride
		: createOfflineIdempotencyKey();
	return {
		id,
		...(idempotencyKey ? { idempotencyKey } : {}),
		type,
		...(wgId ? { wgId } : {}),
		shareCode,
		memberId,
		createdAt: new Date(now).toISOString(),
		payload,
	};
}

export function createQueuedShoppingItem(input: QueuedShoppingInput): OfflineAction {
	const now = input.now ?? Date.now();
	return createQueuedAction(
		`shopping:${input.shareCode}:${now}:${slug(input.name)}`,
		'shopping.create',
		input.wgId,
		input.shareCode,
		input.memberId,
		{ name: input.name, quantity: input.quantity },
		now,
		input.idempotencyKey,
	);
}

export function createQueuedShoppingUpdate(input: QueuedShoppingUpdateInput): OfflineAction {
	const now = input.now ?? Date.now();
	return createQueuedAction(
		`shopping-update:${input.shareCode}:${now}:${input.itemId}`,
		'shopping.update',
		input.wgId,
		input.shareCode,
		input.memberId,
		{ itemId: input.itemId, name: input.name, bought: input.bought },
		now,
	);
}

export function createQueuedAnnouncement(input: QueuedAnnouncementInput): OfflineAction {
	const now = input.now ?? Date.now();
	const action = createQueuedAction(
		`announcement:${input.shareCode}:${now}:${slug(input.content)}`,
		'announcement.create',
		input.wgId,
		input.shareCode,
		input.memberId,
		{ content: input.content, kind: input.kind, imageUrl: input.imageUrl ?? null },
		now,
	);
	return input.idempotencyKey && isOfflineIdempotencyKey(input.idempotencyKey)
		? { ...action, idempotencyKey: input.idempotencyKey }
		: action;
}

export function createQueuedChoreCompletion(input: QueuedChoreCompletionInput): OfflineAction {
	const now = input.now ?? Date.now();
	return createQueuedAction(
		`chore:${input.shareCode}:${now}:${input.choreId}`,
		'chore.complete',
		input.wgId,
		input.shareCode,
		input.memberId,
		{ choreId: input.choreId, expectedNextDueAt: input.expectedNextDueAt },
		now,
		input.idempotencyKey,
	);
}

export function createQueuedChore(input: QueuedChoreInput): OfflineAction {
	const now = input.now ?? Date.now();
	return createQueuedAction(
		`chore-create:${input.shareCode}:${now}:${slug(input.title)}`,
		'chore.create',
		input.wgId,
		input.shareCode,
		input.memberId,
		{
			title: input.title,
			intervalDays: input.intervalDays,
			recurrenceType: input.recurrenceType ?? 'days',
			assignedMemberId: input.assignedMemberId,
		},
		now,
		input.idempotencyKey,
	);
}

export function createQueuedAbsence(input: QueuedAbsenceInput): OfflineAction {
	const now = input.now ?? Date.now();
	return createQueuedAction(
		`absence:${input.shareCode}:${now}:${input.absenceMemberId}`,
		'absence.create',
		input.wgId,
		input.shareCode,
		input.memberId,
		{
			memberId: input.absenceMemberId,
			startDate: input.startDate,
			endDate: input.endDate,
			reason: input.reason,
		},
		now,
		input.idempotencyKey,
	);
}

export function createQueuedExpense(input: QueuedExpenseInput): OfflineAction {
	const now = input.now ?? Date.now();
	const action = createQueuedAction(
		`expense:${input.shareCode}:${now}:${slug(input.description)}`,
		'expense.create',
		input.wgId,
		input.shareCode,
		input.memberId,
		{
			description: input.description,
			amountCents: input.amountCents,
			paidByMemberId: input.paidByMemberId,
			splits: input.splits,
			imageUrl: input.imageUrl ?? null,
			...(input.recurringExpenseId ? { recurringExpenseId: input.recurringExpenseId } : {}),
			...(input.expectedRecurringNextDueAt
				? { expectedRecurringNextDueAt: input.expectedRecurringNextDueAt }
				: {}),
		},
		now,
	);
	return input.idempotencyKey && isOfflineIdempotencyKey(input.idempotencyKey)
		? { ...action, idempotencyKey: input.idempotencyKey }
		: action;
}

export function createQueuedExpenseUpdate(input: QueuedExpenseUpdateInput): OfflineAction {
	const now = input.now ?? Date.now();
	return createQueuedAction(
		`expense-update:${input.shareCode}:${now}:${input.expenseId}`,
		'expense.update',
		input.wgId,
		input.shareCode,
		input.memberId,
		{
			expenseId: input.expenseId,
			expectedUpdatedAt: input.expectedUpdatedAt,
			description: input.description,
			amountCents: input.amountCents,
			paidByMemberId: input.paidByMemberId,
			splits: input.splits,
			imageUrl: input.imageUrl,
		},
		now,
	);
}

export function createQueuedRecurring(input: QueuedRecurringInput): OfflineAction {
	const now = input.now ?? Date.now();
	return createQueuedAction(
		`recurring:${input.shareCode}:${now}:${slug(input.description)}`,
		'recurring.create',
		input.wgId,
		input.shareCode,
		input.memberId,
		{
			description: input.description,
			amountCents: input.amountCents,
			paidByMemberId: input.paidByMemberId,
			intervalMonths: input.intervalMonths,
			nextDueAt: input.nextDueAt,
			splits: input.splits,
		},
		now,
		input.idempotencyKey,
	);
}

export function serializeOfflineAction(action: OfflineAction): string {
	return JSON.stringify(action);
}

export function getOfflineActionRequest(action: OfflineAction): OfflineActionRequest {
	return offlineActionHandlers[action.type].buildRequest(action);
}

export function getOfflineActionSummary(action: OfflineAction): OfflineActionSummary {
	return offlineActionHandlers[action.type].summary(action);
}

const STALE_ACTION_RISK: OfflineActionRisk = {
	title: 'Vor dem Senden prüfen',
	detail: 'Der Eintrag ist schon länger in der Warteschlange und könnte nicht mehr aktuell sein.',
};

const offlineActionHandlers: Record<OfflineActionType, OfflineActionHandler> = {
	'shopping.create': {
		buildRequest: (action) => ({
			path: `/api/wg/${pathSegment(action.shareCode)}/shopping`,
			method: 'POST',
			body: { ...action.payload, addedByMemberId: action.memberId },
		}),
		summary: (action) => ({
			title: 'Einkauf',
			detail: String(action.payload.name ?? 'Neuer Artikel'),
		}),
		// No type-specific risk hint for this action; falls back to the generic staleness warning.
		risk: () => STALE_ACTION_RISK,
	},

	'shopping.update': {
		buildRequest: (action) => ({
			path: `/api/wg/${pathSegment(action.shareCode)}/shopping/${pathSegment(action.payload.itemId)}`,
			method: 'PATCH',
			body: { bought: action.payload.bought },
		}),
		summary: (action) => ({
			title: 'Einkauf',
			detail: `${String(action.payload.name ?? 'Artikel')} ${
				action.payload.bought === true ? 'abhaken' : 'wieder öffnen'
			}`,
		}),
		risk: () => ({
			title: 'Status prüfen',
			detail: 'Prüfe kurz, ob der Einkauf inzwischen von jemand anderem geändert wurde.',
		}),
	},

	'announcement.create': {
		buildRequest: (action) => ({
			path: `/api/wg/${pathSegment(action.shareCode)}/announcements`,
			method: 'POST',
			body: Object.fromEntries(
				Object.entries(action.payload).filter(([, value]) => value !== null),
			),
		}),
		summary: (action) => ({
			title: 'Pinnwand-Beitrag',
			detail: String(action.payload.content ?? 'Neuer Beitrag'),
		}),
		risk: () => ({
			title: 'Pinnwand prüfen',
			detail: 'Prüfe kurz, ob Inhalt, Kategorie oder Status inzwischen überholt sind.',
		}),
	},

	'absence.create': {
		buildRequest: (action) => ({
			path: `/api/wg/${pathSegment(action.shareCode)}/absences`,
			method: 'POST',
			body: Object.fromEntries(
				Object.entries(action.payload).filter(([, value]) => value !== null),
			),
		}),
		summary: () => ({
			title: 'Abwesenheit',
			detail: 'Rotation überspringt diese Person',
		}),
		risk: () => ({
			title: 'Abwesenheit prüfen',
			detail: 'Prüfe kurz, ob Zeitraum oder Putzplan inzwischen geändert wurden.',
		}),
	},

	'chore.create': {
		buildRequest: (action) => ({
			path: `/api/wg/${pathSegment(action.shareCode)}/chores`,
			method: 'POST',
			body: action.payload,
		}),
		summary: (action) => ({
			title: 'Putzplan-Aufgabe',
			detail: String(action.payload.title ?? 'Neue Aufgabe'),
		}),
		risk: () => ({
			title: 'Putzplan prüfen',
			detail: 'Prüfe kurz, ob Aufgabe, Intervall oder Zuweisung inzwischen geändert wurden.',
		}),
	},

	'chore.complete': {
		buildRequest: (action) => ({
			path: `/api/wg/${pathSegment(action.shareCode)}/chores/${pathSegment(action.payload.choreId)}/complete`,
			method: 'POST',
			body: { expectedNextDueAt: action.payload.expectedNextDueAt },
		}),
		summary: () => ({
			title: 'Putzplan',
			detail: 'Aufgabe als erledigt markieren',
		}),
		risk: () => ({
			title: 'Möglicher Konflikt',
			detail: 'Prüfe kurz, ob die Aufgabe inzwischen schon erledigt oder neu zugewiesen wurde.',
		}),
	},

	'expense.create': {
		buildRequest: (action) => {
			return {
				path: `/api/wg/${pathSegment(action.shareCode)}/expenses`,
				method: 'POST',
				body: Object.fromEntries(
					Object.entries(action.payload).filter(([, value]) => value !== null),
				),
			};
		},

		summary: (action) => ({
			title: 'Ausgabe',
			detail: String(action.payload.description ?? 'Neue Ausgabe'),
		}),
		risk: () => ({
			title: 'Aufteilung prüfen',
			detail:
				'Wenn sich Mitglieder oder Beträge geändert haben, bearbeite die Ausgabe vor dem Senden.',
		}),
	},

	'expense.update': {
		buildRequest: (action) => {
			const { expenseId, ...expensePayload } = action.payload;
			return {
				path: `/api/wg/${pathSegment(action.shareCode)}/expenses/${pathSegment(expenseId)}`,
				method: 'PATCH',
				body: expensePayload,
			};
		},
		summary: (action) => ({
			title: 'Ausgabe aktualisieren',
			detail: String(action.payload.description ?? 'Ausgabe'),
		}),
		risk: () => ({
			title: 'Version prüfen',
			detail: 'Die Ausgabe wird nur aktualisiert, wenn sie seit dem Bearbeiten unverändert blieb.',
		}),
	},

	'recurring.create': {
		buildRequest: (action) => ({
			path: `/api/wg/${pathSegment(action.shareCode)}/recurring-expenses`,
			method: 'POST',
			body: action.payload,
		}),
		summary: (action) => ({
			title: 'Fixkosten-Vorlage',
			detail: String(action.payload.description ?? 'Neue Vorlage'),
		}),
		risk: () => ({
			title: 'Fixkosten prüfen',
			detail: 'Prüfe Fälligkeit und Aufteilung, bevor die Vorlage gesendet wird.',
		}),
	},

	'recurring.advance': {
		buildRequest: (action) => ({
			path: `/api/wg/${pathSegment(action.shareCode)}/recurring-expenses`,
			method: 'PATCH',
			body: {
				id: action.payload.recurringExpenseId,
				...(typeof action.payload.expectedRecurringNextDueAt === 'string'
					? { expectedNextDueAt: action.payload.expectedRecurringNextDueAt }
					: {}),
			},
		}),
		summary: () => ({
			title: 'Fixkosten-Vorlage',
			detail: 'Fälligkeit nachholen',
		}),
		risk: () => ({
			title: 'Fixkosten prüfen',
			detail: 'Prüfe kurz, ob die Vorlage inzwischen schon weitergeschoben wurde.',
		}),
	},
};

export function explainOfflineActionFailure(
	status: number,
	error?: string,
): OfflineFailureExplanation {
	if (status === 0) {
		return {
			title: 'Noch keine Verbindung',
			detail: 'Die Aktion bleibt gespeichert und wird erneut versucht, sobald das Netz zurück ist.',
		};
	}
	if (error === 'not_a_member' || error === 'member_id_required' || error === 'member_id_invalid') {
		return {
			title: 'Mitglied nicht mehr gültig',
			detail:
				'Öffne die WG erneut oder tritt mit einem aktuellen Einladungslink bei, bevor du diese Aktion sendest.',
		};
	}
	if (error === 'member_not_in_wg') {
		return {
			title: 'Mitglied in Aktion prüfen',
			detail:
				'Ein beteiligtes Mitglied ist nicht mehr in der WG. Bearbeite Zuweisung oder Aufteilung vor dem erneuten Senden.',
		};
	}
	if (error === 'wg_not_found' || error === 'invalid_share_code') {
		return {
			title: 'WG-Link nicht mehr gültig',
			detail:
				'Prüfe den Einladungslink oder lass dir einen neuen Share-Code geben, bevor du diese Aktion sendest.',
		};
	}
	if (error === 'recurring_expense_not_found') {
		return {
			title: 'Fixkosten-Vorlage fehlt',
			detail:
				'Die Vorlage existiert nicht mehr. Entferne diese Offline-Aktion oder erstelle die Fixkosten neu.',
		};
	}
	if (error === 'item_not_found') {
		return {
			title: 'Einkauf fehlt',
			detail:
				'Der Artikel existiert nicht mehr. Entferne diese Offline-Aktion oder lege den Einkauf neu an.',
		};
	}
	if (error === 'chore_not_found') {
		return {
			title: 'Putzplan-Aufgabe fehlt',
			detail:
				'Die Aufgabe existiert nicht mehr. Entferne diese Offline-Aktion oder lege die Aufgabe neu an.',
		};
	}
	if (error === 'expense_not_found') {
		return {
			title: 'Ausgabe fehlt',
			detail:
				'Die Ausgabe existiert nicht mehr. Entferne diese Offline-Aktion oder erfasse die Ausgabe neu.',
		};
	}
	if (error === 'split_not_found') {
		return {
			title: 'Ausgabenanteil fehlt',
			detail:
				'Der Anteil existiert nicht mehr. Entferne diese Offline-Aktion oder prüfe die Ausgabe erneut.',
		};
	}
	if (status === 413) {
		return {
			title: 'Bild oder Eintrag ist zu groß',
			detail: 'Entferne den Anhang oder wähle ein kleineres Bild und versuche es erneut.',
		};
	}
	if (error === 'image_invalid') {
		return {
			title: 'Anhang prüfen',
			detail: 'Entferne den Anhang oder wähle ein gültiges Bild, bevor du erneut sendest.',
		};
	}
	if (error === 'amount_invalid') {
		return {
			title: 'Betrag prüfen',
			detail: 'Bearbeite Betrag und Aufteilung, bevor du diese Aktion erneut sendest.',
		};
	}
	if (error === 'currency_invalid') {
		return {
			title: 'Währung prüfen',
			detail: 'Erfasse die Ausgabe neu mit der aktuellen Euro-Währung.',
		};
	}
	if (error === 'splits_sum_mismatch' || error === 'splits_invalid') {
		return {
			title: 'Aufteilung prüfen',
			detail: 'Bearbeite Betrag und Aufteilung, bevor du diese Aktion erneut sendest.',
		};
	}
	if (
		error === 'name_invalid' ||
		error === 'content_invalid' ||
		error === 'title_invalid' ||
		error === 'description_invalid'
	) {
		return {
			title: 'Eintrag prüfen',
			detail: 'Bearbeite die markierten Felder, bevor du diese Aktion erneut sendest.',
		};
	}
	if (error === 'kind_invalid') {
		return {
			title: 'Kategorie prüfen',
			detail: 'Wähle eine aktuelle Pinnwand-Kategorie, bevor du den Beitrag erneut sendest.',
		};
	}
	if (error === 'source_path_invalid') {
		return {
			title: 'Quelllink prüfen',
			detail: 'Entferne den alten Quelllink oder erfasse den Pinnwand-Beitrag neu.',
		};
	}
	if (error === 'quantity_invalid') {
		return {
			title: 'Menge prüfen',
			detail: 'Kürze oder entferne die Mengenangabe, bevor du diesen Einkauf erneut sendest.',
		};
	}
	if (
		error === 'due_date_invalid' ||
		error === 'occurred_at_invalid' ||
		error === 'date_range_invalid'
	) {
		return {
			title: 'Datum prüfen',
			detail: 'Bearbeite Datum oder Zeitraum, bevor du diese Aktion erneut sendest.',
		};
	}
	if (error === 'invalid_body') {
		return {
			title: 'Offline-Aktion prüfen',
			detail:
				'Die gespeicherte Aktion passt nicht mehr zur aktuellen App. Entferne sie und erfasse den Eintrag neu.',
		};
	}
	if (error === 'id_invalid') {
		return {
			title: 'Ziel prüfen',
			detail:
				'Die gespeicherte Ziel-ID ist ungültig. Entferne diese Offline-Aktion und öffne den Eintrag neu.',
		};
	}
	if (error === 'bought_invalid') {
		return {
			title: 'Status prüfen',
			detail: 'Prüfe den Einkaufsstatus, bevor du diese Aktion erneut sendest.',
		};
	}
	if (error === 'interval_invalid') {
		return {
			title: 'Intervall prüfen',
			detail: 'Bearbeite das Intervall, bevor du diese Aktion erneut sendest.',
		};
	}
	if (error === 'reason_invalid') {
		return {
			title: 'Grund prüfen',
			detail: 'Kürze oder entferne den Abwesenheitsgrund, bevor du diese Aktion erneut sendest.',
		};
	}
	if (error === 'completion_insert_failed') {
		return {
			title: 'Putzplan unvollständig gespeichert',
			detail:
				'Die Aufgabe wurde möglicherweise rotiert, aber nicht im Verlauf protokolliert. Lade den Putzplan neu und prüfe den Verlauf vor dem erneuten Senden.',
		};
	}
	if (error === 'split_insert_failed') {
		return {
			title: 'Ausgabe unvollständig gespeichert',
			detail:
				'Die Ausgabe oder ihre Aufteilung wurde nicht vollständig gespeichert. Lade die Ausgaben neu und prüfe den Eintrag vor dem erneuten Senden.',
		};
	}
	if (error === 'insert_failed') {
		return {
			title: 'Speichern nicht bestätigt',
			detail:
				'Der Server hat den Eintrag nicht bestätigt. Lade die WG neu und prüfe, ob die Aktion bereits angekommen ist.',
		};
	}
	if (error === 'delete_failed') {
		return {
			title: 'Entfernen nicht bestätigt',
			detail:
				'Der Server hat das Entfernen nicht bestätigt. Lade die WG neu und prüfe den Eintrag vor dem erneuten Senden.',
		};
	}
	if (error === 'update_failed') {
		return {
			title: 'Aktualisierung nicht bestätigt',
			detail:
				'Der Server hat die Änderung nicht bestätigt. Lade die WG neu und prüfe den aktuellen Stand vor dem erneuten Senden.',
		};
	}
	if (status === 401 || status === 403) {
		return {
			title: 'Zugriff fehlt',
			detail: 'Öffne die WG erneut oder prüfe, ob dein Mitglied noch Zugriff hat.',
		};
	}
	if (status === 404) {
		return {
			title: 'Ziel nicht mehr gefunden',
			detail:
				'Der Eintrag oder die WG wurde inzwischen geändert. Prüfe die Aktion vor dem erneuten Versuch.',
		};
	}
	if (
		status >= 500 ||
		error === 'server_error' ||
		error === 'db_error' ||
		error === 'unexpected_error'
	) {
		return {
			title: 'Server gerade nicht bereit',
			detail: 'Die Aktion bleibt in der Warteschlange. Versuche es gleich erneut.',
		};
	}
	return {
		title: 'Synchronisierung fehlgeschlagen',
		detail: 'Die Aktion bleibt in der Warteschlange. Versuche es später noch einmal.',
	};
}

export function getOfflineRetryDelayMs(action: OfflineAction): number {
	const attempts = action.attempts ?? 0;
	if (attempts <= 0) return 0;
	return Math.min(15 * 60_000, 15_000 * 2 ** attempts);
}

export function shouldRetryOfflineAction(action: OfflineAction, now = Date.now()): boolean {
	if (!action.lastAttemptAt) return true;
	const lastAttempt = parseTimestamp(action.lastAttemptAt);
	if (lastAttempt === null) return true;
	// A lastAttempt far in the future means the device clock has been
	// corrected backwards — treat it as "now" instead of blocking retries
	// until the clock catches up.
	const effectiveLastAttempt = Math.min(lastAttempt, now);
	return now - effectiveLastAttempt >= getOfflineRetryDelayMs(action);
}

export function getOfflineActionRisk(
	action: OfflineAction,
	now = Date.now(),
): OfflineActionRisk | null {
	const createdAt = parseTimestamp(action.createdAt);
	if (createdAt === null) {
		return {
			title: 'Zeitpunkt prüfen',
			detail: 'Der gespeicherte Zeitpunkt ist unklar. Prüfe den Eintrag vor dem erneuten Senden.',
		};
	}
	if (createdAt > now) {
		return {
			title: 'Zeitpunkt prüfen',
			detail: 'Der gespeicherte Zeitpunkt liegt in der Zukunft. Prüfe den Eintrag vor dem Senden.',
		};
	}
	const ageHours = Math.floor((now - createdAt) / 3_600_000);
	if (ageHours < 6 && !action.lastError) return null;
	return offlineActionHandlers[action.type].risk(action);
}
