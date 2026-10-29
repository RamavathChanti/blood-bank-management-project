# Surge, priority and cost

Checked **2026-10-29 (Asia/Calcutta)**. Teaching model, not clinical software.

Open **Operations → Surge Lab** at `/surge-lab`. The page has three distinct
surfaces: an interactive browser queue, retained measurements from actual local
services, and an estimated monthly cost panel. None performs a live load test.
No real donors, patient data, cloud resource changes or external notifications
are involved.

## Controlled scenario and stop/reset

The browser model admits 4–20 synthetic jobs, with one or two executing slots.
The final two jobs are critical and arrive after an urgent backlog. Run with
priority off, reset, then run with it on. Critical jobs overtake waiting work;
the first executing jobs finish uninterrupted. The 800 ms service duration and
100 ms ticks are model assumptions. Completed steps are not fulfilled blood
requests. Stop freezes the model and preserves unfinished jobs. Reset clears
only that browser model. Replays are deterministic and make no registry calls.

`src/core/surge.ts` holds the guardrails and the production queue policy. The
20-request ceiling is a conservative project bound; the two-step policy is
below Inngest's published five-step free allowance. Remaining account usage is
unknown: a small burst still requires a quota check before any hosted exercise.
The bound does not enforce the Atlas operations/second limit.

## Actual supported queue behavior

The production emergency function uses an environment-scoped constant
`"pulsegrid-atlas"` key with limit 2 and a per-request function key with limit 1.
Its CEL priority expression is
`event.data.input.urgency == 'CRITICAL' ? 120 : 0`.

