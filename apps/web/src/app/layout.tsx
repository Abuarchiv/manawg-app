import { InstallPrompt } from '@/shared/components/install-prompt';
import { PwaRegister } from '@/shared/components/pwa-register';
import { ThemeProvider } from '@/shared/components/theme/ThemeProvider';
import { getAppUrl } from '@/shared/lib/app-url';
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
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
	'Die WG-App für Ausgaben, Putzplan, Einkauf und Pinnwand. In Deutschland gehostet und datensparsam.';

const organizationSchema = {
	'@context': 'https://schema.org',
	'@type': 'Organization',
	name: 'ManaWG',
	url: appUrl,
	logo: `${appUrl}/icon-512.png`,
	description:
		'Die WG-App für Ausgaben, Putzplan, Einkauf und Pinnwand. Kostenlos und datensparsam.',
};

const softwareApplicationSchema = {
	'@context': 'https://schema.org',
	'@type': 'SoftwareApplication',
	name: 'ManaWG',
	description:
		'Die WG-App für Ausgaben, Putzplan, Einkauf und Pinnwand. Kostenlos und datensparsam.',
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
	alternates: {
		canonical: '/',
	},
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
				alt: 'ManaWG — Die WG-App, die einfach funktioniert.',
			},
		],
	},
	twitter: {
		card: 'summary_large_image',
		title: 'ManaWG — Deine WG-App',
		description: 'Die WG-App, die einfach funktioniert.',
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

// craftsman-ignore: TS002 — Next.js App Router requires default export for layouts
export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
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
				{/* Sehr früh den beforeinstallprompt-Event abfangen — bevor React mountet.
            Browser feuert das Event nur einmal; ohne diesen Catcher verlieren
            spät-mountende Komponenten ihn komplett. */}
				<Script id="manawg-install-ready" strategy="beforeInteractive">
					{`(function(){if(typeof window==='undefined')return;window.__manawgDeferredInstallEvent=null;window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__manawgDeferredInstallEvent=e;window.dispatchEvent(new CustomEvent('manawg:install-ready'));});})();`}
				</Script>
				{/* Anti-flicker theme bootstrap — runs synchronously before first paint.
            Safe: no dynamic data interpolated, only reads from localStorage.
            Pattern used by next-themes and every major theme library. */}
				<Script id="manawg-theme-bootstrap" strategy="beforeInteractive">
					{`(function(){try{var t=localStorage.getItem('manawg-theme');var s=t!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||s){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){}})();`}
				</Script>
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
					<div className="relative mx-auto min-h-svh w-full max-w-[var(--app-frame-width)] bg-background min-[30rem]:border-x">
						{children}
						<PwaRegister />
						<InstallPrompt />
					</div>
				</ThemeProvider>
			</body>
		</html>
	);
}
