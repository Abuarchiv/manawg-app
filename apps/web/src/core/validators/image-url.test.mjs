import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const validatorPath = path.join(process.cwd(), 'src/core/validators/image-url.ts');
const source = transpileModule(readFileSync(validatorPath, 'utf8'), {
	compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', source)(requireFromWeb, loaded, loaded.exports);

const wgId = '11111111-1111-4111-8111-111111111111';
const otherWgId = '99999999-9999-4999-8999-999999999999';
const objectKey = `manawg/${wgId}/expense/22222222-2222-4222-8222-222222222222.jpg`;
const { getPrivateImageKeyFromStoredUrl, isAllowedImageUrlForWg } = loaded.exports;

test('stored private image URLs keep their key across deployment origins', () => {
	const previousOrigin = process.env.NEXT_PUBLIC_APP_URL;
	process.env.NEXT_PUBLIC_APP_URL = 'https://current.example';
	try {
		const historicalUrl = `https://old-preview.example/api/upload/read?key=${encodeURIComponent(objectKey)}`;
		assert.deepEqual(getPrivateImageKeyFromStoredUrl(historicalUrl), { key: objectKey, wgId });
		assert.equal(isAllowedImageUrlForWg(historicalUrl, wgId), false);
		assert.equal(
			isAllowedImageUrlForWg(
				`https://current.example/api/upload/read?key=${encodeURIComponent(objectKey)}`,
				wgId,
			),
			true,
		);
	} finally {
		if (previousOrigin === undefined) Reflect.deleteProperty(process.env, 'NEXT_PUBLIC_APP_URL');
		else process.env.NEXT_PUBLIC_APP_URL = previousOrigin;
	}
});

test('stored private image URL parsing rejects mismatched WG keys and noncanonical URLs', () => {
	const validUrl = `https://old-preview.example/api/upload/read?key=${encodeURIComponent(objectKey)}`;
	assert.equal(getPrivateImageKeyFromStoredUrl(validUrl, otherWgId), null);
	assert.equal(getPrivateImageKeyFromStoredUrl(`${validUrl}&extra=1`), null);
	assert.equal(
		getPrivateImageKeyFromStoredUrl(validUrl.replace('/api/upload/read', '/api/upload/other')),
		null,
	);
	assert.equal(
		getPrivateImageKeyFromStoredUrl(
			`https://old-preview.example/api/upload/read?key=${encodeURIComponent(`manawg/${otherWgId}/expense/22222222-2222-4222-8222-222222222222.jpg`)}`,
			wgId,
		),
		null,
	);
});
