'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useWg } from '@/components/wg/WgContextProvider';
import { NETWORK_ERROR_CODE } from '@/core/http/error-codes';
import { apiFetch } from '@/core/infra/api-client';
import { type Message, useMessage } from '@/shared/i18n/message';

const UNDO_ERRORS: Readonly<Record<string, Message>> = {
	import_settled: { key: 'expenses-import.undo.errors.settled' },
	not_owner: { key: 'expenses-import.undo.errors.notOwner' },
	import_not_found: { key: 'expenses-import.undo.errors.notFound' },
	[NETWORK_ERROR_CODE]: { key: 'common.errors.network' },
};

function undoErrorMessage(error: string): Message {
	return UNDO_ERRORS[error] ?? { key: 'expenses-import.undo.errors.fallback' };
}

/** Takes back everything an import created. Needs a second tap, because it removes expenses. */
export function ImportUndo({ importId, description }: { importId: string; description?: string }) {
	const { wg, identity } = useWg();
	const t = useTranslations('expenses-import.undo');
	const renderMessage = useMessage();
	const [armed, setArmed] = useState(false);
	const [pending, setPending] = useState(false);
	// null: not undone yet; 'unknown': undone, but the first answer was lost so the count is not.
	const [removed, setRemoved] = useState<number | 'unknown' | null>(null);
	const [error, setError] = useState<Message | null>(null);
	const pendingRef = useRef(false);
	// An attempt that ended without an answer may still have deleted everything.
	const uncertainRef = useRef(false);

	async function undo(): Promise<void> {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending(true);
		setError(null);
		try {
			const res = await apiFetch<{ removed: number }>(
				`/api/wg/${encodeURIComponent(wg.shareCode)}/imports/${encodeURIComponent(importId)}`,
				{ method: 'DELETE', memberId: identity.memberId },
			);
			if (res.ok) setRemoved(res.data.removed);
			else if (res.error === 'import_not_found' && uncertainRef.current) setRemoved('unknown');
			else {
				uncertainRef.current = res.status === 0 || res.status >= 500;
				setError(undoErrorMessage(res.error));
			}
		} finally {
			pendingRef.current = false;
			setPending(false);
			setArmed(false);
		}
	}

	if (removed !== null) {
		return (
			<Alert>
				<AlertDescription>
					<output>
						{removed === 'unknown' ? t('doneUnknown') : t('done', { count: removed })}
					</output>
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<div className="flex flex-col items-start gap-2">
			<Button
				type="button"
				variant={armed ? 'destructive' : 'outline'}
				className="min-h-11"
				disabled={pending}
				{...(description
					? { 'aria-label': t(armed ? 'confirmAria' : 'buttonAria', { description }) }
					: {})}
				onClick={() => (armed ? void undo() : setArmed(true))}
			>
				{pending && <Spinner aria-hidden />}
				{armed ? t('confirm') : t('button')}
			</Button>
			{armed && !pending && (
				<Button type="button" variant="ghost" className="min-h-11" onClick={() => setArmed(false)}>
					{t('cancel')}
				</Button>
			)}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{renderMessage(error)}</AlertDescription>
				</Alert>
			)}
		</div>
	);
}
