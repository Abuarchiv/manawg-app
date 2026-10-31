import { isRateLimited } from '@/core/http/error-codes';
import type { Message } from '@/shared/i18n/message';
import type deMessages from '@/shared/i18n/messages/de';
import type { OfflineAction } from './offline-action';

/**
 * Why a queued offline action could not be sent. Specific server error codes win over the
 * generic status buckets; the order of the checks in {@link explainOfflineActionFailure} is
 * part of the contract.
 */

export interface OfflineFailureExplanation {
	title: Message;
	detail: Message;
}

type FailureName = keyof (typeof deMessages)['offline']['failure'];

/**
 * Texts that older builds match on in `lastError`. New failures also carry flags and a message,
 * so these stay as persisted markers and are never shown for new rows.
 */
// i18n-ignore persisted marker matched by older builds
const OFFLINE_NO_CONNECTION_TITLE = 'Noch keine Verbindung';
// i18n-ignore persisted marker matched by older builds
export const SERVER_CHECK_PREFIX = 'Server prüfen:';
// i18n-ignore persisted marker matched by older builds
const IMAGE_MISSING_PREFIX = 'Bild fehlt:';
// i18n-ignore persisted marker matched by older builds
const IMAGE_REMOVED_PREFIX = 'Bild wurde entfernt:';

const NO_CONNECTION_ERROR = `${OFFLINE_NO_CONNECTION_TITLE}: Die Aktion bleibt gespeichert und wird erneut versucht, sobald das Netz zurück ist.`; // i18n-ignore persisted text
const IMAGE_REMOVED_ERROR = `${IMAGE_REMOVED_PREFIX} Entferne den Anhang in der Offline-Warteschlange oder wähle das Bild erneut aus.`; // i18n-ignore persisted text
const IMAGE_MISSING_ERROR = `${IMAGE_MISSING_PREFIX} Der lokale Anhang ist nicht mehr verfügbar. Entferne den Anhang in der Offline-Warteschlange oder wähle das Bild erneut aus.`; // i18n-ignore persisted text

/** Server error codes with their own explanation; several codes share one. */
const FAILURE_BY_CODE: Readonly<Record<string, FailureName>> = {
	migration_read_only: 'maintenance',
	not_a_member: 'memberInvalid',
	member_deactivated: 'movedOut',
	member_not_in_wg: 'memberInAction',
	wg_not_found: 'flatLinkInvalid',
	invalid_share_code: 'flatLinkInvalid',
	recurring_expense_not_found: 'templateMissing',
	recurring_expense_changed: 'templateChanged',
	recurring_paused: 'recurringPaused',
	item_not_found: 'shoppingMissing',
	shopping_item_changed: 'shoppingChanged',
	chore_occurrence_changed: 'choreChanged',
	chore_not_found: 'choreMissing',
	expense_not_found: 'expenseMissing',
	expense_changed: 'expenseChanged',
	expense_has_settled_shares: 'expenseSettled',
	recurring_expense_already_advanced: 'recurringAdvanced',
	split_not_found: 'splitMissing',
	image_invalid: 'imageInvalid',
	amount_invalid: 'amountInvalid',
	currency_invalid: 'currencyInvalid',
	splits_sum_mismatch: 'splitsInvalid',
	splits_invalid: 'splitsInvalid',
	name_invalid: 'entryInvalid',
	content_invalid: 'entryInvalid',
	title_invalid: 'entryInvalid',
	description_invalid: 'entryInvalid',
	kind_invalid: 'kindInvalid',
	source_path_invalid: 'sourceInvalid',
	quantity_invalid: 'quantityInvalid',
	due_date_invalid: 'dateInvalid',
	occurred_at_invalid: 'dateInvalid',
	date_range_invalid: 'dateInvalid',
	absence_overlaps_existing: 'absenceOverlaps',
	invalid_body: 'actionInvalid',
	id_invalid: 'targetInvalid',
	bought_invalid: 'statusInvalid',
	interval_invalid: 'intervalInvalid',
	reason_invalid: 'reasonInvalid',
	completion_insert_failed: 'choreIncomplete',
	split_insert_failed: 'expenseIncomplete',
	insert_failed: 'saveUnconfirmed',
	delete_failed: 'removeUnconfirmed',
	update_failed: 'updateUnconfirmed',
};

const SERVER_ERROR_CODES = new Set(['server_error', 'db_error', 'unexpected_error']);

