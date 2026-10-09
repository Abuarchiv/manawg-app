import { randomUUID } from 'node:crypto';
import { getAuthenticatedUser } from '@/core/auth/server';
import { db } from '@/core/db';
import { requireMember } from '@/core/guards/api-auth';
import {
	badRequest,
	notFound,
	serverError,
	serviceUnavailable,
	tooMany,
	unauthorized,
} from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
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
import { isValidShareCode, normalizeShareCode } from '@/core/utils/share-code';
import { getPrivateImageUrl } from '@/core/validators/image-url';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const ALLOWED_PURPOSES = ['expense', 'announcement', 'chat'] as const;
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
	const parsed = await parseBody(req, signSchema, {
		maxBytes: MAX_SIGN_BODY_BYTES,
		fieldErrors: {
			shareCode: 'invalid_share_code',
			purpose: 'invalid_purpose',
			mimeType: 'invalid_mime_type',
			fileSize: 'file_too_large',
		},
	});
	if (!parsed.ok) return noStore(parsed.response);

	const { shareCode: code, purpose, mimeType, fileSize } = parsed.data;
	if (!isValidShareCode(code)) return noStore(badRequest('invalid_share_code'));
	if (!isAllowedMimeType(mimeType)) return noStore(badRequest('invalid_mime_type'));

	let authenticatedUser: Awaited<ReturnType<typeof getAuthenticatedUser>>;
	try {
		authenticatedUser = await getAuthenticatedUser(req);
	} catch (err) {
		// A transient Auth outage is retryable, not an unauthenticated caller.
		logApiError('[upload sign] auth error', err);
		return noStore(serviceUnavailable('db_error'));
	}
	if (!authenticatedUser) return noStore(unauthorized('auth_required', 'auth_required'));

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
