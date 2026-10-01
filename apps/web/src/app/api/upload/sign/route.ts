import { randomUUID } from 'node:crypto';
import { getAuthenticatedUser } from '@/core/auth/server';
import { db } from '@/core/db';
import {
	apiError,
	authUnavailable,
	badRequest,
	notFound,
	payloadTooLarge,
	serverError,
	tooMany,
} from '@/core/errors';
import { requireMember } from '@/core/guards/api-auth';
import { readJsonBody } from '@/core/http/read-json';
import { logApiError } from '@/core/infra/observability';
import { PRIVATE_IMAGE_MIME_TYPES } from '@/core/infra/private-image-policy';
import {
	S3ConfigurationError,
	S3_MAX_UPLOAD_BYTES,
	createPresignedUpload,
	isAllowedMimeType,
} from '@/core/infra/s3';
import {
	ImageStorageConfigurationError,
	createSupabaseSignedUpload,
	getImageStorageProvider,
} from '@/core/infra/supabase-storage';
import { checkRateLimit, uploadSignLimiter } from '@/core/rate-limit';
import { getPrivateImageUrl } from '@/core/validators/image-url';
import { isValidShareCode, normalizeShareCode } from '@/shared/lib/share-code';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const ALLOWED_PURPOSES = ['expense', 'announcement'] as const;
const MAX_SIGN_BODY_BYTES = 16 * 1024;

const signSchema = z.object({
	shareCode: z.string().transform((v) => normalizeShareCode(v)),
	purpose: z.enum(ALLOWED_PURPOSES),
	mimeType: z.enum(PRIVATE_IMAGE_MIME_TYPES),
	fileSize: z.number().int().positive().max(S3_MAX_UPLOAD_BYTES),
});

function noStore<T extends NextResponse>(response: T): T {
	response.headers.set('Cache-Control', 'no-store');
	return response;
}

function extFromMime(mime: string): string {
	const map: Record<string, string> = {
		'image/jpeg': 'jpg',
		'image/png': 'png',
		'image/webp': 'webp',
		'image/heic': 'heic',
		'image/heif': 'heif',
	};
	return map[mime] ?? 'jpg';
}

export async function POST(req: NextRequest): Promise<NextResponse> {
	const rawResult = await readJsonBody(req, MAX_SIGN_BODY_BYTES);
	if (!rawResult.ok) {
		return noStore(
			rawResult.reason === 'payload_too_large' ? payloadTooLarge() : badRequest('invalid_json'),
		);
	}

	const parsed = signSchema.safeParse(rawResult.body);
	if (!parsed.success) {
		const issues = parsed.error.flatten();
		if (issues.fieldErrors.shareCode) return noStore(badRequest('invalid_share_code'));
		if (issues.fieldErrors.purpose) return noStore(badRequest('invalid_purpose'));
		if (issues.fieldErrors.mimeType) return noStore(badRequest('invalid_mime_type'));
		if (issues.fieldErrors.fileSize) return noStore(badRequest('file_too_large'));
		return noStore(badRequest('invalid_body'));
	}

	const { shareCode: code, purpose, mimeType, fileSize } = parsed.data;
	if (!isValidShareCode(code)) return noStore(badRequest('invalid_share_code'));
	if (!isAllowedMimeType(mimeType)) return noStore(badRequest('invalid_mime_type'));

	// A transient Auth failure must not escape the handler as a bare 500: map it
	// to the structured 503 the WG guards return for the same condition.
	let authenticatedUser: Awaited<ReturnType<typeof getAuthenticatedUser>>;
	try {
		authenticatedUser = await getAuthenticatedUser(req);
	} catch (err) {
		logApiError('[api/upload/sign] auth lookup failed', err);
		return noStore(authUnavailable());
	}
	if (!authenticatedUser) return noStore(apiError('auth_required', 401, 'auth_required'));

	const wg = await db.query.wgs.findFirst({
		where: (w, { eq }) => eq(w.shareCode, code),
		columns: { id: true },
	});
	if (!wg) return noStore(notFound('wg_not_found'));

	const auth = await requireMember(req, wg.id, authenticatedUser);
	if (!auth.ok) {
		return noStore(auth.response.status === 401 ? notFound('wg_not_found') : auth.response);
	}

	const limited = await checkRateLimit(uploadSignLimiter, `${wg.id}:${auth.member.memberId}`);
	if (!limited.success) {
		if (limited.limiterUnavailable) {
			const retryAfterMs = Math.max(0, limited.reset - Date.now());
			return noStore(
				NextResponse.json(
					{ error: 'rate_limiter_unavailable', retryAfterMs },
					{
						status: 503,
						headers: { 'Retry-After': Math.max(1, Math.ceil(retryAfterMs / 1000)).toString() },
					},
				),
			);
		}
		return noStore(tooMany('upload_sign_rate_limited', 'upload_sign_rate_limited'));
	}

	try {
		const ext = extFromMime(mimeType);
		const key = `manawg/${wg.id}/${purpose}/${randomUUID()}.${ext}`;
		const provider = getImageStorageProvider();
		const signature =
			provider === 'supabase'
				? {
						...(await createSupabaseSignedUpload(key, mimeType)),
						publicUrl: getPrivateImageUrl(key),
					}
				: await createPresignedUpload(key, mimeType, fileSize);
		return noStore(NextResponse.json(signature));
	} catch (err) {
		if (err instanceof ImageStorageConfigurationError || err instanceof S3ConfigurationError) {
			return noStore(
				NextResponse.json(
					{ error: 'feature_disabled', code: 'image_uploads_unavailable' },
					{ status: 503 },
				),
			);
		}
		return noStore(serverError('sign_failed'));
	}
}
