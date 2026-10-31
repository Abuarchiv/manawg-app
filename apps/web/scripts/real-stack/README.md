# Real-stack checks against a local Supabase

Checks sign-in, mails, invitations, expenses, chores, chat, member takeover, account deletion and
session refresh against real Supabase and real PostgreSQL instead of fixtures.

1. Run `supabase init` in a throwaway folder, copy `supabase-config.toml` there as
   `supabase/config.toml` and the templates from `supabase/templates/` to `tpl/`.
2. `supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor`
3. Apply the migrations in journal order with `psql -f` (`db:migrate` only accepts Supabase hosts).
4. Build the app in production mode and start it on port 3140. Clear every variable from
   `.env.local` or point it at the local stack, otherwise the run reaches hosted services.
5. Set `SUPABASE_SERVICE_ROLE_KEY` from `supabase status -o env`, then run
   `node scripts/real-stack/api.mjs`, `journey.mjs` (with `SHOTS_DIR`) and `session.mjs`.
6. `modules.mjs` (also needs `CRON_SECRET`, runs `modules-admin.mjs` too) checks every module
   through the API; `ui.mjs` (with `SHOTS_DIR`) clicks through every page in a phone viewport and
   saves screenshots. The server needs `VERCEL_ENV=development`, otherwise the rate limiter blocks
   without Upstash.
7. `fuzz.mjs` (runs `fuzz-access.mjs` and `fuzz-races.mjs` too) sends broken bodies, foreign ids,
   IDOR and race attempts against every write route; `ui-edit.mjs` (with `SHOTS_DIR`) exercises
   action sheets, editing, deleting, settings and dark mode. `ui.mjs` and `ui-edit.mjs` also run with `BROWSER=webkit` and `DEVICE='iPhone SE'` (or
   `'Pixel 7'`); the WebKit console messages about `interactive-widget` and the CSP-rejected
   `<style>` come from the engine and the Playwright screenshot, not from the app.
8. `data.mjs` (runs `data-load.mjs` too) checks the Splitwise import (preview, commit, no double
   import), JSON/CSV export and the Berlin month boundary of the statement, then load: 400
   expenses, 150 chat messages, 60 shopping items with API timings, page load times and
   "Mehr anzeigen" up to the full list.
9. `session-expiry.mjs` checks the session refresh after token expiry (API, five parallel requests
   with the old token, writes, browser tab switch and reload). Set `jwt_expiry = 120` in the
   throwaway `supabase/config.toml` and pass `JWT_EXPIRY=120`; anything below the 90 s margin of
   auth-js refreshes on every request and fakes a sign-out. `stale-chunk.mjs` answers the shopping
   page's own chunks with 404 as after a deploy and expects the page without an error screen and
   at most one reload, which must come from the error boundary.
10. `auth-flows.mjs`: e-mail code sign-in in the browser (code from Mailpit on port 54324, a wrong
    code first), invitation by mail (`mail_log` ledger, invalid address 400) and receipt upload
    through Supabase Storage (signature, PUT, read as member and flatmate, stranger 401
    `not_a_member`, signed out 401, broken key 400, foreign image on an expense 400, revocation
    after deletion 404).
11. Production rate limits: locally the limiter is open (`VERCEL_ENV=development`). For a run with
    real limits start an Upstash-compatible Redis
    (`docker run -d --name srh-redis redis:7-alpine` and
    `docker run -d --name srh -p 8079:80 --link srh-redis:redis -e SRH_MODE=env -e SRH_TOKEN=local-token -e SRH_CONNECTION_STRING=redis://redis:6379 hiett/serverless-redis-http`),
    put a small TLS proxy with a self-signed certificate in front (the env check requires https),
    then build and start with `UPSTASH_REDIS_REST_URL=https://localhost:8443
    UPSTASH_REDIS_REST_TOKEN=local-token VERCEL_ENV=preview NODE_TLS_REJECT_UNAUTHORIZED=0`.
    `burst.mjs` adds 36 shopping items in one minute and expects no 429; `ui.mjs`, `ui-edit.mjs`
    and `journey.mjs` must also pass in this mode without 429.
12. `push.mjs` turns Web Push on in installed Google Chrome (real FCM), sends the test notification
    and a pinboard post from the second member, runs the chore and event reminder crons for a chore
    due today and a meeting tomorrow, and expects all four in the service worker. The app
    needs `VAPID_*` set at build time. FCM sometimes answers 410 for a subscription for several
    seconds after creating it, or accepts a message and delivers it to headless Chrome late; a
    single failed run is therefore no app bug, the server log tells the two apart.
13. `statement-mail.mjs` books an expense in the previous month, runs the monthly statement cron
    with `force=1`, checks the debtor's mail in Mailpit (amount owed, statement link) and the
    one-click unsubscribe from its `List-Unsubscribe` header, including a tampered token.

The scripts expect the default local keys of `supabase start`. The addresses live in `env.mjs`;
override them with `REAL_STACK_APP_URL` (default `http://localhost:3140`), `REAL_STACK_SUPABASE_URL`
(`http://127.0.0.1:54321`), `REAL_STACK_MAILPIT_URL` (`http://127.0.0.1:54324`) and
`REAL_STACK_DATABASE_URL` (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`).