Priority adjusts queue age within that function; it does not preempt executing
steps, create capacity, promise a start time, or guarantee priority over other
functions. Ordering without priority is best effort and can be affected by
scheduler fairness/retries. Durable waits release executing capacity. See the
official [concurrency](https://www.inngest.com/docs/durable-execution/flow-control/concurrency)
and [priority](https://www.inngest.com/docs/durable-execution/flow-control/priority)
guides. No homegrown queue is used in the service rehearsal.

The same environment key and limit now cover emergency, signal, donor-push,
forecast and audit steps. Push/forecast/audit retain an additional per-function
one-step limit. Previously the same environment key had inconsistent limits
across these functions. The shared guard does not cover Atlas access
from APIs, public reads, separate environments or unrelated processes.
One step can issue many commands. A five-connection MongoClient pool is per
process; additional function processes can create additional pools. Neither
setting is a global operations/second limiter.

## Replay the measured local service experiment

Use Node 24 and installed dependencies, from `project/`:

```powershell
npm run surge:rehearse
npm run build
npm run start
```

On this Windows workspace the pinned Node executable is
`.tools/node_modules/node-win-x64/bin/node.exe`; if the shell uses another
version, invoke that executable with `node_modules/vitest/vitest.mjs run
--config vitest.surge.config.mts` and use it for the Next CLI as well.

The rehearsal owns **loopback port 8290**, a random loopback SDK callback port,
and a new temporary MongoDB 8.0.17 replica set. It does not read `.env.local` or
accept an external database target. It uses installed Inngest CLI 1.49.0 and
SDK 4.26.1. Scheduled jobs remain disabled. On normal completion, including
assertion failure, teardown stops the owned services and removes the temporary
database through mongodb-memory-server. No live database reset is provided.

The script runs three eight-event queue probes, an eight-event cross-function
shared-key check, then twelve production
emergencies. Each queue probe holds its first executing slots while an urgent
backlog and two later critical events are ingested. It releases those slots,
issues one observed MongoDB ping and injects 800 ms of work per step. This
test-only adapter is never registered at `/api/inngest` in production. Its
priority expression is the production expression. Serial, two-slot, and
two-slot-with-priority cases use the real provider scheduler. The test checks
peak executing work and that both later critical probes start immediately
after the executing blockers in the prioritized case.

The cross-function check proves that two distinct functions sharing the actual
environment policy have at most two executing steps in total, rather than two
each. All eight acknowledgements drain before the production burst begins.

The correctness burst uses the production emergency HTTP handler with an
injected synthetic hospital principal, and the actual orchestration/signal
functions against strict database validators, unique indexes and transactions.
It retains twelve 202 acknowledgements/provider event IDs, contends for four
screened units, verifies four unique owners and zero available stock, replays
all twelve intake payloads, then sends four explicit cancellations and eight
escalations. It reconciles every ID and verifies released reservations, four
available units, matching stock/request counters, zero transfusions, and zero
duplicate unit allocations. Cancellation/escalation is never called fulfilment.
Those authorized signals are the real workflow drain path; browser Reset
cannot cancel an acknowledged workflow.

There are 68 event submissions total: 32 probes, 12 new requests, 12 identical
intake replays and 12 close signals, plus bounded workflow-generated events.
No continuous or unbounded generator is installed. The three comparisons plus
the correctness checks must all pass before new report files are written.

Outputs:

- `_ai_context/artifacts/stage-13-surge-local.json` retains synthetic IDs,
  provider acknowledgements, actual start/finish timestamps and reconciliation.
- `src/data/surge-evidence.json` contains the same sanitized record for the page.
  Signed receipt tokens are excluded. Rebuild to publish updated measurements.
- Use Vitest's JSON reporter to retain a separate pass/fail report.

Stop and reset for normal rehearsal: let the bounded run drain and exit; replay
starts a fresh temporary database and fresh provider service. If an operator
forcibly terminates the process, stop only the owned CLI/callback/database
processes before rerunning; do not assume forced termination ran teardown or
cancelled durable work. This isolated runner never continues against Atlas.

## Metric definitions and limitations

The page labels each metric's basis:

| Metric | Measured basis |
|---|---|
| Callback invocations | Observed POST requests to the local SDK adapter; retries/checkpointing can change counts; not a Vercel invoice |
| Database commands | Driver `commandStarted` pings from the queue probe; production workload operations and Atlas opscounter are unavailable |
| Peak executing | Concurrent probe step bodies, with injected work |
| Pending before release | Acknowledged probe IDs minus observed started IDs before any completion; not provider queue depth |
| Throughput | Eight probe completions divided by wall time from hold release through observing final completion, including polling delay |
| p95 latency | Nearest rank of enqueue-before-send to recorded step completion; includes ingress, queue, initial hold and work |
| Critical p95 | Same definition over the two critical samples; sample size is explicitly small |
| Production outcomes | Materialized records reconciled against the supplied acknowledged cohort |

Real provider queue depth, Vercel instance count/CPU scaling, Atlas operations
per second and account billing deltas are null/unavailable. A local ping is
not equivalent to Atlas operations, document work or paid capacity. Single-run
comparison results describe this host and injected workload; they establish no
statistical latency guarantee. Priority can improve critical latency while
increasing urgent/global latency; it does not improve total capacity.

## Dated cost and limits configuration

`src/core/cost-limits.ts` is the single dated source for vendor numbers and
assumptions. Currency is USD; no exchange rate, tax or actual bill is invented.

Official references checked 2026-10-29:

- [Inngest pricing](https://www.inngest.com/pricing): Free includes 50,000
  executions/month, five concurrent steps, 500,000 events and 100,000 queued
  items. Executions count a function run and its steps, not just one per
  request. Free execution stops at quota; Pro starts at $99/month with 1M
  executions. Retries and additional workflow paths need measured budgeting.
- [Atlas limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/):
  100 read/write operations/second, 500 connections and approximately 512 MB
  including indexes. Excess throughput can be throttled. The local test does
  not measure that throttle. [Atlas pricing](https://www.mongodb.com/pricing)
  advertises Dedicated starting at $56.94/month; region/configuration and
  storage/backup/network usage require a specific quote.
- [Vercel pricing](https://vercel.com/pricing): Pro starts at $20/developer/month;
  published compute starting rates are $0.128 CPU-hour, $0.0106 GB-hour and
  $0.60/million invocations. Hobby includes 1M invocations, four CPU hours and
  360 GB-hours. These are separate limits.
  [Hobby eligibility](https://vercel.com/docs/plans/hobby) is personal,
  non-commercial use; exceeding allowances can interrupt the demo.
- [Ably pricing](https://ably.com/pricing): optional, not implemented here. Free
  has 200 concurrent connections and 6M messages/month. Standard base is
  $29/month plus usage: $2.50/million messages and $1/million connection or
  channel minutes. Fan-out and time connected affect usage; 300 simultaneous
  banks exceed 200 connections before hospital/donor screens are counted.
- [Clerk pricing](https://clerk.com/pricing): 50,000 monthly retained users and
  100 monthly retained organizations on the free allowance. The app's current
  metadata-based tenants are not Clerk organizations. Mapping each bank to a
  retained Clerk organization changes the cost and needs its own estimate.

Default scenario: 300 banks, 1,000 requests/day, 30 days, 30 executions/request,
35 workflow/API invocations/request, 200 DB commands/request, one bank screen
per bank active eight hours/day polling every 30 seconds; one developer.
CPU is assumed at 20 ms per invocation and wall time at 200 ms with 1 GB memory.
These workload inputs are estimates, independent of the eight-job ping probe.
Users can vary execution count and polling interval on the page.

This estimates **30,000 requests, 900,000 executions and 9,690,000 invocations**
per month, including **8,640,000 polling calls**. At that rate the free
execution allowance lasts about **1.67 days**. Gross compute at starting rates
is shown separately before credits/allowances. The paid **base starting floor
is $175.94/month**, combining one Vercel Pro seat, starting Atlas Dedicated and
Inngest Pro. Optional Ably adds $29 base plus usage. The floor is not a total
bill or a plan recommendation for 300 operating blood banks. It excludes
region-specific pricing, storage/egress growth, taxes, audit/forecast schedules,
audience traffic, retry amplification, authentication upgrades and overages.
Do not add gross compute to the floor without reconciling each plan's credits.

## Bottleneck and next scaling step

The measured local burst is constrained by the configured executing slots:
acknowledged work waits while slots are occupied. Priority changes service
order. No Atlas limit was reached or measured locally. Under the default
monthly assumptions, Inngest's execution allowance is a likely early limit;
polling alone also exceeds Hobby invocation allowance. Hosted observations,
account usage, audience size and retention may identify a different first
constraint. Banks and daily requests alone do not determine a bill.

Next, reduce polling/wake amplification; collect scoped Atlas opscounter,
query timings, connection counts and provider queue metrics. Keep a small
shared concurrency limit and tune from those measurements. If a rate ceiling
is reached, separately pace/batch operations or add admission control covering
all writers; concurrency alone is insufficient. Evaluate a paid workflow plan
and dedicated database with a region-specific budget before raising slots.
No unlimited elasticity, guaranteed zero cost or clinical readiness is claimed.

## Hosted acceptance still required

Earlier stages' Atlas/Clerk/Vercel provisioning and independent-review gates
remain open. This stage supplies a local service proof, not evidence of hosted
function fleet scaling. To obtain that evidence:

1. Finish the existing dedicated synthetic environment gates; verify current
   account allowances, remaining spend and enabled schedules. Record plan,
   region, signed user/session, build/deployment and pre-run quota snapshots.
2. Use the existing authenticated emergency intake from a synthetic hospital,
   one bounded cohort of at most 12 requests and the production two-slot guard.
   Retain private receipts and provider event/run IDs. Do not publish tokens.
3. Compare one controlled paced intake and one burst with equal work. Inspect
   provider histories for queued critical cases and executing steps. Record
   actual local/API callback counts separately from provider/billed counts.
   Capture Vercel concurrency/instance metrics only if exposed by that account.
4. Stop new submissions immediately on a stop request, unexpected errors or an
   account limit. Track uncertain sends with their original idempotency keys.
   Drain every acknowledged ID through existing cancellation/escalation or
   handover/use APIs, preserving issued stock for review. Never reset by deleting
   acknowledged requests or allocations. Use Vital Signs reconciliation.
5. Independently compare available-unit counts with stock buckets, unique unit
   allocations and request counters. Retain fulfilled/escalated/cancelled/failed
   counts separately, unresolved IDs and observed latency percentiles.
6. Capture Atlas opscounter, provider backlog, Vercel usage and invoice/quota
   deltas if available; otherwise leave unavailable. Reconcile scheduled jobs
   and other traffic before attributing usage. Record actual evidence/reviewer.

This account exercise remains unverified; the source plan's automatic fleet
scaling and fixed free-database-ceiling narrative must not be presented as a
hosted measurement until those observations exist.
