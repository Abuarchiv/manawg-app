/** Shared by the durable server replay cache and the browser's safe retry window. */
export const RESPONSE_REPLAY_TTL_SECONDS = 7 * 24 * 60 * 60;

export const OFFLINE_REPLAY_CLOCK_SKEW_MS = 5 * 60 * 1000;
// Allow the initial online request to time out before enqueueing, plus replay transport.
// Both calls use apiFetch's 15-second deadline; leave the server retention unchanged.
export const OFFLINE_REPLAY_MAX_AGE_MS =
	RESPONSE_REPLAY_TTL_SECONDS * 1000 - OFFLINE_REPLAY_CLOCK_SKEW_MS - 2 * 15_000;
