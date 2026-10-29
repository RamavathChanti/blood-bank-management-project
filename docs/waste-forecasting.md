# Waste reduction and forecasting

`/waste-lab` (Blood Weather in navigation) runs four matched, synthetic 30-day
experiments in a dedicated browser worker. Run locally with `npm run dev` or a
production build. No credentials are needed, and simulation never writes to Atlas.
**Teaching model, not clinical software.**

## Replay

1. Open Blood Weather. Keep seed `monsoon`, the fixed teaching start
   `2026-10-28T03:30:00.000Z`, and the default assumptions.
2. Select **Run matched month**. Change group/component/aggregation while the
   worker runs to demonstrate UI responsiveness. Cancel terminates the worker.
3. Compare the four policies. Inspect the seven-day forecast bands and switch
   bank/district aggregation. Inspect transfer days with the slider.
4. Download the result JSON. Run the same configuration again; the shared event
   checksum, all metrics, transfers and final state checksums must agree.
5. Change the assumed platelet multiplier or camp capacity and run again. The
   **exogenous event checksum stays the same**: assumptions change decisions,
   never the actual future requests or baseline donation outcomes.

`npm run waste:report` emits the complete monthly result, a SHA-256 digest and a
byte-for-byte second-run assertion. It compiles into ignored `.tools/waste-report`
and performs no provider calls. Host runtime is outside the deterministic hash.
The small eight-character checksums in the UI are comparison aids, not security
or audit proofs. Reports and screenshots for this workspace live outside the
project, in `_ai_context/artifacts/stage-10-*`.

## Observation and forecast contracts

Pure functions are in `src/core/forecast.ts`.

- Issue bins are rolling 24-hour intervals in `[cutoff − n days, cutoff)`.
  The default rate window is exactly fourteen days, including observed zero days.
  Explicit bank coverage must span each whole bin. Missing/incomplete bins are
  `null`; a district is observed only when **all** constituent banks are observed.
- Rate = issues / 14; days of supply = ready stock / rate. No fourteen-day
  coverage means `MISSING_HISTORY`. An observed zero rate means `ZERO_DEMAND`;
  no finite days-of-supply number is invented. These states survive JSON/worker
  serialization without Infinity or NaN.
- Ready stock requires AVAILABLE, verified storage, five clear mock screens,
  collection at/before the observation time, future expiry, and absence from
  transit. Reserved, issued, testing, reactive and quarantined stock is excluded.
- Baseline: fourteen-day mean times normalized seven-weekday weights. Days are
  named in IST. Weight mean is normalized to one, so a constant multiplier on
  every weekday does not create extra weekly demand.
- Additive Holt–Winters: weekly period 7, at least 28 **consecutive** observed
  days, default alpha 0.3, beta 0.1, gamma 0.2. Initialization uses two weeks for
  trend and detrends the first week's seasonal indices. Level, trend and seasonal
  updates use the previous level/trend, with nonnegative output clipping.
  Additional baseline weekday weights are not applied again to this model.
- Dengue is an explicit **future scenario** multiplier, default 2, range 1–5,
  applied only to platelets. This is not an estimated epidemiological coefficient
  or a clinical forecast. The monthly truth has a fixed platelet shock independent
  of this assumption; over/under-assumptions can be compared fairly.
- Uncertainty bands are nonnegative heuristic
  `point ± 1.96 × training residual RMSE × sqrt(horizon)` (scaled with the
  scenario). They are not calibrated prediction intervals. Sparse issues can be
  censored by shortages, making both forecasts overconfident or biased low.
- Backtest: 70 complete pre-shock days of synthetic B+ platelet demand, first
  56 for training and final 14 held out. Both models use identical training/test
  data. MAE and RMSE are reported; no MAPE division by zero. The pre-shock test
  deliberately disables future dengue adjustment. Holt–Winters is not assumed
  to beat the baseline; low-count noisy series often favor the simpler model.
- Weather uses available units divided by the average **adjusted forecast**:
  storm below 2 days, watch below 5, clear otherwise. Missing and observed-zero
  history have separate explicit labels. The displayed numerical days of supply
  still uses the trailing historical rate, so the two can differ.

The formulas follow the authors' [additive Holt–Winters description](https://otexts.com/fpp3/holt-winters.html).
The model settings and bands are deliberately documented teaching assumptions.

## Rebalancing and transfer lifecycle

`src/core/rebalancing.ts` builds a capacitated min-cost maximum-flow graph:

```text
source → source-bank capacity → individual unit → destination exact bucket
       → destination-bank capacity → sink
```

Eligible sources are observed surplus, ready units expiring within seven days.
The source keeps FEFO stock expected to be used locally before its expiry.
Destination demand is the ceiling of the next three forecast days less its ready
stock. Transfers remain exact group/component, with daily outbound/inbound limits
of 12 component units **per bank across all buckets**. Unknown history cannot
justify sending or receiving a planned surplus transfer.

