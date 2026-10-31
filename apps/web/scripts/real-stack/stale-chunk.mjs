// A tab from before a deploy: its next lazy chunk is gone (404). The app must recover, at most
// with one reload, instead of parking the member on "Etwas ist schiefgelaufen".
import { chromium, devices } from '@playwright/test';
import { BASE, call, expect, finish, user } from './modules-lib.mjs';

const A = await user('Chunk');
const w = await call(A, 'POST', '/api/wg', { name: 'Chunkwohnung', creatorName: 'Chunk' });
const code = w.body.wg?.shareCode;
expect(!!code, 'WG created');

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], baseURL: BASE });
await ctx.addCookies((await A.ctx.storageState()).cookies);
const p = await ctx.newPage();

let blocked = 0;
let loads = 0;
let armed = false;
// Chunk names are content hashes, so the shopping page's own chunks are the scripts its HTML
// loads beyond those of the chores page.
const scriptsOf = async (path) => {
	const html = await (await ctx.request.get(path)).text();
	return new Set(html.match(/\/_next\/static\/chunks\/[\w.-]+\.js/g) ?? []);
};
const choresScripts = await scriptsOf(`/wg/${code}/chores`);
const shoppingOnly = [...(await scriptsOf(`/wg/${code}/shopping`))].filter(
	(src) => !choresScripts.has(src),
);
expect(shoppingOnly.length > 0, 'shopping page has chunks of its own', String(shoppingOnly.length));
const chunk = (url) => shoppingOnly.some((src) => url.pathname === src);
await p.route(chunk, (route) => {
	blocked += 1;
	return route.fulfill({ status: 404, body: '' });
});
p.on('load', () => {
	if (!armed) return;
	loads += 1;
	// The deploy is "done" by the time the tab reloads: serve the chunk again.
	p.unroute(chunk).catch(() => undefined);
});
// Route handlers run before the prefetch of the visible segment links, so the page chunk is
// never cached: like a tab whose chunk the next deploy removed.
await p.goto(`/wg/${code}/chores`);
await p.waitForLoadState('networkidle');
armed = true;
await p
	.getByText(/^Einkäufe/)
	.first()
	.click();
await p.getByPlaceholder(/Reis/).waitFor({ timeout: 20_000 });
await p.waitForLoadState('load');
expect(blocked > 0, 'old chunk was answered with 404', String(blocked));
// The router may render without the chunk; a reload has to come from the error boundary.
expect(loads <= 1, 'at most one reload', String(loads));
if (loads === 1) {
	const marker = await p.evaluate(() => window.sessionStorage.getItem('manawg:stale-chunk-reload'));
	expect(marker === p.url(), 'reload came from the error boundary', String(marker));
}
expect(/\/shopping/.test(p.url()), 'shopping visible after reload', p.url());
const stuck = await p.getByText('Etwas ist schiefgelaufen').count();
expect(stuck === 0, 'no error page left standing');
await browser.close();
finish();
