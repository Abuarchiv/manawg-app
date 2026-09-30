import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));

function loadErrorMap(file) {
	const source = transpileModule(readFileSync(path.join(process.cwd(), file), 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) =>
			name === '@/core/errors/generic-error-codes'
				? {
						isAuthInvalidated: () => false,
						isInvalidShareCode: () => false,
						isNetworkError: () => false,
						isRetryableServerError: () => false,
					}
				: requireFromWeb(name),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

test('online attachment error maps ask residents to upload a replacement image', () => {
	const expense = loadErrorMap('src/features/expenses/expense-errors.ts');
	const announcement = loadErrorMap('src/features/pinnwand/announcement-errors.ts');
	const chat = readFileSync(
		path.join(process.cwd(), 'src/features/chat/components/ChatView.tsx'),
		'utf8',
	);
	assert.match(
		expense.expenseSaveErrorMessage('image_removed'),
		/Anhang wurde entfernt.*erneut hoch/,
	);
	assert.match(
		expense.expenseActionErrorMessage('image_removed'),
		/Anhang wurde entfernt.*erneut hoch/,
	);
	assert.match(
		announcement.announcementCreateErrorMessage('image_removed'),
		/Anhang wurde entfernt.*erneut hoch/,
	);
	assert.match(
		chat,
		/if \(error === 'image_removed'\) \{\s*return 'Dieses Bild wurde entfernt\. Lade es erneut hoch, bevor du die Nachricht sendest\.';/,
	);
});