Each route uses Haversine straight-line km and the existing teaching estimate
`ceil(2 × km + 5)` minutes. Default maximum route is 180 km. An edge exists only
if arrival is **strictly before** expiry minus the buffer (default six hours).
Cost is `travelMinutes + 60 / (remainingBufferSlackDays + 0.1)`, scaled/rounded
to integer hundredths. Small positive remaining slack is expensive. The optimizer
first maximizes feasible units moved, then minimizes total cost; it does not price
an economic optimum or guarantee an expiry reduction. Routes with any feasible
positive cost can be chosen to fill a deficit.

The solver uses successive shortest augmenting paths with Bellman–Ford and
reverse residual edges. Tests include an independent assignment example in
which greedy routing costs 101 but the correct rerouted solution costs 4.
The network model is consistent with [Google's minimum-cost-flow formulation](https://developers.google.com/optimization/flow/mincostflow).
No OR-Tools runtime dependency was added.

Planning leaves stock at the source. Dispatch checks current readiness, source
ownership, duplicate active transfers and the expiry buffer. IN_TRANSIT units
count at neither bank and cannot match requests. Receipt changes ownership once;
late/expired receipt fails closed. Dispatch/receipt retries are idempotent.
Every policy-day is checked for stock conservation including transit and testing.

The pure planner rejects oversized inputs instead of silently truncating them:
40 banks, 20,000 units, at most 1,000 surplus candidates, and at most 2,500 graph
nodes. This is intentionally bounded teaching/demo optimization.

## Monthly experiment and metrics

`src/core/waste-simulation.ts` uses the Stage 3 four-bank development fixture,
with a deliberate imbalance: 70% of initial component units and most baseline
collections at low-demand bank 4. Demand is concentrated at bank 1. Synthetic
weekly demand, collection times, eligibility and reactive-screen outcomes are
generated **before** any policy runs. No policy consumes the exogenous RNG.
The bounded donor population creates severe shortages; measured fulfilment is
allowed to remain low. This is a waste experiment, not a tuned service-capacity
claim. Stage 3's existing five-minute Control Room simulator remains separate;
its simple arcs are still labelled demonstration transfers.

| Policy | Decision |
|---|---|
| Nearest | Eligible compatible stock, distance then stable unit ID; no expiry ordering |
| FEFO | Compatibility preference/exact-group conservation, nearest bank, FEFO within that bank |
| FEFO + rebalancing | FEFO plus daily optimized surplus transfers |
| Rebalancing + forecast camps | Same, plus weekly deficit-targeted synthetic camps |

All policies use a 30 km local request radius, six-hour use deadline, and units
valid through expected use. Transit can bridge separated regions. Hourly ticks
can delay observation by up to an hour. Full stock match means **issue**, not
handover or transfusion. A match at creation has zero simulated match minutes;
it does not imply instant transportation. Requests unresolved at day 30 are
censored, as is remaining stock.

The camp model has a configurable eight-donation weekly capacity. It chooses
matching-group, eligible, once-only donors within 25 km of forecast deficits,
keeps all baseline appointments intact, creates three component products, and
waits six hours for mock screening. Reactive products are discarded. Acceptance
never creates ready blood. This bounded planner enables the fourth comparison;
it does not implement Stage 13's operational camp organizer or routing UI.

| Metric | Definition |
|---|---|
| Wastage | expired / (initial + all newly collected **component units**) × 100 |
| Fulfilment | fully issued requests / all requests × 100; partials remain unfulfilled |
| Median / p95 match | nearest-rank request creation-to-full-issue minutes, matched requests only |
| Units saved | same ID expired under FEFO but issued under this policy |
| Extra expiries | same ID issued under FEFO but expired under this policy |
| Net expiry reduction | FEFO expired count − policy expired count, including extra camp units |
| O− non-O− issues | PRBC O− issued to a non-O− recipient; not all are avoidable |
| Avoidable O− use | above, with an eligible exact-group alternative at that decision |
| Transfer unit-km | sum of each departed unit's straight-line transfer km; not vehicle km |

Camp products increase the denominator; lower wastage percentage can coexist
with more absolute expiries. Remaining inventory and transfers are never counted
as “saved.” The report retains unit identities so the definition is auditable.

The separate donor experiment uses 1,000 seeded trials, 100 independent donors,
acceptance probability 0.3, and a target of two acceptances. A 95%-target wave
contains 14 donors, with at most three waves and three-minute escalation waits.
Alert-everyone uses the **same per-donor outcomes**. Alert counts, success and
escalation delay are measured. Geography, fatigue, quiet hours and screened-stock
delay are explicitly absent here; Stage 4 covers the richer emergency rules.

## Scheduled registry jobs

The scheduled path analyzes the synthetic **registry**, separate from browser
experiments. `forecastMaintenance` is served with existing Inngest functions.
`FORECAST_JOBS_ENABLED=0` is the default; `1` adds
`TZ=Asia/Kolkata 0 2 * * *` (02:00 IST daily). The signed manual event
`pulsegrid/forecast.requested` exercises exactly the same function locally or in
the dedicated cloud demo. The provider event timestamp sets the IST day;
caller-supplied data cannot change it. Timezone syntax was checked against
[Inngest schedules](https://www.inngest.com/docs/durable-execution/guides-and-advanced/events-and-triggers/schedules-and-delayed-starts).

The job uses a snapshot transaction, bounded queries, a shared 35-second read
abort deadline, 10-second initial query budgets, and separate five-second receipt
write and commit budgets.
It joins ISSUE events to units, rejects duplicate/orphan history, and adds the
`forecast_issues` index. Driver 7's transaction-level CSOT/getMore interaction
was reproduced in integration tests; the shared AbortSignal preserves a total
read budget without that failure.

Registry seed prehistory was **never imported**. Coverage starts at the recorded
registry initialization (or an explicit bank `createdAt`), so an early deployment
correctly shows missing history for fourteen days. Non-seeded banks without
coverage metadata remain unknown. Issue bins end at the IST midnight cutoff;
stock is the current transaction snapshot, with expiry checks at the immutable
trigger timestamp. It is not an as-of-midnight stock reconstruction.

One `operations` receipt per `forecast-v1-<state>-<IST day>` stores the result and
an input SHA-256. Concurrent deliveries and retries return the committed result,
including when inventory later changes. Receipts expire after 35 days, using the
existing TTL index; the admin endpoint excludes logically expired results even
before physical deletion. Idempotency is guaranteed within that retention window.
No units, stock counters, allocations, lifecycle events or donors are mutated.
The job writes **PLANNED proposals**, not executed live transfers or camps;
staff need fresh transactional dispatch checks before acting.

State admins can select **Refresh scheduled forecast** in `/registry` to read
`GET /api/registry/state/forecast`. This is private/no-store and denies other
roles. No new public aggregate endpoint exposes the proposal or its unit IDs.

### Rehearse and measure quota

1. Apply the schema upgrade with the existing guarded registry tooling in the
   dedicated dev/demo database; verify `unitEvents.forecast_issues` exists.
2. Use `INNGEST_DEV=1` locally, start the app and `npm run workflow:dev`, and send
   `pulsegrid/forecast.requested` with `{}` using the local Inngest dashboard.
   Re-send with a different event ID on the same IST day. Inspect the single
   receipt and the authorized state-admin view. No audience messages are sent.
3. `npm run test:integration` verifies actual replica-set concurrency, no stock
   mutations, coverage, TTL, role denials, result bytes and budget overflow.
   `npm run test:workflow` triggers the production function through the actual
   local Inngest CLI and records its receipt/result size. It does not certify a
   hosted cron firing or a billing-dashboard counter.
4. One function run plus one `step.run` = **2 executions** without retries;
   31 daily slots = **62 executions**. Two configured retries can increase this;
   manual invocations also consume executions even if the receipt already exists.
   A no-retry invocation repeated daily for 31 days is a budget calculation, not
   observed billing usage. Bound inputs: 40 banks, 20,000 units, 50,000 ISSUE
   events; BSON result cap 3 MiB. Durable step state returns a small receipt.
5. Before enabling a hosted cron, record the actual account/workspace remaining
   allowance and other workloads in the Inngest dashboard, run one signed manual
   rehearsal twice, then capture execution/event deltas, Vercel function duration,
   Atlas query/index and retained BSON usage. Observe a real 02:00 IST cron and
   retry once on a preview. Store exact URL/revision/run IDs and dated screenshots.

On 2026-10-29 the official [Inngest limits](https://www.inngest.com/docs/durable-execution/limits)
listed Free allowances of 50,000 executions/month, a 4 MiB step return, and 1,000
steps/function. This function uses one durable step and returns a small receipt.
The page also notes a checkpoint execution counting correction effective
2026-10-20; use actual account counters, not an inferred entitlement. No hosted
quota measurement or account access is claimed by the local checks. Cloud
verification remains open alongside the earlier Atlas/Clerk/Vercel gates.

## Verification commands

```text
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:workflow
npm run build
npm run test:e2e
npm run waste:report
```

The normal Node 24 runtime is pinned in `.nvmrc`. In this restricted workspace,
the existing `.tools/node_modules/node-win-x64/bin/node.exe` runs equivalent
direct CLIs when npm cannot launch its nested shell. Browser checks use the
production build and both desktop and phone Chromium viewports.