function failure(name: FailureName): OfflineFailureExplanation {
	return {
		title: { key: `offline.failure.${name}.title` },
		detail: { key: `offline.failure.${name}.detail` },
	};
}

export function explainOfflineActionFailure(
	status: number,
	error?: string,
	heldForReview = false,
): OfflineFailureExplanation {
	const code = error ?? null;
	if (status === 0) return failure('noConnection');
	// Covers 429 and every `*_rate_limited` code: the queue retries these by itself.
	if (isRateLimited(code, status)) return failure('rateLimited');
	const known =
		code !== null && Object.hasOwn(FAILURE_BY_CODE, code) ? FAILURE_BY_CODE[code] : null;
	if (known) return failure(known);
	if (status === 413) return failure('tooLarge');
	if (status === 401) return failure('sessionExpired');
	if (status === 403) return failure('accessMissing');
	if (status === 404) return failure('targetGone');
	if (status >= 500 || (code !== null && SERVER_ERROR_CODES.has(code))) {
		return failure('serverNotReady');
	}
	// A held action is not resent, so "try later" would be wrong for it.
	return failure(heldForReview ? 'rejected' : 'syncFailed');
}

/** "{title}: {detail}" of an explanation as one message. */
export function titled(explanation: OfflineFailureExplanation): Message {
	return {
		key: 'common.errors.withSubject',
		values: { subject: explanation.title, detail: explanation.detail },
	};
}

/** What a failed attempt records on the queued action. */
export type FailureState = Pick<
	OfflineAction,
	'lastError' | 'lastErrorMessage' | 'needsReview' | 'noConnection'
>;

function diagnostic(status: number, error?: string): string {
	return error ? `${status}:${error}` : String(status);
}

/**
 * The state for a rejected or failed request. `holdForReview` marks answers that repeat on every
 * replay, so the action waits for a person instead of being resent.
 */
export function requestFailureState(
	status: number,
	error: string | undefined,
	holdForReview: boolean,
): FailureState {
	const explanation = explainOfflineActionFailure(status, error, holdForReview);
	if (status === 0) {
		return {
			lastError: NO_CONNECTION_ERROR,
			lastErrorMessage: titled(explanation),
			noConnection: true,
		};
	}
	if (holdForReview) {
		return {
			lastError: `${SERVER_CHECK_PREFIX} ${diagnostic(status, error)}`,
			lastErrorMessage: { key: 'offline.state.serverCheck', values: { ...explanation } },
			needsReview: 'server',
		};
	}
	return { lastError: diagnostic(status, error), lastErrorMessage: titled(explanation) };
}

export const IMAGE_REMOVED_STATE: FailureState = {
	lastError: IMAGE_REMOVED_ERROR,
	lastErrorMessage: { key: 'offline.state.imageRemoved' },
	needsReview: 'imageRemoved',
};

export const IMAGE_MISSING_STATE: FailureState = {
	lastError: IMAGE_MISSING_ERROR,
	lastErrorMessage: { key: 'offline.state.imageMissing' },
	needsReview: 'imageMissing',
};

/** A note without a legacy text for older builds; the message is what people read. */
export function noteState(key: 'reauth' | 'idempotency' | 'recurringAdvance'): FailureState {
	return { lastError: key, lastErrorMessage: { key: `offline.state.${key}` } };
}

/** The action with `state` as its last failure; flags of an earlier failure do not carry over. */
export function withFailureState(action: OfflineAction, state: FailureState): OfflineAction {
	const { lastError, lastErrorMessage, needsReview, noConnection, ...rest } = action;
	return { ...rest, ...state };
}

/** True when the last failure holds the action for a look at the server state. */
export function holdsServerReview(action: OfflineAction): boolean {
	return (
		action.needsReview === 'server' || action.lastError?.startsWith(SERVER_CHECK_PREFIX) === true
	);
}

/** True when the last attempt never reached the server. */
export function failedWithoutConnection(action: OfflineAction): boolean {
	return (
		action.noConnection === true ||
		action.lastError?.startsWith(OFFLINE_NO_CONNECTION_TITLE) === true
	);
}

/** True when a pending image blocks the action. */
export function holdsImageReview(action: OfflineAction): boolean {
	return (
		action.needsReview === 'imageMissing' ||
		action.needsReview === 'imageRemoved' ||
		action.lastError?.startsWith(IMAGE_MISSING_PREFIX) === true ||
		action.lastError?.startsWith(IMAGE_REMOVED_PREFIX) === true
	);
}
