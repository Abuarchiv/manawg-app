import type { User } from '@supabase/supabase-js';
import { afterResponse } from '@/core/infra/after-response';
import { sendMailSafely } from '@/core/mail/send-mail';
import { renderWelcomeMail } from '@/core/mail/templates';
import { MS_PER_DAY } from '@/core/utils/time';
import { isLocale, type Locale } from '@/shared/i18n/locale';

// A session within this time of the e-mail confirmation is the first one: the welcome mail (E1)
// goes out once. Counted from the confirmation, so a sign-up confirmed days later still gets it.
const NEW_ACCOUNT_WINDOW_MS = MS_PER_DAY;

function firstName(user: User): string | null {
	const meta = user.user_metadata as Record<string, unknown> | undefined;
	const raw = [meta?.full_name, meta?.name, meta?.given_name].find(
		(value): value is string => typeof value === 'string' && value.trim().length > 0,
	);
	return raw ? (raw.trim().split(/\s+/)[0] ?? null) : null;
}

/**
 * Sent once per account (dedupe key), after the first confirmed session, by link or by code.
 * The language chosen at sign-up wins; `locale` (of the confirming browser) is the fallback.
 */
export function queueWelcomeMail(user: User, locale: Locale): void {
	const confirmedAt = Date.parse(user.email_confirmed_at ?? '');
	if (!user.email || !Number.isFinite(confirmedAt)) return;
	if (Date.now() - confirmedAt > NEW_ACCOUNT_WINDOW_MS) return;
	const to = user.email;
	const stored = (user.user_metadata as Record<string, unknown> | undefined)?.locale;
	afterResponse(() =>
		sendMailSafely({
			kind: 'welcome',
			dedupeKey: `welcome:${user.id}`,
			to,
			mail: renderWelcomeMail({
				firstName: firstName(user),
				locale: isLocale(stored) ? stored : locale,
			}),
		}),
	);
}
