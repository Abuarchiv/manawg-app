#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const appRoot = join(process.cwd());
const read = (relativePath) => readFileSync(join(appRoot, relativePath), 'utf8');
const failures = [];

function mustMatch(source, pattern, label) {
	if (!pattern.test(source)) failures.push(label);
}

function mustNotMatch(source, pattern, label) {
	if (pattern.test(source)) failures.push(label);
}

const schema = read('src/core/db/schema.ts');
const admin = read('src/core/guards/admin.ts');
const createWg = read('src/app/api/wg/route.ts');
const joinWg = read('src/app/api/wg/[code]/members/route.ts');
const memberPatch = read('src/app/api/wg/[code]/members/[id]/route.ts');
const config = read('drizzle.config.ts');
const idempotency = read('src/core/idempotency.ts');
const journal = JSON.parse(read('drizzle/meta/_journal.json'));

mustMatch(
	schema,
	/role:\s*text\('role'\)\.notNull\(\)\.default\('member'\)/,
	'wg_members role column',
);
mustMatch(schema, /wg_members_role_check/, 'wg_members role check');
mustMatch(schema, /wg_members_one_admin_per_wg_idx/, 'one-admin-per-WG index');
mustMatch(admin, /eq\(wgMembers\.role, 'admin'\)/, 'admin guard uses explicit role');
mustNotMatch(
	admin,
	/orderBy\(asc\(wgMembers\.createdAt\)\)/,
	'admin guard must not use member age',
);
mustMatch(createWg, /role:\s*'admin'/, 'WG creator receives admin role');
mustMatch(joinWg, /role:\s*'member'/, 'joined members receive member role');
mustMatch(
	memberPatch,
	/active === false && target\.role === 'admin'/,
	'admin cannot be deactivated',
);

const roleMigration = journal.entries.find((entry) => /^0011_/.test(entry.tag))?.tag ?? '';
mustMatch(roleMigration, /^0011_/, 'role/data migration is in the journal');
if (roleMigration && existsSync(join(appRoot, 'drizzle', `${roleMigration}.sql`))) {
	const migration = read(`drizzle/${roleMigration}.sql`);
	mustMatch(migration, /ADD COLUMN "role"/, 'role migration adds the role column');
	mustMatch(migration, /SET "role"\s*=\s*'admin'/, 'role migration preserves current admins');
	mustMatch(
		migration,
		/recurring_expenses.*amount_cents|amount_cents.*recurring_expenses/s,
		'recurring-expense amount constraint migration',
	);
}
const inventoryMigration = journal.entries.find((entry) => /^0012_/.test(entry.tag))?.tag ?? '';
mustMatch(inventoryMigration, /^0012_/, 'inventory notification migration is in the journal');
if (inventoryMigration && existsSync(join(appRoot, 'drizzle', `${inventoryMigration}.sql`))) {
	mustMatch(
		read(`drizzle/${inventoryMigration}.sql`),
		/ADD COLUMN "notify_inventory"/,
		'inventory notification migration adds the column',
	);
}

mustNotMatch(config, /postgres:\/\/placeholder/, 'drizzle config must not use a fake database URL');
mustNotMatch(config, /console\.warn\(/, 'drizzle config must not duplicate missing-URL warnings');
mustMatch(config, /dbCredentials:/, 'drizzle config keeps optional database credentials');
mustMatch(idempotency, /onConflictDoUpdate\(/, 'expired idempotency claims are reclaimable');
mustMatch(
	idempotency,
	/where:\s*sql`\$\{idempotencyResponses\.expiresAt\} <= now\(\)`/,
	'claim expiry predicate',
);

if (failures.length > 0) {
	process.stderr.write(`issue-swarm db check failed (${failures.length}):\n`);
	process.stderr.write(`${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('issue-swarm db check passed\n');
}
