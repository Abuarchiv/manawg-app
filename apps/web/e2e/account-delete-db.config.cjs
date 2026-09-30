'use strict';

// These database tests import server-only TypeScript modules directly in Node,
// outside Next's bundler. Load this file with NODE_OPTIONS only for this suite.
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const appRoot = path.resolve(__dirname, '..');
const emptyServerOnlyMarker = require.resolve('next/dist/compiled/server-only/empty.js', {
	paths: [appRoot],
});
const originalResolveFilename = Module._resolveFilename;

if (!originalResolveFilename.__accountDeleteDbHarness) {
	const resolveAccountDeleteTestModule = function (request, parent, isMain, options) {
		const resolvedRequest =
			request === 'server-only'
				? emptyServerOnlyMarker
				: typeof request === 'string' && request.startsWith('@/')
					? path.join(appRoot, 'src', request.slice(2))
					: request;
		return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
	};
	Object.defineProperty(resolveAccountDeleteTestModule, '__accountDeleteDbHarness', {
		value: true,
	});
	Module._resolveFilename = resolveAccountDeleteTestModule;
}

module.exports = defineConfig({
	testDir: __dirname,
	testMatch: ['account-delete-db.spec.ts'],
	outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'manawg-account-delete-db-')),
	reporter: [['list']],
	projects: [{ name: 'account-delete-db', use: {} }],
	workers: 1,
	fullyParallel: false,
	forbidOnly: true,
	retries: 0,
	timeout: 120_000,
	webServer: undefined,
});
