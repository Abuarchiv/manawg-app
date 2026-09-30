# ManaWG performance baseline — 2026-09-26

This is one authenticated Chrome navigation on the READY Production deployment
`dpl_5ZSVAXfpSvv7PkChwqXWpWDjqS3F`, with the browser cache disabled. Its
source commit was not exposed by the deployment readback. Times are measured
from navigation start; this sample is not a p50, p95, or real-user metric.

| Event | Start | Duration |
| --- | ---: | ---: |
| Document first byte | 443 ms | — |
| Initial WG identity GET | 958 ms | 405 ms |
| Dashboard GET | 1,459 ms | 519 ms |
| Events GET | 1,460 ms | 520 ms |
| Final observed LCP | 2,368 ms | — |

The dashboard, events, members, and unread-count requests began only after the
identity GET finished. The server layout had already authenticated the user and
loaded the active WG membership. Commit `2002b38` passes that verified member
identity into the client provider, removing the redundant initial GET from the
normal signed-in path. Fixture mode keeps its existing identity flow. API routes
still verify membership themselves. The hosted time saved by this change has
not yet been measured.

Production `pg_stat_statements` showed common app SELECTs at roughly
0.03–0.13 ms mean execution time. `pg_stat_user_tables` estimated 12 WG members
and four expenses. Those statistics do not support an index or larger pool as
the fix for today's initial-load delay. Dashboard reads entire WG histories
every 30 seconds, which remains a scaling concern as data grows.

Next comparison: measure the same authenticated navigation after the candidate
reaches protected Preview, then compare request start times and LCP over several
runs. Trace auth and connection wait separately before changing the shared API
guard or database configuration.
