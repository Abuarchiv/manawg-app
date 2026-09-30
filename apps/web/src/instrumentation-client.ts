if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
	import('@/core/infra/sentry')
		.then(({ initializeSentry }) => initializeSentry())
		.catch(() => {
			// Optional telemetry must never prevent the app from starting.
		});
}

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (key && host === 'https://eu.i.posthog.com') {
	import('posthog-js')
		.then(({ default: posthog }) => {
			posthog.init(key, {
				api_host: host,
				defaults: '2026-08-30',
				cookieless_mode: 'always',
				persistence: 'memory',
				person_profiles: 'never',
				autocapture: false,
				disable_session_recording: true,
				disable_surveys: true,
				advanced_disable_flags: true,
				capture_exceptions: false,
				capture_pageleave: false,
				capture_pageview: 'history_change',
				before_send(event) {
					if (
						!event ||
						!['$pageview', 'wg_created', 'wg_joined'].includes(event.event) ||
						typeof event.uuid !== 'string' ||
						!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.uuid)
					)
						return null;
					const time = event.timestamp instanceof Date ? event.timestamp.getTime() : Number.NaN;
					if (!Number.isFinite(time)) return null;
					// Rebuild instead of forwarding SDK URL/title/identity enrichment or caller properties.
					return {
						uuid: event.uuid,
						event: event.event,
						timestamp: new Date(time),
						properties: {
							token: key,
							distinct_id: '$posthog_cookieless',
							$cookieless_mode: true,
							$process_person_profile: false,
							$host: window.location.hostname,
							$raw_user_agent: navigator.userAgent,
						},
					};
				},
				debug: process.env.NODE_ENV === 'development',
			});
		})
		.catch(() => {
			console.warn('[manawg] Analytics initialization unavailable');
		});
} else if (process.env.NODE_ENV === 'development') {
	for (const variable of [
		...(key ? [] : ['NEXT_PUBLIC_POSTHOG_KEY']),
		...(host ? [] : ['NEXT_PUBLIC_POSTHOG_HOST']),
	]) {
		console.error(
			`${variable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variable} is configured`,
		);
	}
}
