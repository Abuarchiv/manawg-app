import { captureException as captureSentryEvent, logger } from '@sentry/core';
import * as Sentry from '@sentry/nextjs';
import { sanitizeSentryBreadcrumb, sanitizeSentryEvent } from './sentry-privacy';

export function initializeSentry(): void {
	const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
	if (!dsn) return;

	try {
		Sentry.init({
			dsn,
			environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
			release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
			dataCollection: { userInfo: false },
			integrations: (integrations) =>
				integrations.filter((integration) => integration.name !== 'BrowserSession'),
			beforeSend: sanitizeSentryEvent,
			beforeBreadcrumb: sanitizeSentryBreadcrumb,
		});
	} catch {
		// Optional telemetry must never prevent the app from starting.
	}
}

export function captureSentryException(error: unknown, tags: Record<string, string>): void {
	try {
		captureSentryEvent(error, { tags });
	} catch {
		// Optional telemetry must never break the caller.
	}
}

export function logSentryApiError(errorTypes: string[]): void {
	try {
		logger.error('api_route_error', {
			error_types: errorTypes.join(' | '),
		});
	} catch {
		// Optional telemetry must never break the caller.
	}
}
