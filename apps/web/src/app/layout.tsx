import { InstallPrompt } from '@/components/app/InstallPrompt';
import { PwaRegister } from '@/components/app/PwaRegister';
import { ThemeProvider } from '@/components/app/ThemeProvider';
import { getAppUrl } from '@/shared/lib/app-url';
import { THEME_BOOTSTRAP_SCRIPT } from '@/shared/lib/theme';
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { headers } from 'next/headers';
import Script from 'next/script';
import '@/shared/globals.css';

export const dynamic = 'force-dynamic';

const inter = localFont({
	src: '../shared/fonts/inter-latin.woff2',
	weight: '100 900',
	variable: '--font-inter',
	display: 'swap',
});

const interTight = localFont({
	src: '../shared/fonts/inter-tight-latin.woff2',
	weight: '100 900',
	variable: '--font-inter-tight',
	display: 'swap',
});

const jetbrainsMono = localFont({
	src: '../shared/fonts/jetbrains-mono-latin.woff2',
	weight: '100 800',
	variable: '--font-jetbrains-mono',
	display: 'swap',
});

const appUrl = getAppUrl();

const metaDescription =
	'Die WG-App für Ausgaben, Putzplan, Einkauf und Pinnwand. In Deutschland gehostet.';

const organizationSchema = {
	'@context': 'https://schema.org',
	'@type': 'Organization',
	name: 'ManaWG',
	url: appUrl,
	logo: `${appUrl}/icon-512.png`,
	description: metaDescription,
};

const softwareApplicationSchema = {
	'@context': 'https://schema.org',
	'@type': 'SoftwareApplication',
	name: 'ManaWG',
	description: metaDescription,
	url: appUrl,
	applicationCategory: 'LifestyleApplication',
	operatingSystem: 'Web, iOS, Android',
	offers: {
		'@type': 'Offer',
		price: '0',
		priceCurrency: 'EUR',
	},
};

export const metadata: Metadata = {
	metadataBase: new URL(appUrl),
	title: 'ManaWG — Deine WG-App',
	description: metaDescription,
	keywords: ['WG', 'Wohngemeinschaft', 'Ausgaben teilen', 'Putzplan', 'WG App', 'DSGVO'],
	authors: [{ name: 'ManaWG' }],
	applicationName: 'ManaWG',
	robots: {
		index: true,
		follow: true,
	},
	openGraph: {
		title: 'ManaWG — Deine WG-App',
		description: metaDescription,
		type: 'website',
		locale: 'de_DE',
		siteName: 'ManaWG',
		images: [
			{
				url: '/opengraph-image',
				width: 1200,
				height: 630,
				alt: 'ManaWG',
			},
		],
	},
	twitter: {
		card: 'summary_large_image',
		title: 'ManaWG — Deine WG-App',
		description: metaDescription,
		images: ['/opengraph-image'],
	},
	manifest: '/manifest.json',
	icons: {
		icon: [
			{ url: '/favicon.svg', type: 'image/svg+xml' },
			{ url: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
			{ url: '/favicon-16.png', type: 'image/png', sizes: '16x16' },
			{ url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
			{ url: '/icon-512.png', type: 'image/png', sizes: '512x512' },
		],
		apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
	},
	appleWebApp: {
		capable: true,
		// Opaque bar, not black-translucent: translucent lets light-mode content
		// show through and washes out the white status-bar icons.
		statusBarStyle: 'black',
		title: 'ManaWG',
	},
	formatDetection: {
		telephone: false,
	},
};

export const viewport: Viewport = {
	width: 'device-width',
	initialScale: 1,
	viewportFit: 'cover',
	// Keep fixed bottom chrome (chat composer, bottom nav) above the Android
	// keyboard by resizing the whole layout, matching iOS keyboard behavior.
	// Default 'resizes-visual' would let the keyboard overlay them.
	interactiveWidget: 'resizes-content',
	// The app icon and system chrome use the brand's Neutral 950.
	themeColor: [
		{ media: '(prefers-color-scheme: light)', color: '#0a0a0a' },
		{ media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
	],
};

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	// The CSP only allows scripts with the per-request nonce from the middleware.
	const nonce = (await headers()).get('x-nonce') ?? undefined;
	return (
		<html
			lang="de"
			suppressHydrationWarning
			className={`${inter.variable} ${interTight.variable} ${jetbrainsMono.variable}`}
		>
			<head>
				<meta name="apple-mobile-web-app-capable" content="yes" />
				<meta name="mobile-web-app-capable" content="yes" />
				<meta name="apple-mobile-web-app-status-bar-style" content="black" />
				<meta name="apple-mobile-web-app-title" content="ManaWG" />
				<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
				{/* Catch the beforeinstallprompt event very early, before React mounts.
				    The browser fires it only once; without this catcher, components
				    that mount late lose it entirely. */}
				<Script id="manawg-install-ready" strategy="beforeInteractive">
					{`(function(){if(typeof window==='undefined')return;window.__manawgDeferredInstallEvent=null;window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__manawgDeferredInstallEvent=e;window.dispatchEvent(new CustomEvent('manawg:install-ready'));});})();`}
				</Script>
				{/* Anti-flicker theme bootstrap. A plain inline script in <head> runs before first paint;
            next/script beforeInteractive only queues it until the runtime chunks have loaded, so
            slow networks showed a white page on dark devices. The browser hides the nonce attribute
            from the client, hence suppressHydrationWarning. */}
				<script
					nonce={nonce}
					suppressHydrationWarning
					// biome-ignore lint/security/noDangerouslySetInnerHtml: static constant, no dynamic data
					dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
				/>
				{/* Organization + SoftwareApplication JSON-LD for rich results. Content is static JSON.stringify of trusted constants — no XSS surface. */}
				<Script
					id="manawg-org-schema"
					type="application/ld+json"
				>{`${JSON.stringify(organizationSchema)}`}</Script>
				<Script
					id="manawg-software-schema"
					type="application/ld+json"
				>{`${JSON.stringify(softwareApplicationSchema)}`}</Script>
			</head>
			<body suppressHydrationWarning>
				{/* WCAG 2.4.1 Bypass Blocks — keyboard-only skip link.
				    Targets the <main id="main"> rendered by per-route layouts. */}
				<a href="#main" className="skip-link">
					Zum Hauptinhalt springen
				</a>
				<ThemeProvider>
					{/* Phone column on every screen; wider viewports show backdrop
					    and a hairline edge around it. */}
					<div
						data-app-frame
						className="relative mx-auto min-h-svh w-full max-w-[var(--app-frame-width)] overflow-x-clip bg-background min-[30rem]:border-x"
						style={{ paddingBottom: 'var(--install-prompt-space, 0px)' }}
					>
						{children}
						<PwaRegister />
						<InstallPrompt />
					</div>
				</ThemeProvider>
			</body>
		</html>
	);
}
