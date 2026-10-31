#!/usr/bin/env node
/**
 * One-shot setup of a self-hosted Docker stack, run by the `setup` service before the app starts.
 * Every step is idempotent, so it runs on each `docker compose up`:
 *
 *   1. the runtime role `manawg_app` (row access only, no DDL) with MANAWG_APP_DB_PASSWORD,
 *   2. the Drizzle migrations (scripts/db-migrate, same ledger and checks as production),
 *   3. stored receipt photo links, moved onto the current NEXT_PUBLIC_APP_URL origin,
 *   4. the private image bucket with the rules of src/core/infra/private-image-policy.ts,
 *   5. the Supabase Auth mail templates, rendered for this instance into MAIL_TEMPLATES_DIR,
 *      where the gateway serves them to Auth.
 *
 * The Docker image ships this file bundled (Dockerfile); `node scripts/selfhost/setup.mjs` runs it
 * from a checkout as well.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { renderTemplate } from '../../../../supabase/templates/render.mjs';
import {
	PRIVATE_IMAGE_MAX_BYTES,
	PRIVATE_IMAGE_MIME_TYPES,
} from '../../src/core/infra/private-image-policy.ts';
import { errorCodeSuffix, safeFailureReason } from '../db-migrate/failure.mjs';
import { main as migrate } from '../db-migrate/run.mjs';
import { rewriteImageOrigins } from './image-origin.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_SOURCE = path.join(moduleDir, '..', '..', '..', '..', 'supabase', 'templates');
const MAIL_TEMPLATES = [
	'confirmation',
	'recovery',
	'magic_link',
	'email_change',
	'password_changed',
];

const log = (line) => console.error(`[setup] ${line}`);

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set.`);
	return value;
}

async function ensureRuntimeRole() {
	const client = new pg.Client({ connectionString: required('DATABASE_MIGRATION_URL') });
	await client.connect();
	try {
		const password = client.escapeLiteral(required('MANAWG_APP_DB_PASSWORD'));
		await client.query(`do $$ begin
			if not exists (select 1 from pg_roles where rolname = 'manawg_app') then
				create role manawg_app;
			end if;
		end $$`);
		await client.query(`alter role manawg_app with login bypassrls password ${password}`);
	} finally {
		await client.end();
	}
	log('Runtime role manawg_app is ready.');
}

async function moveImageOrigins() {
	const origin = new URL(required('NEXT_PUBLIC_APP_URL')).origin;
	const client = new pg.Client({ connectionString: required('DATABASE_MIGRATION_URL') });
	await client.connect();
	try {
		const counts = await rewriteImageOrigins(client, origin);
		const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
		log(`Receipt photo links point at ${origin} (${total} rewritten).`);
	} finally {
		await client.end();
	}
}

async function storage(method, route, body) {
	const response = await fetch(`${required('SUPABASE_INTERNAL_URL')}/storage/v1${route}`, {
		method,
		headers: {
			Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
			apikey: required('SUPABASE_SERVICE_ROLE_KEY'),
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(15_000),
	});
	return {
		ok: response.ok,
		status: response.status,
		body: await response.json().catch(() => null),
	};
}

async function ensureBucket() {
	const bucket = required('SUPABASE_STORAGE_BUCKET');
	const rules = {
		public: false,
		file_size_limit: PRIVATE_IMAGE_MAX_BYTES,
		allowed_mime_types: [...PRIVATE_IMAGE_MIME_TYPES],
	};
	const existing = await storage('GET', `/bucket/${encodeURIComponent(bucket)}`);
	const result = existing.ok
		? await storage('PUT', `/bucket/${encodeURIComponent(bucket)}`, rules)
		: await storage('POST', '/bucket', { id: bucket, name: bucket, ...rules });
	if (!result.ok) throw new Error(`Storage bucket setup failed with HTTP ${result.status}.`);
	log(`Private bucket ${bucket} is ready.`);
}

async function renderMailTemplates() {
	const outDir = required('MAIL_TEMPLATES_DIR');
	const appUrl = new URL(required('NEXT_PUBLIC_APP_URL')).origin;
	const legalValue = process.env.NEXT_PUBLIC_LEGAL_URL?.trim();
	const legalUrl = legalValue ? new URL(legalValue).origin : null;
	await mkdir(outDir, { recursive: true });
	for (const name of MAIL_TEMPLATES) {
		const html = await readFile(path.join(TEMPLATES_SOURCE, `${name}.html`), 'utf8');
		await writeFile(path.join(outDir, `${name}.html`), renderTemplate(html, appUrl, legalUrl));
	}
	log(`Mail templates rendered for ${appUrl}.`);
}

const progress = { stage: 'runtime-role' };
try {
	await ensureRuntimeRole();
	progress.stage = 'startup';
	process.env.MANAWG_SELF_HOSTED = 'true';
	await migrate(progress);
	progress.stage = 'image-origin';
	await moveImageOrigins();
	progress.stage = 'storage-bucket';
	await ensureBucket();
	progress.stage = 'mail-templates';
	await renderMailTemplates();
	log('Done.');
} catch (err) {
	console.error(
		`[setup] Failed [stage=${progress.stage}] [reason=${safeFailureReason(err)}]${errorCodeSuffix(err)}:`,
		err instanceof Error ? err.message : err,
	);
	process.exit(1);
}
