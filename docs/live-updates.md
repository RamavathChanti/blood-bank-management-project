# Live updates and the cached Public Board

Stage 8 uses the project's selected **bounded polling fallback**. No Ably account,
subscription token, channel or guaranteed message delivery is implied. All data
is synthetic. Teaching model, not clinical software.

## Updates and authorization

Bank, Hospital, Donor and State portals poll their existing authenticated resources
every five seconds. Durable Code Red polls authorized request progress. Each
resource/request has a **120-attempt** automatic budget; success does not reset it.
The visible refresh/resume control starts another budget. New selections or manual
actions also start a new budget. Public summaries poll every **15 seconds**.

Polling pauses while hidden/offline, avoids overlapping scheduled calls, backs off
to at most 30 seconds after failures, and gives reads a ten-second timeout. Online,
focus and visibility events refetch authoritative state, subject to the budget and
a one-second hint throttle. Different sessions reconcile through these reads.

Successful browser writes send a same-origin BroadcastChannel message containing
only `"refresh"` plus an in-tab event. No tenant/request/donor IDs, credentials,
receipts or records cross the channel. Every receiver refetches using its own
session. Hints are optional and can be missed; unsupported browsers keep polling
and manual refresh. Background workflow steps are observed by polling, rather
than publishing a message per step.

Generation guards reject older responses after newer refreshes, scope changes or
unmount. Account changes remount private surfaces. Failures label retained records
as last known; 401/403 clears the affected lists. Reconciliation replaces the first
page/cursor, so load more again if required. No shared or persistent browser cache
of private records is added. Long workflows may outlive the polling budget; resume
updates explicitly in that case.

**Polling mode has no realtime token endpoint.** Existing server-validated Clerk
sessions and scoped emergency receipts remain the credentials. Private API
successes and errors retain `Cache-Control: private, no-store, max-age=0` and
`Vary: Cookie, Authorization`. Public/statewide unauthenticated views receive only
the same aggregate. The exact `/api/public-board` middleware bypass avoids Clerk
cookies and user-dependent responses; it does not bypass any private API.

If Ably is selected later, grant subscribe-only tokens server-side after current
membership checks, scope them to the relevant institution/request, publish hints
after commit and refetch authoritative records after reconnect. Never expose a
server key or wildcard tenant subscription. This alternative is not implemented.

## Public disclosure and cache contract

`GET /api/public-board` emits only `schema`, `generatedAt`, `source` (always
`synthetic-registry`) and a fixed **96-cell** array. Each cell has exactly
`district`, `group`, `component`, `band`. There are four approved pilot districts,
eight groups and three components. Unknown values are dropped. Bank, hospital,
donor, unit, request, allocation and tenant IDs, names, locations, exact counts,
workflow traces and health fields never enter the payload.

Teaching bands are NONE (0), LOW (1–4), MODERATE (5–14), HIGH (15+). Changes in sparse
districts still reveal coarse changes; this is a synthetic disclosure policy, not
statistical anonymity. The UI exposes no exact counts or numeric band thresholds.

Aggregation uses actual AVAILABLE units, five NON_REACTIVE screens, VERIFIED
storage, no reservation, collection at/before now, strict logical expiry and valid
product/component shelf life. Banks join by both state and current tenant before
district grouping. Lagging `stock` counters do not determine public availability.
The allowlist builder does not serialize raw aggregation rows.

Next **16.4.3**, with the app's existing Cache Components setting, uses supported
`unstable_cache` with **30-second revalidation**. Keys include schema/state/database
name. `connection()` keeps execution at request time so unconfigured builds work.
The cache wraps public data only, without request cookies or identity. Query
failure throws: Next retains its last successful entry during failed background
revalidation and retries later. A process-local Map is not the cache mechanism.

Successful headers are:

```text
Cache-Control: public, max-age=0, must-revalidate
Vercel-CDN-Cache-Control: public, s-maxage=1, stale-while-revalidate=29
```

The short outer CDN lifetime avoids stacking two 30-second freshness windows.
Approximately 30 seconds is a target, plus background revalidation/transport time;
the UI's 15-second polling adds observation delay. Outages can leave much older
snapshots. The UI continuously shows timestamp/age and labels failed refreshes or
snapshots over 30 seconds as last known/stale.

A cold cache without a successful query returns sanitized **503**, `Retry-After:
30`, and **no-store** on browser and Vercel cache headers. An outage never becomes
a successful zero-stock matrix. Browser memory retains any earlier snapshot with
an error label; reload loses that browser fallback. Next Data Cache provides the
server-side last-good behavior. Cache purges, eviction, deployment/environment
changes and platform retention may make a future read cold.

The UI reads the actual **resource response's `x-vercel-cache`** header. Supported
observations are HIT, MISS, STALE, BYPASS and REVALIDATED; missing/unsupported values
show **unknown**. No status is inferred from age, an HTML header, or a local cache
hit. Local Next has no Vercel CDN. Actual hosted header evidence remains required.

