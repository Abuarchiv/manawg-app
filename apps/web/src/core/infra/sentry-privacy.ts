type SentryBreadcrumbShape = {
	category?: string;
	type?: string;
	level?: string;
	timestamp?: number;
	data?: Record<string, unknown>;
	message?: string;
};

type SentryEventShape = {
	user?: unknown;
	request?: { url?: string; method?: string; [key: string]: unknown };
	message?: string | undefined;
	logentry?: unknown;
	extra?: unknown;
	contexts?: Record<string, unknown> | undefined;
	tags?: Record<string, string>;
	transaction?: string;
	culprit?: string;
	exception?: { values?: Array<{ value?: string; [key: string]: unknown }> };
	breadcrumbs?: unknown[];
};

const SAFE_TAG_VALUES: Record<string, ReadonlySet<string>> = {
	area: new Set(['startup', 'rate-limit']),
	boundary: new Set(['global', 'root', 'wg-code']),
	cronJob: new Set(['event-reminders', 'chore-reminders', 'maintenance', 'recurring-advance']),
	method: new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']),
};

const TRUSTED_ERROR_NAMES = new Set([
	'Error',
	'EvalError',
	'RangeError',
	'ReferenceError',
	'SyntaxError',
	'TypeError',
	'URIError',
	'AggregateError',
]);

export function safeErrorName(name: unknown): string {
	return typeof name === 'string' && TRUSTED_ERROR_NAMES.has(name) ? name : 'Error';
}

function sanitizeUrl(value: string): string {
	const [withoutQuery = ''] = value.split(/[?#]/, 1);
	const withoutPrivateRoutes = withoutQuery
		.replace(/(\/wg\/)[^/]+/gi, '$1[redacted]')
		.replace(/(\/api\/calendar\/)[^/]+\/[^/]+/gi, '$1[redacted]/[redacted]')
		.replace(
			/(\/(?:storage\/v1\/)?object\/(?:upload\/)?sign\/)[^/?#]+(?:\/[^?#]*)?/gi,
			'$1[redacted]',
		);
	if (!/[?&]X-Amz-Signature=/i.test(value)) return withoutPrivateRoutes;

	const withRedactedS3Key = withoutPrivateRoutes.replace(
		/(\/manawg\/)[^/]+\/([^/]+)\/[^/]+/i,
		'$1[redacted]/$2/[redacted]',
	);
	if (withRedactedS3Key !== withoutPrivateRoutes) return withRedactedS3Key;
	const origin = withoutPrivateRoutes.match(/^https?:\/\/[^/]+/i)?.[0];
	return origin ? `${origin}/[redacted]` : '[redacted]';
}

export function sanitizeSentryBreadcrumb<T>(breadcrumb: T): T | null {
	const crumb = breadcrumb as unknown as SentryBreadcrumbShape | null;
	if (!crumb || crumb.category === 'console' || crumb.category === 'ui') return null;

	const data: Record<string, string> = {};
	for (const key of ['url', 'from', 'to']) {
		const value = crumb.data?.[key];
		if (typeof value === 'string') data[key] = sanitizeUrl(value);
	}

	return {
		category: crumb.category,
		type: crumb.type,
		level: crumb.level,
		timestamp: crumb.timestamp,
		...(Object.keys(data).length > 0 ? { data } : {}),
	} as unknown as T;
}

export function sanitizeSentryEvent<T>(event: T): T {
	const safe = event as unknown as SentryEventShape;
	safe.user = undefined;
	safe.message = undefined;
	safe.logentry = undefined;
	safe.extra = undefined;

	const trace = safe.contexts?.trace;
	const traceFields =
		trace && typeof trace === 'object'
			? Object.fromEntries(
					Object.entries(trace).filter(([key]) =>
						['trace_id', 'span_id', 'parent_span_id', 'op', 'status', 'origin', 'sampled'].includes(
							key,
						),
					),
				)
			: {};
	safe.contexts = Object.keys(traceFields).length > 0 ? { trace: traceFields } : undefined;

	if (safe.request) {
		safe.request = {
			...(safe.request.method ? { method: safe.request.method } : {}),
			...(safe.request.url ? { url: sanitizeUrl(safe.request.url) } : {}),
		};
	}
	if (safe.transaction) safe.transaction = sanitizeUrl(safe.transaction);
	if (safe.culprit) safe.culprit = sanitizeUrl(safe.culprit);

	for (const value of safe.exception?.values ?? []) {
		value.value = '[redacted]';
		value.type = safeErrorName(value.type);
	}

	if (safe.tags) {
		safe.tags = Object.fromEntries(
			Object.entries(safe.tags).filter(([key, value]) => SAFE_TAG_VALUES[key]?.has(value) === true),
		);
	}
	if (safe.breadcrumbs) {
		safe.breadcrumbs = safe.breadcrumbs
			.map((breadcrumb) => sanitizeSentryBreadcrumb(breadcrumb))
			.filter((breadcrumb): breadcrumb is unknown => breadcrumb !== null);
	}

	return event;
}
