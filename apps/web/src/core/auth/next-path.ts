export function safeNextPath(value: string | null): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
		return '/';
	}

	try {
		const url = new URL(value, 'https://manawg.invalid');
		if (url.origin !== 'https://manawg.invalid') return '/';
		const path = `${url.pathname}${url.search}${url.hash}`;
		// Dot-segments normalize to a protocol-relative path ("/.//evil.com" →
		// "//evil.com"), which a browser resolves to another host. Re-check the
		// normalized result, not only the raw input.
		if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/';
		return path;
	} catch {
		return '/';
	}
}
