import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [layoutSource, middlewareSource, rateLimitSource] = await Promise.all([
	readFile(path.join(root, 'src/app/layout.tsx'), 'utf8'),
	readFile(path.join(root, 'src/middleware.ts'), 'utf8'),
	readFile(path.join(root, 'src/core/rate-limit.ts'), 'utf8'),
]);

const { contentSecurityPolicy } = await import('../src/shared/lib/security-headers.ts');
const policy = contentSecurityPolicy('security-boundary-test-nonce');
const scriptSource = policy.match(/script-src [^;]+/)?.[0] ?? '';
const styleSource = policy.match(/style-src [^;]+/)?.[0] ?? '';

assert.match(scriptSource, /'nonce-security-boundary-test-nonce'/);
assert.doesNotMatch(scriptSource, /'unsafe-inline'/);
assert.doesNotMatch(styleSource, /'unsafe-inline'/);
assert.match(layoutSource, /export const dynamic = 'force-dynamic'/);
assert.match(middlewareSource, /if \(!isRead && !originAllowed\(req\)\)/);
assert.match(rateLimitSource, /failMode: 'open' \| 'closed' = rateLimitFailMode\(\)/);
