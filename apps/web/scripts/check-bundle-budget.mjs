#!/usr/bin/env node
/**
 * Bundle budget enforcement (gzip sizes, aligned with Next.js build report).
 *
 * Reads the Turbopack build stats `.next/diagnostics/route-bundle-stats.json` and computes:
 *  - Shared first-load JS = gzip(chunks present in EVERY renderable app page)
 *  - Shared cohorts       = gzip(chunks reused by 2+ renderable app pages)
 *  - Per-route JS         = gzip(chunks used by only that page - lazy chunks)
 *
 * Budgets:
 *  - Shared first-load JS:  SHARED_JS_BUDGET_KB
 *  - Any individual route:  PER_ROUTE_BUDGET_KB
 *
 * Excluded from per-route caps and reported informationally only:
 *  - Tesseract OCR chunk:   only loaded on /wg/[code]/import OCR step
 *
 * Usage: pnpm --filter @manawg/web bundle:check
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const KILOBYTE = 1024;
// Shared counts the Next.js runtime, React and the root layout; turbopack ships them on every page.
const SHARED_JS_BUDGET_KB = 220;
const PER_ROUTE_BUDGET_KB = 55;
const TESSERACT_INFO_BUDGET_KB = 2500;
const TESSERACT_CHUNK_HINT = 'tesseract';

const PROJECT_ROOT = resolve(process.cwd());
const NEXT_DIR = resolve(PROJECT_ROOT, process.env.NEXT_DIST_DIR ?? '.next');
const ROUTE_STATS = join(NEXT_DIR, 'diagnostics/route-bundle-stats.json');

function fail(message) {
	console.error(`\n[bundle-budget] FAIL: ${message}`);
	process.exit(1);
}

function info(message) {
	process.stdout.write(`[bundle-budget] ${message}\n`);
}

function gzipSizeKb(relativePath) {
	const abs = join(NEXT_DIR, relativePath);
	if (!existsSync(abs)) return 0;
	const raw = readFileSync(abs);
	return gzipSync(raw).length / KILOBYTE;
}

function sumGzipKb(paths) {
	let total = 0;
	for (const p of paths) {
		if (!p.endsWith('.js')) continue;
		total += gzipSizeKb(p);
	}
	return total;
}

function readJson(path) {
	if (!existsSync(path)) {
		fail(`Manifest not found: ${path}. Run \`pnpm --filter @manawg/web build\` first.`);
	}
	return JSON.parse(readFileSync(path, 'utf-8'));
}

function isLazyChunk(path) {
	return path.includes(TESSERACT_CHUNK_HINT);
}

function isRenderablePageEntry(entry) {
	return (
		entry.endsWith('/page') &&
		!entry.startsWith('/api/') &&
		!entry.endsWith('/route') &&
		!['/layout', '/error', '/loading'].some((suffix) => entry.endsWith(suffix))
	);
}

function scanTesseractRawKb() {
	const chunksDir = join(NEXT_DIR, 'static/chunks');
	if (!existsSync(chunksDir)) return 0;
	let total = 0;
	for (const f of readdirSync(chunksDir)) {
		if (f.includes(TESSERACT_CHUNK_HINT) && f.endsWith('.js')) {
			total += statSync(join(chunksDir, f)).size / KILOBYTE;
		}
	}
	return total;
}

function main() {
	// Chunk paths in the stats start with the dist dir; sizes are read relative to it.
	const manifestEntries = readJson(ROUTE_STATS).map(({ route, firstLoadChunkPaths }) => [
		`${route === '/' ? '' : route}/page`,
		firstLoadChunkPaths.map((chunk) => chunk.slice(chunk.indexOf('static/'))),
	]);
	const pageEntries = manifestEntries.filter(([page]) => isRenderablePageEntry(page));
	if (pageEntries.length === 0) fail('No pages in route-bundle-stats.json');

	info(`Renderable page entries: ${pageEntries.length}/${manifestEntries.length}`);

	// Shared = chunks present in EVERY renderable page (Next.js semantics).
	const counts = new Map();
	for (const [, chunks] of pageEntries) {
		for (const c of new Set(chunks)) {
			counts.set(c, (counts.get(c) ?? 0) + 1);
		}
	}
	const totalPages = pageEntries.length;
	const sharedChunks = new Set(
		[...counts.entries()].filter(([, n]) => n === totalPages).map(([c]) => c),
	);
	const sharedCohorts = new Map();
	for (const [chunk, count] of counts) {
		if (count < 2) continue;
		const cohort = sharedCohorts.get(count) ?? [];
		cohort.push(chunk);
		sharedCohorts.set(count, cohort);
	}

	const sharedKb = sumGzipKb([...sharedChunks]);
	const failures = [];

	info(`Shared first-load JS (gzip): ${sharedKb.toFixed(1)} kB (budget ${SHARED_JS_BUDGET_KB} kB)`);
	if (sharedKb > SHARED_JS_BUDGET_KB) {
		failures.push(
			`Shared first-load JS ${sharedKb.toFixed(1)} kB exceeds ${SHARED_JS_BUDGET_KB} kB`,
		);
	}
	info('Shared cohorts (gzip, reused by 2+ renderable pages):');
	for (const [count, chunks] of [...sharedCohorts.entries()].sort((a, b) => b[0] - a[0])) {
		info(`  ${count}/${totalPages} pages: ${sumGzipKb(chunks).toFixed(1)} kB`);
	}

	const perRouteResults = [];
	for (const [page, chunks] of pageEntries) {
		const routeOnly = chunks.filter((c) => counts.get(c) === 1 && !isLazyChunk(c));
		const sizeKb = sumGzipKb(routeOnly);
		perRouteResults.push({ page, sizeKb });
		if (sizeKb > PER_ROUTE_BUDGET_KB) {
			failures.push(`Route ${page} = ${sizeKb.toFixed(1)} kB exceeds ${PER_ROUTE_BUDGET_KB} kB`);
		}
	}

	const tesseractKb = scanTesseractRawKb();
	if (tesseractKb > 0) {
		const status = tesseractKb > TESSERACT_INFO_BUDGET_KB ? 'WARN' : 'INFO';
		info(`[${status}] Tesseract OCR chunk: ${tesseractKb.toFixed(1)} kB raw (informational only)`);
	} else {
		info(
			'Tesseract OCR chunk not emitted as static asset (loaded from public/tesseract at runtime)',
		);
	}

	const sortedRoutes = [...perRouteResults].sort((a, b) => b.sizeKb - a.sizeKb).slice(0, 5);
	info('Top 5 routes by route-specific gzip JS:');
	for (const r of sortedRoutes) {
		info(`  ${r.page.padEnd(48)} ${r.sizeKb.toFixed(1)} kB`);
	}

	// Informational: chunks shared by only some pages (the client message runtime) count here, not in the budgets.
	const firstLoad = pageEntries
		.filter(([page]) => page.startsWith('/wg/[code]'))
		.map(([page, chunks]) => ({ page, sizeKb: sumGzipKb(new Set(chunks)) }))
		.sort((a, b) => b.sizeKb - a.sizeKb)[0];
	if (firstLoad) {
		info(`Largest /wg/[code] first-load JS: ${firstLoad.page} ${firstLoad.sizeKb.toFixed(1)} kB`);
	}

	if (failures.length > 0) {
		console.error('\n[bundle-budget] Budget violations:');
		for (const f of failures) console.error(`  - ${f}`);
		process.exit(1);
	}
	info('All bundle budgets within limits.');
}

main();
