import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
	PREVIEW_AUTH_ENV_NAMES,
	assertExactRevision,
	assertMainCiEvidence,
	assertPreviewEvent,
	assertPreviewEvidence,
	assertProductionDispatch,
	assertRequiredEnv,
} from '../scripts/release-workflow-gates.mjs';
import { isShareCodeLookup } from '../src/middleware';

const SHA = 'a'.repeat(40);
const RUN_SHA = 'b'.repeat(40);
const TREE_SHA = 'c'.repeat(40);
const CI_WORKFLOW = readFileSync(
	path.resolve(__dirname, '../../../.github/workflows/ci.yml'),
	'utf8',
);
const PRODUCTION_WORKFLOW = readFileSync(
	path.resolve(__dirname, '../../../.github/workflows/migrate-production.yml'),
	'utf8',
);
const validPreviewEvent = {
	state: 'success',
	deploymentRef: SHA,
	deploymentSha: SHA,
	environment: 'Preview',
	deploymentCreator: 'vercel[bot]',
	statusCreator: 'vercel[bot]',
	targetUrl: 'https://manawg-feature-abditubes-projects.vercel.app',
};

const validPreviewRun = {
	id: 123,
	name: 'CI',
	path: '.github/workflows/ci.yml',
	event: 'deployment_status',
	status: 'completed',
	conclusion: 'success',
	head_sha: SHA,
};

const validPreviewJobs = [
	{ name: 'db-supabase-preview', status: 'completed', conclusion: 'success' },
	{ name: 'e2e-preview', status: 'completed', conclusion: 'success' },
];

const validMainCiRun = {
	id: 456,
	name: 'CI',
	path: '.github/workflows/ci.yml',
	event: 'push',
	status: 'completed',
	conclusion: 'success',
	head_sha: SHA,
	head_branch: 'main',
};

const validMainCiJobs = [
	{ name: 'validate', status: 'completed', conclusion: 'success' },
	{ name: 'e2e-fixtures', status: 'completed', conclusion: 'success' },
];

function workflowJob(source: string, name: string): string {
	const start = source.indexOf(`  ${name}:`);
	const remainder = source.slice(start + 3);
	const nextJob = remainder.search(/\n {2}[a-z0-9-]+:/);
	return source.slice(start, nextJob === -1 ? source.length : start + 3 + nextJob);
}

test('accepts a trusted successful Preview event and returns its origin', () => {
	expect(assertPreviewEvent(validPreviewEvent)).toBe(validPreviewEvent.targetUrl);
	expect(assertPreviewEvent({ ...validPreviewEvent, deploymentRef: 'main' })).toBe(
		validPreviewEvent.targetUrl,
	);
});

test('rejects untrusted Preview actors, refs, and URL shapes', () => {
	for (const invalid of [
		{ ...validPreviewEvent, deploymentCreator: 'someone-else' },
		{ ...validPreviewEvent, deploymentRef: 'main', deploymentCreator: 'Abuarchiv' },
		{ ...validPreviewEvent, deploymentRef: 'feature' },
		{ ...validPreviewEvent, deploymentRef: 'b'.repeat(40) },
		{ ...validPreviewEvent, targetUrl: `${validPreviewEvent.targetUrl}/private` },
		{ ...validPreviewEvent, targetUrl: `${validPreviewEvent.targetUrl}?token=hidden` },
		{ ...validPreviewEvent, targetUrl: `${validPreviewEvent.targetUrl}#fragment` },
		{
			...validPreviewEvent,
			targetUrl: 'https://user:password@manawg-feature-abditubes-projects.vercel.app',
		},
		{
			...validPreviewEvent,
			targetUrl: 'https://manawg-feature-abditubes-projects.vercel.app:443',
		},
		{ ...validPreviewEvent, targetUrl: 'https://evil.example.test' },
	]) {
		expect(() => assertPreviewEvent(invalid)).toThrow();
	}
});

test('requires every protected Preview auth variable without exposing values', () => {
	expect(PREVIEW_AUTH_ENV_NAMES).toEqual([
		'SUPABASE_AUTH_TEST_EMAIL',
		'SUPABASE_AUTH_TEST_PASSWORD',
		'SUPABASE_AUTH_TEST_MEMBER_WG_CODE',
		'SUPABASE_AUTH_TEST_MEMBER_NAME',
	]);

	const values = Object.fromEntries(PREVIEW_AUTH_ENV_NAMES.map((name) => [name, 'present']));
	expect(() => assertRequiredEnv(values, PREVIEW_AUTH_ENV_NAMES, 'Preview auth')).not.toThrow();
	expect(() =>
		assertRequiredEnv(
			{ ...values, SUPABASE_AUTH_TEST_MEMBER_NAME: '' },
			PREVIEW_AUTH_ENV_NAMES,
			'Preview auth',
		),
	).toThrow('SUPABASE_AUTH_TEST_MEMBER_NAME');
});