The Control Room displays this registry section separately from its independent
worker-driven Pulse Map simulation. Public fetches omit cookies.

## Verification and preview smoke

Run lint, types, unit tests, integration tests, production build, `npm run test:cache`
and browser tests. `test:cache` runs after a build and owns its temporary MongoDB
and production Next process. It checks cold uncached failure, warm reuse, real
30-second revalidation, last-good data after a real MongoDB failpoint rejects
aggregation, and recovery after removing it. Allow about 65 seconds. No production
chaos endpoint or secret is added. Do not overlap it with a build. Its runtime
evidence goes to `../_ai_context/artifacts/` (temporary workspace output in CI).

Browser coverage includes filters, observed-header fixtures, local unknown,
warm/cold outages, two isolated browser contexts with portal API fixtures,
reconnect, same-origin tab hints, hidden/offline pauses, backoff, attempt cap and
resume. Fixture tests do not prove signed Clerk, Atlas or Vercel CDN behavior.

`npm run test:preview` requires exact `PLAYWRIGHT_BASE_URL`. The trusted-branch
preview workflow validates its Vercel origin before exposing the optional bypass
secret. It checks login, inventory, hospital, Code Red, Public Board, private cache
denials and browser atomic Duel; public response/header observations are retained.
This dedicated suite avoids local-only unconfigured-auth assumptions.

Full cloud acceptance requires Environment variable `PREVIEW_REQUIRE_LIVE=1` and
three **secret JSON Playwright storage states** from legitimate signed-in synthetic
Clerk accounts on that origin:

- `PREVIEW_BANK_STORAGE_STATE`: the owning bank.
- `PREVIEW_HOSPITAL_STORAGE_STATE`: the first hospital.
- `PREVIEW_HOSPITAL_B_STORAGE_STATE`: a different hospital.

Never commit/print storage states. Traces/screenshots are disabled in that suite.
Use fresh sessions and a dedicated synthetic preview database with exactly **one
eligible O-negative PRBC** unit within both hospitals' search radius, usable at
least an hour. The signed smoke creates two routine requests, checks their sole
candidates, races real reservation POSTs, checks one winner plus one no-stock
result and the bank's unique active slot, then cancels both requests in `finally`.
Request/history/retry records remain for review; there is no database reset/delete.
Do not aim this fixture-dependent suite at the shared presentation dataset.

Missing session states explicitly skip the signed journey in shell-smoke mode.
With `PREVIEW_REQUIRE_LIVE=1`, missing states, unconfigured auth, unavailable public
data or absent real CDN reuse observations fail. Shell checks with a skipped
signed test do not close Stage 8. The browser Duel model remains explicitly
different from this real reservation race and the replica-set integration race.

## Minimum two-session rehearsal

1. Finish Stage 5–7 service setup. Record preview/production URLs, revision,
   environment/region and reviewer names.
2. Sign into Bank and Hospital in separate browser profiles. Open Control Room and
   Public Board. Record public resource headers/bodies and snapshot age over
   repeated GETs; do not use DevTools' disable-cache option when measuring CDN hits.
3. Create a routine request, reserve, observe Bank stock/slot updates, issue,
   confirm handover and synthetic use. Record IDs, timestamps, counters and actual
   delay in both sessions. Do not claim an unmeasured five-second hard guarantee.
4. Replay Stage 7 stock and donor-response workflows. Observe current progress and
   replies in scoped portals. Disconnect one browser, change data from the other,
   reconnect and record reconciliation. Donor acceptance is not screened stock.
5. Run full signed smoke against the isolated last-unit fixture. Retain real race
   results separately from the teaching-model Duel screenshot.
6. In a dedicated authorized outage environment, warm the public cache, lose the
   database, record retained snapshot age/headers, recover and record fresh data.
   Test a cold namespace separately. Local cache tests are not hosted CDN evidence.
7. Retain smoke JSON, screenshots, exact headers, request/event/run IDs and measured
   update delays in the Stage 8 context evidence; ask a second reviewer to replay.

## Official references (checked 2026-10-29)

- [Next unstable_cache](https://nextjs.org/docs/app/api-reference/functions/unstable_cache)
  and [connection](https://nextjs.org/docs/app/api-reference/functions/connection).
  `use cache` is preferred for apps enabling Cache Components; this stage preserves
  the app's existing caching mode and supported Data Cache API.
- [Vercel Cache-Control](https://vercel.com/docs/caching/cache-control-headers) and
  [cache response headers](https://vercel.com/docs/headers/response-headers).
- [Vercel excludes Vary: Cookie from CDN caching](https://vercel.com/changelog/vary-cookie-responses-no-longer-cached).

Account-specific CDN behavior/retention still requires preview measurements.
