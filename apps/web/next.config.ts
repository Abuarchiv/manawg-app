import bundleAnalyzer from '@next/bundle-analyzer';
import { withSentryConfig } from '@sentry/nextjs/config';
import type { NextConfig } from 'next';

const withBundleAnalyzer = bundleAnalyzer({
	enabled: process.env.ANALYZE === 'true',
	openAnalyzer: false,
});

const securityHeaders = [
	{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
	{ key: 'X-Content-Type-Options', value: 'nosniff' },
	{ key: 'X-Frame-Options', value: 'DENY' },
	{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
	{
		key: 'Permissions-Policy',
		value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
	},
	{ key: 'X-DNS-Prefetch-Control', value: 'off' },
];

// craftsman-ignore: TS002 — Next.js config requires default export
const nextConfig: NextConfig = {
	env: {
		NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
		NEXT_PUBLIC_SENTRY_RELEASE:
			process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
	},
	distDir: process.env.NEXT_DIST_DIR ?? '.next',
	typescript: {
		ignoreBuildErrors: false,
		tsconfigPath: process.env.NEXT_TSCONFIG_PATH ?? 'tsconfig.json',
	},
	eslint: {
		ignoreDuringBuilds: false,
	},
	images: {
		remotePatterns: [
			{
				protocol: 'https',
				hostname: '*.amazonaws.com',
			},
		],
	},
	async headers() {
		return [{ source: '/:path*', headers: securityHeaders }];
	},
	experimental: {
		optimizePackageImports: ['lucide-react'],
	},
};

const analyzedConfig = withBundleAnalyzer(nextConfig);
const sentryUploadOptions =
	process.env.SENTRY_ORG && process.env.SENTRY_PROJECT && process.env.SENTRY_AUTH_TOKEN
		? {
				org: process.env.SENTRY_ORG,
				project: process.env.SENTRY_PROJECT,
				authToken: process.env.SENTRY_AUTH_TOKEN,
				release: {
					name: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
				},
				widenClientFileUpload: true,
				hideSourceMaps: true,
				telemetry: false,
				silent: !process.env.CI,
			}
		: undefined;

export default sentryUploadOptions
	? withSentryConfig(analyzedConfig, sentryUploadOptions)
	: analyzedConfig;
