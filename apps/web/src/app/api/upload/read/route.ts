import { getAuthenticatedUser } from '@/core/auth/server';
import { apiError, authUnavailable, badRequest, notFound, serverError } from '@/core/errors';
import { requireMember } from '@/core/guards/api-auth';
import { logApiError } from '@/core/infra/observability';
import {
	ImageStorageConfigurationError,
	ImageStorageObjectNotFoundError,
	downloadSupabaseImage,
} from '@/core/infra/supabase-storage';
import { parsePrivateImageKey } from '@/core/validators/image-url';
import { type NextRequest, NextResponse } from 'next/server';

function noStore<T extends NextResponse>(response: T): T {
	response.headers.set('Cache-Control', 'no-store');
	return response;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
	const key = req.nextUrl.searchParams.get('key');
	const privateImage = key ? parsePrivateImageKey(key) : null;
	if (!key || !privateImage) return noStore(badRequest('invalid_image_key'));

	// A transient Auth failure must not escape the handler as a bare 500: map it
	// to the structured 503 the WG guards return for the same condition.
	let authenticatedUser: Awaited<ReturnType<typeof getAuthenticatedUser>>;
	try {
		authenticatedUser = await getAuthenticatedUser(req);
	} catch (err) {
		logApiError('[api/upload/read] auth lookup failed', err);
		return noStore(authUnavailable());
	}
	if (!authenticatedUser) return noStore(apiError('auth_required', 401, 'auth_required'));

	const auth = await requireMember(req, privateImage.wgId, authenticatedUser);
	if (!auth.ok) return noStore(auth.response);

	try {
		const image = await downloadSupabaseImage(key);
		const headers = new Headers({
			'Cache-Control': 'private, no-store',
			'Content-Type': image.contentType,
			'X-Content-Type-Options': 'nosniff',
		});
		if (image.contentLength > 0) {
			headers.set('Content-Length', String(image.contentLength));
		}
		return new NextResponse(image.stream, { headers });
	} catch (error) {
		if (error instanceof ImageStorageObjectNotFoundError) {
			return noStore(notFound('image_not_found'));
		}
		if (error instanceof ImageStorageConfigurationError) {
			return noStore(
				NextResponse.json(
					{ error: 'feature_disabled', code: 'image_reads_unavailable' },
					{ status: 503 },
				),
			);
		}
		return noStore(serverError('image_read_failed'));
	}
}