test('keeps account membership out of the share-code rate-limit bucket', () => {
	expect(isShareCodeLookup('/api/wg/mine', 'GET')).toBe(false);
	expect(isShareCodeLookup('/api/wg/ABCDEFGH', 'GET')).toBe(true);
	expect(isShareCodeLookup('/api/wg/INVALID', 'GET')).toBe(true);
	expect(isShareCodeLookup('/api/wg/ABCDEFGH', 'POST')).toBe(false);
	// The create-WG root is a write, never a code probe.
	expect(isShareCodeLookup('/api/wg', 'GET')).toBe(false);
	// Nested reads answer existence through the same guards as the bare lookup,
	// so they belong in the tight bucket too.
	expect(isShareCodeLookup('/api/wg/ABCDEFGH/members', 'GET')).toBe(true);
	expect(isShareCodeLookup('/api/wg/ABCDEFGH/dashboard', 'GET')).toBe(true);
	expect(isShareCodeLookup('/api/wg/INVALID/members', 'GET')).toBe(true);
	expect(isShareCodeLookup('/api/wg/ABCDEFGH/members/some-member-id', 'GET')).toBe(true);
	// ...while account-membership and writes stay out of it.
	expect(isShareCodeLookup('/api/wg/mine/calendar', 'GET')).toBe(false);
	expect(isShareCodeLookup('/api/wg/ABCDEFGH/members', 'POST')).toBe(false);
	expect(isShareCodeLookup('/api/wg/ABCDEFGH/dashboard', 'PUT')).toBe(false);
});

test('filters trusted Preview statuses before protected environments and keeps push rehearsal', () => {
	for (const jobName of ['db-supabase-preview', 'e2e-preview']) {
		const job = workflowJob(CI_WORKFLOW, jobName);
		expect(job).toContain("github.event.deployment.creator.login == 'vercel[bot]'");
		expect(job).toContain("github.event.deployment_status.creator.login == 'vercel[bot]'");
		expect(job).toContain("github.event.deployment.ref == 'main'");
		expect(job).toContain('github.event.deployment.ref == github.event.deployment.sha');
		expect(job).toContain(
			"startsWith(github.event.deployment_status.target_url, 'https://manawg-')",
		);
		expect(job).toContain(
			"endsWith(github.event.deployment_status.target_url, '-abditubes-projects.vercel.app')",
		);
		expect(job.indexOf('endsWith(')).toBeLessThan(job.indexOf('environment:'));
		expect(job).toContain('name: Preview');
		expect(job).toContain('deployment: false');
	}
	expect(CI_WORKFLOW).toContain("github.event_name == 'push'");
	expect(CI_WORKFLOW).toContain("github.ref == 'refs/heads/main'");
});

test('SHA-ref Preview statuses do not depend on github.ref at the job gate', () => {
	for (const jobName of ['db-supabase-preview', 'e2e-preview']) {
		const job = workflowJob(CI_WORKFLOW, jobName);
		const gate = job.slice(0, job.indexOf('    runs-on:'));
		const deploymentGate = gate.slice(gate.indexOf("github.event_name == 'deployment_status'"));
		expect(deploymentGate).toContain('github.event.deployment.ref == github.event.deployment.sha');
		expect(deploymentGate).not.toContain('github.ref ==');
	}
	const pushGate = workflowJob(CI_WORKFLOW, 'db-supabase-preview').split(
		"github.event_name == 'deployment_status'",
	)[0];
	expect(pushGate).toContain("github.ref == 'refs/heads/main'");
});

test('PR-branch Preview statuses skip before the protected environment rejects them', () => {
	const preflight = workflowJob(CI_WORKFLOW, 'preview-source');
	expect(preflight).not.toContain('environment:');
	expect(preflight).toContain('repos/$GITHUB_REPOSITORY/commits/main');
	expect(preflight).toContain('needs: validate');
	const pushGate = workflowJob(CI_WORKFLOW, 'db-supabase-preview').split(
		"github.event_name == 'deployment_status'",
	)[0];
	expect(pushGate).toContain("needs.preview-source.outputs.trusted == 'true'");
	for (const jobName of ['db-supabase-preview', 'e2e-preview']) {
		const job = workflowJob(CI_WORKFLOW, jobName);
		const gate = job.slice(0, job.indexOf('    runs-on:'));
		expect(gate).toContain("needs.preview-source.outputs.trusted == 'true'");
		expect(job).toMatch(/needs: \[[^\]]*preview-source/);
	}
});

