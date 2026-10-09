/** True for a unique-index hit on (wg_id, name), e.g. a join and a rename racing for one name. */
export function isUniqueMemberNameViolation(err: unknown): boolean {
	if (!err || typeof err !== 'object' || !('code' in err)) return false;
	if ((err as { code?: unknown }).code !== '23505') return false;
	const constraint = (err as { constraint?: unknown }).constraint;
	return constraint === undefined || constraint === 'wg_members_unique_name_per_wg';
}
