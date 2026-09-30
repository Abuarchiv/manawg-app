'use client';

import { ImportWizard } from '@/features/expenses/components/import/ImportWizard';

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function ImportPage() {
	return (
		<div data-finance-content className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
			<ImportWizard />
		</div>
	);
}
