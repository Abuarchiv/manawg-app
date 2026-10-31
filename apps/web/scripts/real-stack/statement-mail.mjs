// Monthly statement mail: an expense in a finished month, the cron with `force=1`, the mail to the
// debtor in Mailpit (amounts, links) and the one-click unsubscribe from its List-Unsubscribe header.
import { MAIL } from './env.mjs';
import { BASE, CRON, call, expect, finish, setup, sql } from './modules-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { A, B, code, annaId, benId } = await setup();
const now = new Date();
const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 10));
const monthKey = month.toISOString().slice(0, 7);
const expense = await call(A, 'POST', `/api/wg/${code}/expenses`, {
	amountCents: 6000,
	description: 'Monatseinkauf',
	category: 'groceries',
	paidByMemberId: annaId,
	occurredAt: month.toISOString(),
	splits: [
		{ debtorMemberId: annaId, amountCents: 3000 },
		{ debtorMemberId: benId, amountCents: 3000 },
	],
});
expect(expense.status < 300, 'expense in the finished month', JSON.stringify(expense.body));

const run = await fetch(`${BASE}/api/cron/monthly-statements?force=1&month=${monthKey}`, {
	headers: { authorization: `Bearer ${CRON}` },
});
const summary = await run.json();
expect(
	run.status === 200 && summary.failed === 0,
	'statement run without failures',
	JSON.stringify(summary),
);

const benMail = await (async () => {
	for (let i = 0; i < 20; i++) {
		const found = await (
			await fetch(`${MAIL}/search?query=${encodeURIComponent(`to:${B.email}`)}`)
		).json();
		const hit = found.messages?.find((m) => / ist abgerechnet$/.test(m.Subject));
		if (hit) return (await fetch(`${MAIL}/message/${hit.ID}`)).json();
		await wait(500);
	}
	return null;
})();
expect(!!benMail, 'Ben receives the statement mail');
if (benMail) {
	expect(
		/Du schuldest: 30,00\s€/.test(benMail.Text),
		'mail states what Ben owes',
		benMail.Text.slice(0, 300),
	);
	expect(
		benMail.Text.includes(`${BASE}/wg/${code}/statement?month=${monthKey}`),
		'mail links the statement of that month',
	);
	const headers = await (await fetch(`${MAIL}/message/${benMail.ID}/headers`)).json();
	const unsubscribe = /<([^>]+)>/.exec(headers['List-Unsubscribe']?.[0] ?? '')?.[1];
	expect(
		!!unsubscribe && headers['List-Unsubscribe-Post']?.[0] === 'List-Unsubscribe=One-Click',
		'one-click unsubscribe header',
	);
	if (unsubscribe) {
		const oneClick = await fetch(unsubscribe, {
			method: 'POST',
			body: 'List-Unsubscribe=One-Click',
		});
		expect(oneClick.status === 200, 'one-click unsubscribe accepted', String(oneClick.status));
		const tampered = await fetch(`${unsubscribe.slice(0, -1)}x`, { method: 'POST' });
		expect(tampered.status === 400, 'tampered unsubscribe token rejected', String(tampered.status));
		const stillSubscribed = sql(
			`select notify_statement_email from wg_members where id = '${benId}'`,
		);
		expect(stillSubscribed === 'f', 'Ben no longer gets the statement mail', stillSubscribed);
	}
}
finish();
