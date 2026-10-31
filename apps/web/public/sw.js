// manawg app service worker — installability + minimal offline shell
//
// Registered at runtime by src/components/app/PwaRegister.tsx. Nothing
// imports this file, so dead-code tooling reports it as unused — it is not.
// Deleting it breaks installability and the offline shell with no build error.
//
// Navigations are network-first so a deploy is picked up on the next load and
// a stale shell can never pin users to an old build; the cache only serves as
// the offline fallback. /api is bypassed entirely — WG data must never be
// served from cache, and the app has its own offline queue for writes.
//
// Bump VERSION to evict every cached shell asset on the next activate.
const VERSION = 'manawg-app-v9-english-sweep';
const SHELL_CACHE = `${VERSION}-shell`;
// Hashed /_next/static chunks fetched while browsing. sw.js itself does not
// change between deploys, so nothing would ever evict them; the cap keeps the
// cache from growing with every release. The offline shell's own chunks live in
// SHELL_CACHE and are not subject to it.
const RUNTIME_CACHE = `${VERSION}-runtime`;
const MAX_RUNTIME_ENTRIES = 200;
const PUBLIC_DOCUMENT_PATHS = new Set(['/', '/offline']);
// A navigation whose headers the network has not delivered by then falls back to the cache, so a bad
// connection shows the offline page instead of a page that never finishes loading.
const NAVIGATION_TIMEOUT_MS = 15000;

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

// Cache keys keep insertion order, so the oldest entries go first.
const cacheRuntimeAsset = (request, response) => {
	if (response.ok === false) return;
	caches
		.open(RUNTIME_CACHE)
		.then(async (cache) => {
			await cache.put(request, response);
			const keys = await cache.keys();
			const excess = keys.length - MAX_RUNTIME_ENTRIES;
			if (excess > 0) await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
		})
		.catch(() => undefined);
};

const matchFromCache = (request) => caches.match(request).catch(() => undefined);

const getOfflineShellAssets = async (cache) => {
	const page = await cache.match('/offline');
	if (!page) throw new Error('offline page was not precached');
	return offlineShellAssetsOf(await page.text());
};

const offlineShellAssetsOf = (html) => {
	const assets = new Set();
	for (const [, , reference] of html.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
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

const precacheShell = async () => {
	const cache = await caches.open(SHELL_CACHE);
	await cache.addAll(SHELL_ASSETS);
	await cache.addAll(await getOfflineShellAssets(cache));
};

// A newer /offline page references newer chunks. Store those first, so the page that
// replaces the old one never points at assets the cache does not hold.
const refreshOfflinePage = async (request, response) => {
	const cache = await caches.open(SHELL_CACHE);
	await cache.addAll(offlineShellAssetsOf(await response.clone().text()));
	await cache.put(request, response);
};

// The timer covers only the wait for the response headers. Once they are here the response goes
// to the browser untouched, so the body keeps streaming (slow server starts are not cut off).
const fetchWithTimeout = async (request) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
	try {
		return await fetch(request, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
};

// The worker has no catalog, so the one fallback sentence follows the browser language.
const fallbackPushData = () => ({
	body: self.navigator.language.toLowerCase().startsWith('en')
		? 'The notification could not be read.'
		: 'Benachrichtigung konnte nicht gelesen werden.',
	title: 'ManaWG',
	url: '/',
});

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
	// Static routing (Safari 27 / Chrome 123): API and auth calls go straight to
	// the network without waking the worker. Mirrors the fetch handler's bypass.
	if (typeof event.addRoutes === 'function') {
		try {
			event.addRoutes([
				{ condition: { urlPattern: { pathname: '/api/*' } }, source: 'network' },
				{ condition: { urlPattern: { pathname: '/auth/*' } }, source: 'network' },
			]);
		} catch {
			// Unsupported pattern syntax — the fetch handler still bypasses these.
		}
	}
	event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

// Asked by the page after sign-out, which deletes every cache: the offline page must exist
// again before the connection drops.
self.addEventListener('message', (event) => {
	if (event.data === 'refresh-shell') event.waitUntil(precacheShell().catch(() => undefined));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((k) => k.startsWith('manawg-app-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
						.map((k) => caches.delete(k)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

// --- Web Push ---

self.addEventListener('push', (event) => {
	// Safari revokes subscriptions that receive a push without showing a
	// notification, so an empty payload still shows the fallback.
	let data;
	try {
		data = event.data.json();
	} catch {
		data = fallbackPushData();
	}
	if (!isCompletePushData(data)) {
		data = fallbackPushData();
	}
	const notificationOptions = {
		body: data.body,
		icon: typeof data.icon === 'string' && data.icon.length > 0 ? data.icon : '/icon-192.png',
		badge: '/badge-96.png',
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

	// Network-first for HTML navigations (always serve fresh app shell when online)
	if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
		event.respondWith(
			fetchWithTimeout(request)
				.then((res) => {
					if (url.pathname === '/offline' && res.ok) {
						refreshOfflinePage(request, res.clone()).catch(() => undefined);
					} else if (PUBLIC_DOCUMENT_PATHS.has(url.pathname)) {
						cacheResponse(request, res.clone());
					}
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
					cacheRuntimeAsset(request, res.clone());
					return res;
				});
			}),
		);
	}
});
