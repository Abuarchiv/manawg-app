// manawg app service worker — installability + minimal offline shell
//
// Registered at runtime by the pwa-register component (src/shared/components).
// Nothing
// imports this file, so dead-code tooling reports it as unused — it is not.
// Deleting it breaks installability and the offline shell with no build error.
//
// Navigations are network-first so a deploy is picked up on the next load and
// a stale shell can never pin users to an old build; the cache only serves as
// the offline fallback. /api is bypassed entirely — WG data must never be
// served from cache, and the app has its own offline queue for writes.
//
// Bump VERSION to evict every cached shell asset on the next activate.
const VERSION = 'manawg-app-v4-offline-assets';
const SHELL_CACHE = `${VERSION}-shell`;
const PUBLIC_DOCUMENT_PATHS = new Set(['/', '/offline']);

const SHELL_ASSETS = [
	'/',
	'/offline',
	'/icon-192.png',
	'/icon-512.png',
	'/apple-touch-icon.png',
	'/manifest.json',
];

const cacheResponse = (request, response) => {
	if (response.ok === false) return;
	caches
		.open(SHELL_CACHE)
		.then((cache) => cache.put(request, response))
		.catch(() => undefined);
};

const matchFromCache = (request) => caches.match(request).catch(() => undefined);

const getOfflineShellAssets = async (cache) => {
	const page = await cache.match('/offline');
	if (!page) throw new Error('offline page was not precached');

	const assets = new Set();
	for (const [, , reference] of (await page.text()).matchAll(
		/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi,
	)) {
		let asset;
		try {
			asset = new URL(reference, self.location.origin);
		} catch {
			continue;
		}
		if (
			asset.origin !== self.location.origin ||
			asset.username ||
			asset.password ||
			!asset.pathname.startsWith('/_next/static/') ||
			!asset.pathname.match(/\.(?:js|css)$/i)
		) {
			continue;
		}
		asset.hash = '';
		assets.add(asset.href);
	}
	if (assets.size === 0)
		throw new Error('offline page has no same-origin Next.js scripts or styles');
	return [...assets];
};

const fallbackPushData = {
	body: 'Benachrichtigung konnte nicht gelesen werden.',
	title: 'ManaWG',
	url: '/',
};

const isCompletePushData = (data) =>
	data !== null &&
	typeof data === 'object' &&
	!Array.isArray(data) &&
	typeof data.body === 'string' &&
	data.body.length > 0 &&
	typeof data.title === 'string' &&
	data.title.length > 0 &&
	typeof data.url === 'string' &&
	data.url.length > 0;

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(SHELL_CACHE)
			.then(async (cache) => {
				await cache.addAll(SHELL_ASSETS);
				await cache.addAll(await getOfflineShellAssets(cache));
			})
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((k) => k.startsWith('manawg-app-') && k !== SHELL_CACHE)
						.map((k) => caches.delete(k)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

// --- Web Push ---

self.addEventListener('push', (event) => {
	if (!event.data) return;
	let data;
	try {
		data = event.data.json();
	} catch {
		data = fallbackPushData;
	}
	if (!isCompletePushData(data)) {
		data = fallbackPushData;
	}
	const notificationOptions = {
		body: data.body,
		icon: typeof data.icon === 'string' && data.icon.length > 0 ? data.icon : '/icon-192.png',
		badge: '/icon-192.png',
		data: { url: data.url },
	};
	if (typeof data.tag === 'string' && data.tag.length > 0) {
		notificationOptions.tag = data.tag;
		notificationOptions.renotify = true;
	}
	event.waitUntil(self.registration.showNotification(data.title || 'ManaWG', notificationOptions));
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = event.notification.data?.url || '/';
	event.waitUntil(
		clients.matchAll({ type: 'window' }).then(async (wins) => {
			let targetUrl = null;
			try {
				targetUrl = new URL(url, self.location.origin);
			} catch {
				targetUrl = null;
			}
			const isSameOriginTarget = targetUrl?.origin === self.location.origin;
			for (const w of wins) {
				let windowUrl;
				try {
					windowUrl = new URL(w.url);
				} catch {
					continue;
				}
				if (
					isSameOriginTarget &&
					windowUrl.origin === self.location.origin &&
					w.url === targetUrl.href &&
					typeof w.focus === 'function'
				) {
					try {
						return await w.focus();
					} catch {
						// The tab may close before it can be focused.
					}
				}
			}
			for (const w of wins) {
				let windowUrl;
				try {
					windowUrl = new URL(w.url);
				} catch {
					continue;
				}
				if (
					isSameOriginTarget &&
					windowUrl.origin === self.location.origin &&
					windowUrl.pathname === targetUrl.pathname &&
					w.url !== targetUrl.href &&
					typeof w.navigate === 'function'
				) {
					try {
						const navigated = await w.navigate(targetUrl.href);
						if (navigated && typeof navigated.focus === 'function') {
							return await navigated.focus();
						}
					} catch {
						// Fall back to a new window if navigation fails or the tab closes.
					}
				}
			}
			return clients.openWindow(isSameOriginTarget ? targetUrl.href : '/');
		}),
	);
});

// --- Fetch ---

self.addEventListener('fetch', (event) => {
	const { request } = event;

	// Bypass for non-GET, cross-origin, API, auth, supabase calls
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith('/api') || url.pathname.startsWith('/auth')) return;
	if (url.pathname.includes('/_next/data')) return;

	// Network-first for HTML navigations (always serve fresh app shell when online)
	if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
		event.respondWith(
			fetch(request)
				.then((res) => {
					if (PUBLIC_DOCUMENT_PATHS.has(url.pathname)) cacheResponse(request, res.clone());
					return res;
				})
				.catch(() =>
					matchFromCache(request).then(
						(cached) =>
							cached || matchFromCache('/offline').then((off) => off || matchFromCache('/')),
					),
				),
		);
		return;
	}

	// Cache-first for static assets (icons, images, fonts)
	if (
		url.pathname.match(/\.(png|jpg|jpeg|svg|ico|woff2?|webp|avif)$/i) ||
		url.pathname.startsWith('/_next/static')
	) {
		event.respondWith(
			matchFromCache(request).then((cached) => {
				if (cached) return cached;
				return fetch(request).then((res) => {
					const copy = res.clone();
					cacheResponse(request, copy);
					return res;
				});
			}),
		);
	}
});
