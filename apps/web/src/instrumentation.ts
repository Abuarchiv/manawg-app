/**
 * This file has to live in `src/`, not in the package root.
 *
 * Next.js looks for `instrumentation.ts` next to the app directory — and this
 * app lives in `src/app`. In the package root the file is silently ignored: no
 * build artifact, no error, no boot log.
 */

/**
 * Surfaces configuration problems once at boot instead of letting each affected
 * feature fail silently at the moment a user first touches it.
 */
async function reportEnvironment(): Promise<void> {
	const { checkEnv, formatEnvReport } = await import('./core/infra/env');
	const result = checkEnv(process.env);
	const report = formatEnvReport(result);

	if (!result.ok) {
		const { captureException } = await import('./core/infra/observability');
		const error = new Error(
			`Missing required environment variables: ${result.missingRequired.join(', ')}`,
		);
		captureException(error, {
			area: 'startup',
			missing: result.missingRequired,
			report,
		});
		// Fail open: a missing env var degrades the affected feature, but
		// crashing the entire server boot leaves every tenant without service.
		// The captured exception surfaces the problem in the observability
		// pipeline so operators can fix it without a global outage.
		//
		console.error(report);
		return;
	}
	// biome-ignore lint/suspicious/noConsole: degraded startup diagnostics are informational.
	if (result.degraded.length > 0) console.info(report);
}

export async function register() {
	if (process.env.NEXT_RUNTIME === 'nodejs') {
		await import('../sentry.server.config');
		await reportEnvironment();
	} else if (process.env.NEXT_RUNTIME === 'edge') {
		await import('../sentry.edge.config');
	}
}

/**
 * Next.js calls this for every server-side error, including ones thrown during
 * rendering that never reach a route's own catch block. Without it those
 * failures would only show up as an opaque 500 in the platform log.
 */
export async function onRequestError(
	error: unknown,
	request: { path: string; method: string },
): Promise<void> {
	const { captureException } = await import('./core/infra/observability');
	captureException(error, { path: request.path, method: request.method });
}
