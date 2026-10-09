const MAX_EDGE = 2048;
const RESIZE_ABOVE_BYTES = 1.5 * 1024 * 1024;
const HEIC_TYPES = new Set(['image/heic', 'image/heif']);

export const HEIC_UNSUPPORTED_MESSAGE =
	'Dieses Gerät kann HEIC nicht umwandeln. Bitte wähle ein JPG.';

/** Scales down so the longer edge is at most `maxEdge`; never scales up. */
export function fitWithin(
	width: number,
	height: number,
	maxEdge: number = MAX_EDGE,
): { width: number; height: number } {
	const scale = Math.min(1, maxEdge / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * Re-encodes big photos and HEIC/HEIF as JPEG (max. 2048 px) before the upload: HEIC does not
 * display outside Apple browsers, and 48 MP photos exceed the size limit. Small JPG/PNG/WebP stay
 * untouched. A HEIC the browser cannot decode throws instead of uploading an undisplayable file.
 */
export async function prepareUploadImage(file: File): Promise<File> {
	const heic = HEIC_TYPES.has(file.type);
	try {
		if (typeof createImageBitmap !== 'function') throw new Error('no-createImageBitmap');
		const bitmap = await createImageBitmap(file);
		const { width, height } = fitWithin(bitmap.width, bitmap.height);
		const resized = width !== bitmap.width || height !== bitmap.height;
		if (!heic && !resized && file.size <= RESIZE_ABOVE_BYTES) {
			bitmap.close();
			return file;
		}
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('no-canvas-context');
		// JPEG has no alpha; transparent PNG areas would turn black.
		context.fillStyle = '#fff';
		context.fillRect(0, 0, width, height);
		context.drawImage(bitmap, 0, 0, width, height);
		bitmap.close();
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/jpeg', 0.85),
		);
		if (!blob) throw new Error('encode-failed');
		// A re-encode that does not shrink a file we only touched for size is not worth it.
		if (!heic && !resized && blob.size >= file.size) return file;
		return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'foto'}.jpg`, {
			type: 'image/jpeg',
		});
	} catch {
		if (heic) throw new Error(HEIC_UNSUPPORTED_MESSAGE);
		return file;
	}
}
