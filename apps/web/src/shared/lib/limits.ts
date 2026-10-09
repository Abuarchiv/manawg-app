/**
 * Input limits shared by forms and API validation, so the browser and the
 * server reject exactly the same values. Dependency-free on purpose: client
 * components import it, and must not pull in Drizzle via `core/db/schema`.
 *
 * `MEMBER_NAME_MAX_LENGTH` mirrors `LIMITS.NAME_MAX` in `core/db/schema.ts`;
 * `tests/shared-limits.test.ts` keeps the two equal.
 */
export const WG_NAME_MAX_LENGTH = 100;
export const MEMBER_NAME_MAX_LENGTH = 80;
/** Active members a WG can hold; moved-out members do not count. */
export const MAX_MEMBERS_PER_WG = 20;