test('rechecks current main immediately before the production connection', () => {
	const recheck = PRODUCTION_WORKFLOW.indexOf(
		'name: Recheck current main before production connection',
	);
	const directConnection = PRODUCTION_WORKFLOW.indexOf(
		'name: Verify direct Supabase migration connection',
	);
	expect(recheck).toBeGreaterThan(-1);
	expect(directConnection).toBeGreaterThan(recheck);
	const cutoverBlock = PRODUCTION_WORKFLOW.slice(recheck, directConnection);
	expect(cutoverBlock).toContain('git ls-remote --exit-code origin refs/heads/main');
	expect(cutoverBlock).toContain('git rev-parse HEAD');
	expect(cutoverBlock).toContain('assertExactRevision');
	expect(cutoverBlock.match(/\n\s*-\s+name:/g) ?? []).toHaveLength(0);
});

test('requires the exact main revision and production confirmation', () => {
	expect(assertExactRevision(SHA, SHA)).toBeUndefined();
	expect(() => assertExactRevision(SHA, 'b'.repeat(40))).toThrow();

	expect(
		assertProductionDispatch({
			workflowRef: 'refs/heads/main',
			candidateSha: SHA,
			checkedOutSha: SHA,
			confirmation: 'MIGRATE_PRODUCTION',
		}),
	).toBeUndefined();
	expect(() =>
		assertProductionDispatch({
			workflowRef: 'refs/heads/release',
			candidateSha: SHA,
			checkedOutSha: SHA,
			confirmation: 'MIGRATE_PRODUCTION',
		}),
	).toThrow();
});

test('accepts successful main push CI evidence for the exact candidate SHA', () => {
	expect(
		assertMainCiEvidence({
			candidateSha: SHA,
			run: validMainCiRun,
			jobs: validMainCiJobs,
		}),
	).toEqual({ ciRunId: 456, sourceRevision: SHA });
});

test('rejects missing or malformed candidate SHAs for main CI evidence', () => {
	for (const candidateSha of [undefined, 'not-a-sha']) {
		expect(() =>
			assertMainCiEvidence({
				candidateSha,
				run: validMainCiRun,
				jobs: validMainCiJobs,
			}),
		).toThrow('Candidate SHA');
	}
});

test('rejects non-push, wrong-main, unsuccessful, or incomplete main CI evidence', () => {
	for (const evidence of [
		{ run: undefined, jobs: validMainCiJobs },
		{ run: { ...validMainCiRun, event: 'deployment_status' }, jobs: validMainCiJobs },
		{ run: { ...validMainCiRun, head_branch: 'fix/audit-158' }, jobs: validMainCiJobs },
		{ run: { ...validMainCiRun, head_sha: RUN_SHA }, jobs: validMainCiJobs },
		{ run: { ...validMainCiRun, path: '.github/workflows/other.yml' }, jobs: validMainCiJobs },
		{ run: { ...validMainCiRun, status: 'in_progress' }, jobs: validMainCiJobs },
		{ run: { ...validMainCiRun, conclusion: 'failure' }, jobs: validMainCiJobs },
		{ candidateSha: RUN_SHA, run: validMainCiRun, jobs: validMainCiJobs },
		{
			run: validMainCiRun,
			jobs: [{ name: 'validate', status: 'completed', conclusion: 'skipped' }, validMainCiJobs[1]],
		},
		{
			run: validMainCiRun,
			jobs: [{ name: 'validate', status: 'completed', conclusion: 'failure' }, validMainCiJobs[1]],
		},
		{
			run: validMainCiRun,
			jobs: [
				validMainCiJobs[0],
				{ name: 'e2e-fixtures', status: 'completed', conclusion: 'failure' },
			],
		},
		{ run: validMainCiRun, jobs: validMainCiJobs.slice(0, 1) },
	]) {
		expect(() =>
			assertMainCiEvidence({
				candidateSha: SHA,
				...evidence,
			}),
		).toThrow('Main CI evidence');
	}
});

test('gates Production on candidate CI without exposing Production secrets to the preflight', () => {
	const preflight = workflowJob(PRODUCTION_WORKFLOW, 'verify-candidate-ci');
	const migration = workflowJob(PRODUCTION_WORKFLOW, 'migrate');

	expect(preflight).toContain(
		'actions/workflows/ci.yml/runs?head_sha=$CANDIDATE_SHA&branch=main&event=push',
	);
	expect(preflight).toContain('/actions/runs/$MAIN_CI_RUN_ID/jobs?per_page=100');
	expect(preflight).toContain('assertProductionDispatch');
	expect(preflight).toContain('assertMainCiEvidence');
	expect(preflight).not.toContain('environment: Production');
	expect(preflight).not.toContain('secrets.');
	expect(migration).toContain('needs: verify-candidate-ci');
	expect(migration).toContain('environment: Production');
});

