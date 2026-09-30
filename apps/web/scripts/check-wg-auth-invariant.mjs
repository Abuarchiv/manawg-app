#!/usr/bin/env node
/**
 * Auth invariant for app/wg/**.
 *
 * During a transient Supabase Auth failure the middleware serves /wg/* pages
 * instead of redirecting (src/core/auth/middleware.ts), so it is not an
 * independent barrier there. Sign-in is enforced by app/wg/[code]/layout.tsx,
 * which only covers rendered pages. A route handler or server action under
 * app/wg/** would bypass that layout, so this check fails when one appears:
 * put WG APIs under app/api/wg/** (requireWgMember) instead.
 *
 * Usage: node scripts/check-wg-auth-invariant.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const WG_DIR = join(process.cwd(), 'src', 'app', 'wg');
const LAYOUT = join(WG_DIR, '[code]', 'layout.tsx');

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (/\.(ts|tsx|js|jsx)$/.test(entry)) out.push(full);
	}
	return out;
}

const violations = [];
for (const file of walk(WG_DIR)) {
	const rel = relative(process.cwd(), file);
	if (/^route\.(ts|tsx|js|jsx)$/.test(file.split(/[\\/]/).pop() ?? '')) {
		violations.push(`${rel}: route handlers under app/wg/** bypass the WG layout auth guard`);
		continue;
	}
	if (/^\s*['"]use server['"]/m.test(readFileSync(file, 'utf8'))) {
		violations.push(`${rel}: server actions under app/wg/** bypass the WG layout auth guard`);
	}
}

const layout = readFileSync(LAYOUT, 'utf8');
if (!layout.includes('getAuthenticatedUserFromCookies()')) {
	violations.push(`${relative(process.cwd(), LAYOUT)}: must resolve the signed-in user`);
}

if (violations.length > 0) {
	console.error('[wg-auth-invariant] FAIL:\n');
	for (const violation of violations) console.error(`  - ${violation}`);
	process.exit(1);
}
process.stdout.write('[wg-auth-invariant] OK: app/wg/** is guarded by the WG layout only.\n');
