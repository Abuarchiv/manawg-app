import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { checkEnv } from '../src/core/infra/env.ts';
import {
	PRIVATE_IMAGE_MAX_BYTES,
	isAllowedPrivateImageMimeType,
	isValidPrivateImageSize,
} from '../src/core/infra/private-image-policy.ts';
import {
	getPrivateImageUrl,
	imageUrlSchema,
	isAllowedImageUrlForWg,
	parsePrivateImageKey,
} from '../src/core/validators/image-url.ts';

// Private image URL grammar, origin selection, storage provider env requirements and the upload
// size / MIME allowlist. Protects against path traversal and leaking private object URLs.

const WG_A = '11111111-1111-4111-8111-111111111111';
const WG_B = '22222222-2222-4222-8222-222222222222';
const IMAGE_ID = '33333333-3333-4333-8333-333333333333';
const PRIVATE_KEY = `manawg/${WG_A}/expense/${IMAGE_ID}.webp`;

const ENV_KEYS = [
	'VERCEL_URL',
	'VERCEL_ENV',
	'NEXT_PUBLIC_APP_URL',
	'S3_PUBLIC_URL',
	'S3_BUCKET',
	'AWS_REGION',
	'IMAGE_STORAGE_PROVIDER',
	'SUPABASE_SERVICE_ROLE_KEY',
	'SUPABASE_STORAGE_BUCKET',
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function baseEnv(): Record<string, string> {
	return {
		POSTGRES_URL: 'postgres://user:pass@host/db',
		MEMBER_SESSION_SECRET: 'session-secret',
		NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
		NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
		VERCEL_ENV: 'preview',
		AWS_ACCESS_KEY_ID: 'aws-key',
		AWS_SECRET_ACCESS_KEY: 'aws-secret',
		AWS_REGION: 'eu-central-1',
		S3_BUCKET: 'legacy-bucket',
	};
}

describe('private image URL contract', () => {
	beforeEach(() => {
		setEnv({
			VERCEL_URL: 'preview.manawg.example',
			VERCEL_ENV: 'preview',
			NEXT_PUBLIC_APP_URL: 'https://manawg.com',
			S3_PUBLIC_URL: 'https://legacy-bucket.s3.eu-central-1.amazonaws.com',
			S3_BUCKET: 'legacy-bucket',
			AWS_REGION: 'eu-central-1',
			IMAGE_STORAGE_PROVIDER: undefined,
		});
	});

	after(() => {
		for (const [key, value] of originalEnv) setEnv({ [key]: value });
	});

	test('parses only the exact WG-scoped private key grammar', () => {
		assert.deepEqual(parsePrivateImageKey(PRIVATE_KEY), { wgId: WG_A });
		assert.deepEqual(parsePrivateImageKey(`manawg/${WG_A}/announcement/${IMAGE_ID}.heif`), {
			wgId: WG_A,
		});
		assert.deepEqual(parsePrivateImageKey(`manawg/${WG_A}/chat/${IMAGE_ID}.jpg`), { wgId: WG_A });
		assert.equal(parsePrivateImageKey(`manawg/${WG_A}/expense/${IMAGE_ID}.jpg/extra`), null);
		assert.equal(parsePrivateImageKey(`manawg/${WG_A}/expense/../${IMAGE_ID}.jpg`), null);
		assert.equal(parsePrivateImageKey(`manawg/${WG_A}/other/${IMAGE_ID}.jpg`), null);
		assert.equal(parsePrivateImageKey(`manawg/${WG_A}/expense/${IMAGE_ID}.gif`), null);
	});

	test('uses the trusted Preview origin and enforces the destination WG', () => {
		const url = getPrivateImageUrl(PRIVATE_KEY);

		assert.equal(
			url,
			`https://preview.manawg.example/api/upload/read?key=${encodeURIComponent(PRIVATE_KEY)}`,
		);
		assert.equal(imageUrlSchema.safeParse(url).success, true);
		assert.equal(isAllowedImageUrlForWg(url, WG_A), true);
		assert.equal(isAllowedImageUrlForWg(url, WG_B), false);
		assert.equal(
			imageUrlSchema.safeParse(`https://preview.manawg.example/api/upload/read?key=${PRIVATE_KEY}`)
				.success,
			true,
		);
	});

	test('uses the stable configured origin outside Preview', () => {
		setEnv({ VERCEL_ENV: 'production', VERCEL_URL: 'preview.manawg.example' });

		assert.equal(
			getPrivateImageUrl(PRIVATE_KEY),
			`https://manawg.com/api/upload/read?key=${encodeURIComponent(PRIVATE_KEY)}`,
		);
	});

	test('rejects private read URLs with credentials', () => {
		const url = `https://user:pass@preview.manawg.example/api/upload/read?key=${encodeURIComponent(PRIVATE_KEY)}`;

		assert.equal(imageUrlSchema.safeParse(url).success, false);
		assert.equal(isAllowedImageUrlForWg(url, WG_A), false);
	});

	test('rejects public HTTP in production but permits explicit local development hosts', () => {
		setEnv({
			VERCEL_ENV: 'production',
			VERCEL_URL: 'preview.manawg.example',
			NEXT_PUBLIC_APP_URL: 'http://manawg.com',
		});

		assert.throws(() => getPrivateImageUrl(PRIVATE_KEY));
		assert.equal(
			imageUrlSchema.safeParse(
				`http://manawg.com/api/upload/read?key=${encodeURIComponent(PRIVATE_KEY)}`,
			).success,
			false,
		);

		for (const host of ['localhost', '127.0.0.1', '[::1]']) {
			setEnv({
				VERCEL_ENV: 'development',
				VERCEL_URL: undefined,
				NEXT_PUBLIC_APP_URL: `http://${host}:3000`,
			});
			const localUrl = getPrivateImageUrl(PRIVATE_KEY);

			assert.equal(
				localUrl,
				`http://${host}:3000/api/upload/read?key=${encodeURIComponent(PRIVATE_KEY)}`,
			);
			assert.equal(imageUrlSchema.safeParse(localUrl).success, true);
		}
	});

	test('rejects foreign origins, traversal, fragments, and extra query parameters', () => {
		const encodedKey = encodeURIComponent(PRIVATE_KEY);
		const invalidUrls = [
			`https://evil.example/api/upload/read?key=${encodedKey}`,
			`https://preview.manawg.example/api/upload/read/extra?key=${encodedKey}`,
			`https://preview.manawg.example/api/upload/../upload/read?key=${encodedKey}`,
			`https://preview.manawg.example/api/upload/read?key=${encodedKey}#fragment`,
			`https://preview.manawg.example/api/upload/read?key=${encodedKey}&extra=1`,
			`https://preview.manawg.example/api/upload/read?key=${encodedKey}&key=${encodedKey}`,
		];

		for (const url of invalidUrls) {
			assert.equal(imageUrlSchema.safeParse(url).success, false);
			assert.equal(isAllowedImageUrlForWg(url, WG_A), false);
		}
	});

	test('preserves the legacy AWS allowlist behavior', () => {
		assert.equal(
			imageUrlSchema.safeParse(
				'https://legacy-bucket.s3.eu-central-1.amazonaws.com/anything.jpg?cache=1',
			).success,
			true,
		);
		assert.equal(
			imageUrlSchema.safeParse('https://legacy-bucket.s3.amazonaws.com/anything.jpg').success,
			true,
		);
		assert.equal(
			imageUrlSchema.safeParse('https://other-bucket.s3.eu-central-1.amazonaws.com/x.jpg').success,
			false,
		);
	});

	test('reports explicit provider requirements without changing the AWS default', () => {
		const aws = checkEnv(baseEnv());
		assert.equal(
			aws.degraded.some((entry) => entry.feature === 'image-uploads'),
			false,
		);

		const supabase = checkEnv({
			...baseEnv(),
			IMAGE_STORAGE_PROVIDER: 'supabase',
			SUPABASE_SERVICE_ROLE_KEY: 'server-key',
			SUPABASE_STORAGE_BUCKET: 'private-images',
		});
		assert.equal(
			supabase.degraded.some((entry) => entry.feature === 'image-uploads'),
			false,
		);

		const maskedValues = checkEnv({
			...baseEnv(),
			IMAGE_STORAGE_PROVIDER: 'supabase',
			SUPABASE_SERVICE_ROLE_KEY: '********',
			SUPABASE_STORAGE_BUCKET: 'private-images',
		});
		assert.equal(
			maskedValues.degraded.some((entry) => entry.feature === 'image-uploads'),
			false,
		);

		const unknown = checkEnv({ ...baseEnv(), IMAGE_STORAGE_PROVIDER: 'unknown' });
		const unknownImage = unknown.degraded.find((entry) => entry.feature === 'image-uploads');
		assert.ok(unknownImage?.missing.includes('IMAGE_STORAGE_PROVIDER'));

		const invalidSupabase = checkEnv({
			...baseEnv(),
			IMAGE_STORAGE_PROVIDER: 'supabase',
			NEXT_PUBLIC_SUPABASE_URL: 'not-a-url',
			SUPABASE_STORAGE_BUCKET: '',
			SUPABASE_SERVICE_ROLE_KEY: '',
		});
		const invalidImage = invalidSupabase.degraded.find(
			(entry) => entry.feature === 'image-uploads',
		);
		for (const name of [
			'NEXT_PUBLIC_SUPABASE_URL',
			'SUPABASE_STORAGE_BUCKET',
			'SUPABASE_SERVICE_ROLE_KEY',
		]) {
			assert.ok(invalidImage?.missing.includes(name), name);
		}
	});

	test('makes the configured provider storage variables fatal in production', () => {
		const productionEnv = (): Record<string, string> => ({
			...baseEnv(),
			VERCEL_ENV: 'production',
			CRON_SECRET: 'cron-secret',
			UPSTASH_REDIS_REST_URL: 'https://redis.example',
			UPSTASH_REDIS_REST_TOKEN: 'upstash-token',
			SUPABASE_SERVICE_ROLE_KEY: 'server-key',
		});

		const complete = checkEnv(productionEnv());
		assert.equal(complete.ok, true);

		const missingRegion = checkEnv((({ AWS_REGION: _dropped, ...rest }) => rest)(productionEnv()));
		assert.equal(missingRegion.ok, false);
		assert.ok(missingRegion.missingRequired.includes('AWS_REGION'));
		// Production reports the missing variable as required instead of
		// downgrading it to a degraded feature.
		assert.equal(
			missingRegion.degraded.some((entry) => entry.feature === 'image-uploads'),
			false,
		);

		const supabase = checkEnv({
			...productionEnv(),
			IMAGE_STORAGE_PROVIDER: 'supabase',
			SUPABASE_SERVICE_ROLE_KEY: 'server-key',
			SUPABASE_STORAGE_BUCKET: '',
		});
		assert.equal(supabase.ok, false);
		assert.ok(supabase.missingRequired.includes('SUPABASE_STORAGE_BUCKET'));

		const withoutServiceRole = checkEnv(
			(({ SUPABASE_SERVICE_ROLE_KEY: _dropped, ...rest }) => rest)(productionEnv()),
		);
		assert.equal(withoutServiceRole.ok, false);
		assert.ok(withoutServiceRole.missingRequired.includes('SUPABASE_SERVICE_ROLE_KEY'));
	});
});

describe('private storage contract', () => {
	test('private image policy accepts only the exact size and MIME allowlist', () => {
		assert.equal(PRIVATE_IMAGE_MAX_BYTES, 8 * 1024 * 1024);
		for (const mimeType of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
			assert.equal(isAllowedPrivateImageMimeType(mimeType), true);
		}
		assert.equal(isAllowedPrivateImageMimeType('image/gif'), false);
		assert.equal(isValidPrivateImageSize(PRIVATE_IMAGE_MAX_BYTES), true);
		assert.equal(isValidPrivateImageSize(PRIVATE_IMAGE_MAX_BYTES + 1), false);
		assert.equal(isValidPrivateImageSize(0), false);
	});

	test('private keys reject traversal and preserve WG scoping', () => {
		assert.equal(parsePrivateImageKey('../outside.png'), null);
		assert.equal(parsePrivateImageKey('manawg/not-a-uuid/expense/image.png'), null);
	});
});