test('accepts successful Preview evidence for the exact candidate SHA', () => {
	expect(
		assertPreviewEvidence({
			candidateSha: SHA,
			candidateTree: TREE_SHA,
			expectedRunId: 123,
			run: validPreviewRun,
			runTree: TREE_SHA,
			jobs: validPreviewJobs,
		}),
	).toEqual({ deploymentRunId: 123, sourceRevision: SHA });

	for (const jobs of [
		[
			{ name: 'db-supabase-preview', status: 'completed', conclusion: 'failure' },
			...validPreviewJobs.slice(1),
		],
		[validPreviewJobs[0]],
	]) {
		expect(() =>
			assertPreviewEvidence({
				candidateSha: SHA,
				candidateTree: TREE_SHA,
				run: validPreviewRun,
				runTree: TREE_SHA,
				jobs,
			}),
		).toThrow();
	}

	expect(() =>
		assertPreviewEvidence({
			candidateSha: SHA,
			candidateTree: TREE_SHA,
			run: validPreviewRun,
			runTree: 'd'.repeat(40),
			jobs: validPreviewJobs,
		}),
	).toThrow('Preview deployment tree does not match');
	expect(() =>
		assertPreviewEvidence({
			candidateSha: SHA,
			candidateTree: TREE_SHA,
			run: { ...validPreviewRun, head_sha: 'not-a-sha' },
			runTree: TREE_SHA,
			jobs: validPreviewJobs,
		}),
	).toThrow();
	expect(() =>
		assertPreviewEvidence({
			candidateSha: SHA,
			candidateTree: TREE_SHA,
			run: { ...validPreviewRun, path: '.github/workflows/other.yml' },
			runTree: TREE_SHA,
			jobs: validPreviewJobs,
		}),
	).toThrow();
	expect(() =>
		assertPreviewEvidence({
			candidateSha: SHA,
			candidateTree: TREE_SHA,
			expectedRunId: 124,
			run: validPreviewRun,
			runTree: TREE_SHA,
			jobs: validPreviewJobs,
		}),
	).toThrow();
});

test('main Git pushes require an explicit Production deployment', () => {
	const config = JSON.parse(readFileSync(path.resolve(__dirname, '../vercel.json'), 'utf8'));
	expect(config.git.deploymentEnabled.main).toBe(false);
});

test('Preview jobs bind deployments to an approved source tree', () => {
	for (const jobName of ['db-supabase-preview', 'e2e-preview']) {
		const job = workflowJob(CI_WORKFLOW, jobName);
		expect(job).toContain('ref: main');
		expect(job).toContain('for trusted_ref in main fix/audit-158');
		expect(job).toContain('git checkout --detach "$DEPLOYMENT_SHA"');
		expect(job).toContain('assertMatchingTree');
	}
	expect(workflowJob(CI_WORKFLOW, 'db-supabase-preview')).toContain(
		'assertMatchingTree(process.env.DEPLOYMENT_TREE, process.env.CHECKED_OUT_TREE)',
	);
	expect(workflowJob(CI_WORKFLOW, 'e2e-preview')).toContain(
		'assertMatchingTree(process.env.DEPLOYMENT_TREE, process.env.CHECKED_OUT_TREE)',
	);
});

test('Preview jobs require the current main SHA before checking out deployment code', () => {
	const mainReadback =
		'CURRENT_MAIN_SHA="$(git ls-remote --exit-code origin refs/heads/main | cut -f1)"';
	const mainGuard = 'if [ "$DEPLOYMENT_SHA" != "$CURRENT_MAIN_SHA" ]; then';
	for (const jobName of ['db-supabase-preview', 'e2e-preview']) {
		const job = workflowJob(CI_WORKFLOW, jobName);
		expect(job).toContain(mainReadback);
		expect(job).toContain(mainGuard);
		expect(job.indexOf(mainGuard)).toBeLessThan(
			job.indexOf('git checkout --detach "$DEPLOYMENT_SHA"'),
		);
	}
});

test('Production evidence passes the candidate SHA and matching Preview tree to the gate', () => {
	expect(PRODUCTION_WORKFLOW).toContain('candidateSha: process.env.CANDIDATE_SHA');
	expect(PRODUCTION_WORKFLOW).toContain('candidateTree: process.env.CANDIDATE_TREE');
	expect(PRODUCTION_WORKFLOW).toContain('runTree: process.env.RUN_TREE');
	expect(PRODUCTION_WORKFLOW).toContain(
		"run: JSON.parse(readFileSync(process.env.PREVIEW_RUN_JSON, 'utf8'))",
	);
});

test('rejects different Preview commits even when candidate and run trees match', () => {
	const evidence = {
		candidateSha: SHA,
		candidateTree: 'c'.repeat(40),
		runTree: 'c'.repeat(40),
		expectedRunId: 123,
		run: { ...validPreviewRun, head_sha: RUN_SHA },
		jobs: validPreviewJobs,
	};
	expect(() => assertPreviewEvidence(evidence)).toThrow('Candidate SHA does not match');
});
