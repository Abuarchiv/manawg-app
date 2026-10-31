'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useWg } from '@/components/wg/WgContextProvider';
import { apiFetch } from '@/core/infra/api-client';
import { ImportUndo } from './ImportUndo';
import { formatImportDate } from './import-date';

interface PastImport {
	id: string;
	source: string;
	startedAt: string;
	inserted: number;
	importedByMemberId: string | null;
}

const SOURCE_KEYS = {
	splitwise_csv: 'splitwise',
	splid_csv: 'splid',
	ocr_screenshot: 'screenshot',
} as const;

/** Earlier imports with their undo, for whoever ran them and for admins. */
export function ImportHistory() {
	const { wg, identity, members, isAdmin } = useWg();
	const t = useTranslations('expenses-import.history');
	const locale = useLocale();
	const [imports, setImports] = useState<PastImport[]>([]);
	const [loadFailed, setLoadFailed] = useState(false);
	const shareCode = wg.shareCode;
	const memberId = identity.memberId;

	// The list depends on the role (an admin sees every import), so a role change loads it again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: isAdmin only triggers the reload
	useEffect(() => {
		let cancelled = false;
		void apiFetch<{ imports: PastImport[] }>(`/api/wg/${encodeURIComponent(shareCode)}/imports`, {
			memberId,
		}).then((res) => {
			if (cancelled) return;
			setLoadFailed(!res.ok);
			if (res.ok) setImports(res.data.imports);
		});
		return () => {
			cancelled = true;
		};
	}, [shareCode, memberId, isAdmin]);

	if (loadFailed && imports.length === 0) {
		return <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>;
	}
	if (imports.length === 0) return null;
	return (
		<section aria-labelledby="import-history-heading" className="flex flex-col gap-2">
			<h2 id="import-history-heading" className="font-heading text-sm font-semibold">
				{t('title')}
			</h2>
			<ul className="flex flex-col divide-y rounded-xl border">
				{imports.map((item) => {
					const author = members.find((member) => member.id === item.importedByMemberId)?.name;
					const sourceKey = SOURCE_KEYS[item.source as keyof typeof SOURCE_KEYS] ?? 'other';
					const description = t('description', {
						source: t(sourceKey),
						date: formatImportDate(item.startedAt, locale, 'Europe/Berlin'),
					});
					const mayUndo = isAdmin || item.importedByMemberId === memberId;
					return (
						<li key={item.id} className="flex flex-col gap-2 p-3 text-sm">
							<span>
								{author
									? t('entryBy', { description, count: item.inserted, author })
									: t('entry', { description, count: item.inserted })}
							</span>
							{mayUndo && <ImportUndo importId={item.id} description={description} />}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
