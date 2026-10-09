import { z } from 'zod';

const URL_MAX = 2048;
const PRIVATE_IMAGE_PATH = '/api/upload/read';
const LOCAL_DEVELOPMENT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PRIVATE_IMAGE_KEY_PATTERN =
	/^manawg\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/(?:expense|announcement|chat)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.(?:jpg|png|webp|heic|heif)$/;

interface PrivateImageKey {
	wgId: string;
}

function cleanEnvValue(value: string | undefined): string | null {
	const trimmed = value?.trim().replace(/^['"]|['"]$/g, '');
	return trimmed ? trimmed : null;
}

function trustedOrigin(value: string, variableName: string): string {
	const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
	const parsed = new URL(candidate);
	if (parsed.username || parsed.password) {
		throw new Error(`${variableName} must not contain credentials`);
	}
	const isLocalDevelopmentHttp =
		parsed.protocol === 'http:' &&
		LOCAL_DEVELOPMENT_HOSTS.has(parsed.hostname.toLowerCase()) &&
		process.env.VERCEL_ENV !== 'production';
	if (parsed.protocol !== 'https:' && !isLocalDevelopmentHttp) {
		throw new Error(`${variableName} must be an absolute HTTP(S) origin`);
	}
	return parsed.origin;
}

function getTrustedAppOrigin(): string {
	const vercelUrl = cleanEnvValue(process.env.VERCEL_URL);
	if (vercelUrl && process.env.VERCEL_ENV !== 'production') {
		return trustedOrigin(vercelUrl, 'VERCEL_URL');
	}

	const configuredOrigin =
		cleanEnvValue(process.env.NEXT_PUBLIC_APP_URL) ??
		cleanEnvValue(process.env.VERCEL_PROJECT_PRODUCTION_URL);
	if (!configuredOrigin) throw new Error('NEXT_PUBLIC_APP_URL is required for private image URLs');
	return trustedOrigin(configuredOrigin, 'NEXT_PUBLIC_APP_URL');
}

export function parsePrivateImageKey(key: string): PrivateImageKey | null {
	if (typeof key !== 'string') return null;
	const match = PRIVATE_IMAGE_KEY_PATTERN.exec(key);
	return match?.[1] ? { wgId: match[1] } : null;
}

export function getPrivateImageUrl(key: string): string {
	if (!parsePrivateImageKey(key)) throw new Error('invalid_private_image_key');
	return `${getTrustedAppOrigin()}${PRIVATE_IMAGE_PATH}?key=${encodeURIComponent(key)}`;
}

function rawUrlPath(value: string): string | null {
	const schemeEnd = value.indexOf('://');
	if (schemeEnd < 0) return null;
	const pathStart = value.indexOf('/', schemeEnd + 3);
	if (pathStart < 0) return '/';
	const queryStart = value.slice(pathStart).search(/[?#]/);
	return value.slice(pathStart, queryStart < 0 ? value.length : pathStart + queryStart);
}

function hasPathTraversal(value: string): boolean {
	const path = rawUrlPath(value);
	if (path === null || path.includes('\\')) return true;
	try {
		return decodeURIComponent(path)
			.split('/')
			.some((part) => part === '.' || part === '..');
	} catch {
		return true;
	}
}

function parsePrivateImageUrl(
	value: string,
	requireCurrentOrigin = true,
): (PrivateImageKey & { key: string }) | null {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.username || parsed.password) return null;
	const isLocalDevelopmentHttp =
		parsed.protocol === 'http:' &&
		LOCAL_DEVELOPMENT_HOSTS.has(parsed.hostname.toLowerCase()) &&
		process.env.VERCEL_ENV !== 'production';
	if (parsed.protocol !== 'https:' && !isLocalDevelopmentHttp) return null;
	if (requireCurrentOrigin) {
		let appOrigin: string;
		try {
			appOrigin = getTrustedAppOrigin();
		} catch {
			return null;
		}
		if (parsed.origin !== appOrigin) return null;
	}
	if (parsed.pathname !== PRIVATE_IMAGE_PATH || parsed.hash || hasPathTraversal(value)) return null;
	if (parsed.searchParams.size !== 1 || !parsed.searchParams.has('key')) return null;

	const key = parsed.searchParams.get('key');
	if (!key) return null;
	const privateImage = parsePrivateImageKey(key);
	return privateImage ? { ...privateImage, key } : null;
}

export function getPrivateImageKeyFromStoredUrl(
	value: string | null | undefined,
	expectedWgId?: string,
): (PrivateImageKey & { key: string }) | null {
	if (!value || value.length > URL_MAX) return null;
	const privateImage = parsePrivateImageUrl(value, false);
	if (
		!privateImage ||
		(expectedWgId !== undefined && privateImage.wgId.toLowerCase() !== expectedWgId.toLowerCase())
	) {
		return null;
	}
	return privateImage;
}

function getAllowedHosts(): string[] {
	const hosts = new Set<string>();
	const publicUrl = process.env.S3_PUBLIC_URL;
	if (publicUrl) {
		try {
			hosts.add(new URL(publicUrl).host);
		} catch {
			// ignore malformed env
		}
	}
	const bucket = process.env.S3_BUCKET;
	const region = process.env.AWS_REGION;
	if (bucket && region) {
		hosts.add(`${bucket}.s3.${region}.amazonaws.com`);
		hosts.add(`${bucket}.s3.amazonaws.com`);
	}
	return [...hosts];
}

function isAllowedImageHost(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'https:') return false;
	const allowed = getAllowedHosts();
	if (allowed.length === 0) {
		return false;
	}
	return allowed.includes(parsed.host);
}

export function isAllowedImageUrlForWg(url: string | null | undefined, wgId: string): boolean {
	if (!url) return true;
	if (isAllowedImageHost(url)) return true;
	const privateImage = parsePrivateImageUrl(url);
	return privateImage !== null && privateImage.wgId.toLowerCase() === wgId.toLowerCase();
}

/**
 * Zod schema for user-supplied image URLs stored in expenses, announcements and chat messages.
 *
 * Empty string is treated as "no image" (legacy clients send '' instead of null).
 * Non-empty strings must be https:// and point at our S3 bucket — blocks
 * `javascript:`, `data:`, and attacker-controlled hosts that the CSP `img-src`
 * already restricts but which we never want to persist.
 */
export const imageUrlSchema = z
	.string()
	.max(URL_MAX)
	.refine((v) => v.length === 0 || isAllowedImageHost(v) || parsePrivateImageUrl(v) !== null, {
		message: 'image_url_not_allowed',
	})
	.optional()
	.nullable();
