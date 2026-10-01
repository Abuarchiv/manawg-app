import bundleAnalyzer from '@next/bundle-analyzer';
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
	{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
	{ key: 'X-DNS-Prefetch-Control', value: 'off' },
];

// craftsman-ignore: TS002 — Next.js config requires default export
const nextConfig: NextConfig = {
	distDir: process.env.NEXT_DIST_DIR ?? '.next',
	typescript: {
		ignoreBuildErrors: false,
		tsconfigPath: process.env.NEXT_TSCONFIG_PATH ?? 'tsconfig.json',
	},
	eslint: {
		ignoreDuringBuilds: false,
	},
	async headers() {
		return [{ source: '/:path*', headers: securityHeaders }];
	},
	experimental: {
		optimizePackageImports: ['lucide-react'],
	},
};

export default withBundleAnalyzer(nextConfig);
