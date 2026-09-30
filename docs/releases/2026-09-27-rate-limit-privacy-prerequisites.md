# Upstash rate-limit analytics publication gate — 2026-09-27

**Current status (2026-09-30):** The review candidate disables Upstash rate-limit analytics, but the Production cutover and historical-data cleanup are not verified. Do not claim this gate closed or publish a deletion/retention claim from the candidate source alone.

**Status at the 2026-09-27 readback:** Do not publish the landing update until the rate-limit analytics cutover and historical-data checks are complete.

## Initial readback — 2026-09-27

Current Production still uses the previous app code with Upstash analytics enabled. Candidate commit `a242a81` disables SDK analytics and makes SDK timeouts respect the configured failure policy; its real-SDK regression passes. Deployment cutover remains unperformed, so do not publish the corresponding notice yet. Candidate rate-limit counters use raw client-IP keys where IP limiting applies and expire after at most 2 hours and 1 second (the longest configured window is one hour). Member-scoped counters use member identifiers.

The installed `@upstash/ratelimit` 2.0.8 / `@upstash/core-analytics` 0.0.10 path records the limiter identifier and outcome in hourly analytics buckets without an application-set expiry. The wrapper passes a `retention` value that this core-analytics version does not consume. Therefore the former 24-hour/no-permanent-storage statement was unsupported.

The resource is `upstash-kv-carmine-clock`, Vercel resource `store_4dDvmtJKRDzbsVKL`, installation `icfg_oozp4hyQ4vBam8i2aCGAxjMy`, Upstash database `1ff96aed-6289-44a1-a4e8-8059e85f57eb`. Vercel UI and CLI confirm attachment to `manawg-app` across Production, Preview and Development. The local configured endpoint matches the resource and the readable Production `REDIS_URL`/`KV_URL` hostnames. One ordinary unauthenticated Production health GET returned 200; a bounded before/after health-namespace metadata scan showed one additional counter key and an event-cardinality increase of one. This strongly supports runtime association, but concurrent health traffic prevents unique attribution. The specific Production UPSTASH env record remains Sensitive, has no configuration/resource ID, and cannot be directly compared. No credential or identifier values are recorded here.

The initial incomplete 500-key scan was superseded by a complete scoped `manawg:*:events:*` scan below a 5,000-key cap: **539 unique event-index keys, all TTL=-1; aggregate ZCARD 1,067**. No members, payloads, raw keys or IPs were read or emitted. The inventory used SCAN/TTL/ZCARD only and made no Redis writes/deletions. The ordinary health GET uses the deployed limiter and may itself add normal telemetry; the before/after delta is correlation, not proven causation.

Do not claim historical analytics are gone. Before publication, complete the app cutover and obtain explicit authorization for a narrowly scoped historical-retention cleanup. The resource is shared across environments, so cleanup must not remove active counters or unrelated keys. This note records release facts; it is not a legal-compliance assessment or sign-off.

## Candidate readback — 2026-09-30

The `cca08ac6` source tree constructs its Upstash rate limiters with `analytics: false`. New limiter counters still use raw client-IP keys for IP-scoped limits or member identifiers for member-scoped limits, and expire within their configured sliding windows (the prior audit measured an upper bound of two hours and one second). This is a source-level candidate fact, not proof of Production cutover.

The September 27 read-only Upstash inventory remains the latest data readback available to this task: it found 539 `manawg:*:events:*` index keys without a TTL and aggregate cardinality 1,067. No payloads or IP values were read. No fresh scan or Redis mutation was performed on September 30. Historical analytics may still exist; disabling analytics does not erase old buckets. Any cleanup of the shared Redis resource remains a separate, explicitly authorized operator action.

## Read-only metadata refresh — 2026-09-30

Using the existing TLS `REDIS_URL`/`KV_URL` in the private workspace environment, both confirmed to resolve to the same Upstash database, a bounded `SCAN MATCH manawg:*:events:* COUNT 1000` found **552 unique keys**. All were sorted sets with **TTL -1** and a combined **ZCARD of 1,111**; none disappeared during the metadata read. Compared with September 27, that is **+13 keys** and **+44 members**.

The time-like key suffixes span **2026-08-29 06:00 UTC–2026-09-28 01:00 UTC**. This is only the key-bucket range; sorted-set scores and members were not read, so it does not establish event timestamps or a retention policy. No expiry is configured by these keys. The review-only purge plan has 552 candidates, bounded to numeric bucket suffixes no later than the recorded scan start (`2026-09-30T12:24:23.073Z`) and the matching metadata fingerprint in the private operator report. Owner approval is required before deletion. No deletion or TTL mutation was performed.
