# Stage 14 visual and intelligence extras

Checked **2026-10-29, Asia/Calcutta**. Teaching model, not clinical software.
All records, sensor readings, donor locations and requests must be synthetic.
No account resource, deployment, paid experiment, external message or Git action
is created by these features or local checks.

## Replay the selected demonstrations

1. `/cold-room`: inspect three storage environments and enable the React Three
   Fiber scene. Choose PRBC under Synthetic fault and advance the feed. A second
   sample produces no duplicate quarantine. Restore No fault and advance: units
   stay quarantined. Reset affects only this browser fixture. The table/select
   provide the same information without WebGL or a pointing device. Rendering
   is on demand, DPR is capped at 1.5, geometry is bounded and graphics failure
   preserves the HTML view. No external texture, tile or sensor is fetched.
2. `/match-lab`: change donor, recipient and component; inspect antigen/antibody
   explanations. Pause the reaction or enable OS reduced motion. Bombay is an
   isolated teaching case, never a ninth registry group or matchable phenotype.
3. `/camp-planner`: use the seven-day snapshot so newly eligible donors outside
   baseline appointments appear. Edit invitations, radius and turnout; inspect
   ranked sites and labelled donor-density insets. `/waste-lab` uses the same
   planner at 25 km, base turnout 0.65 and its editable weekly invitation cap.
   Exploratory radius/turnout changes here do not change that run. No contact
   or registry write occurs.
4. `/intelligence`: the default offline dictionary is **not AI**. Try
   `O- PRBC 2 units critical within 2 hours`,
   `A+ PRBC 2 यूनिट तुरंत 2 घंटे में`, and
   `B+ platelets 3 units jaldi 4 ghante mein`. It recognizes explicit tokens,
   not negation or general natural-language context. Edit every field and check
   review before confirming. Field changes clear confirmation. In this lab,
   confirmation never submits a request.
5. Signed-in Code Red → Durable registry: the same panel copies a confirmed
   draft to the existing form. The operator separately presses Queue emergency.
   Existing server validation, membership, idempotency and uncertain-ack retry
   remain authoritative. Extraction has no workflow or database-write tool.
6. Use the read-only ops copilot's SHORTAGES, UNKNOWN_HISTORY and TRANSFER_SUMMARY
   templates. Inspect source, snapshot and JSON results. The lab uses labelled
   synthetic aggregates; State registry uses authorized retained admin forecasts.
   This deterministic template assistant does **not** use an LLM. No raw donor
   records, arbitrary pipeline, external AI transmission or mutation is exposed.
7. Enable Demo Director. Buttons or Alt+Shift+1–9 select scenes. Hotkeys ignore
   form/contenteditable fields, composition and repeat; navigation never submits,
   seeds or resets registry records. Code Red sound starts off and plays one
   explicit short Web Audio cue. In-transit arcs animate dash particles; reduced
   motion makes them static.

## Synthetic bank watchdog

After Atlas/Clerk/audit setup, use a dedicated synthetic database. Set server-only
`COLD_CHAIN_DEMO_ENABLED=1` and rerun the registry schema initializer to accept
`QUARANTINED`. Sign in as a bank and use its Synthetic cold-chain watchdog:

```text
POST /api/registry/banks/{ownBankId}/cold-chain
{ "key": "unique-retry-key", "component": "PRBC", "fault": true }
```

The server generates a sample from its clock and bounded scenario. It accepts
no raw sensor temperature, unit list or tenant. In-range samples retain a
replayable receipt without changing units. A breach quarantines the bank's
affected component units through the existing Operations transaction. At most
200 units are allowed; a 201-record probe rejects larger batches atomically.
The probe uses one batch to avoid the driver's transaction/getMore timeout issue.

Quarantine sets storage FAILED, removes reservation/handover/preparation data,
releases active/issued allocations, reconciles request/stock counters, and appends
ordered hash-chain events plus current-state HMAC signatures. Already terminal
or quarantined units do not change. Previous allocation/request IDs and the
synthetic sample note remain in the event. No automatic re-release exists.
Staff can explicitly discard reviewed quarantine; normal expiry maintenance can
expire it. Both append normal signed lifecycle events and never restore stock.
Requests losing issued stock become unmet again; this is not delivery. Role,
current tenant membership, same-origin JSON and audit integrity use the existing
server checks. Failed event append rolls back the entire batch and receipt.

The UI retains the original retry key while its tab remains open. After a reload
inspect audit/unit history before starting another sample; pending watchdog
payloads are not persisted. Local tests use a temporary replica set and injected
principals, never a production auth bypass.

Storage illustrates PRBC 2–6 °C, platelets 20–24 °C with agitation, FFP at or below
−25 °C. A single simulated breach quarantines immediately: there is no validated
duration threshold, equipment certification or transport/thawing policy. Earlier
project shelf lives remain 35/42 days, five days and one calendar year; the cited
platelet product's shelf life differs. See [Lifeblood storage and handling](https://www.lifeblood.com.au/health-professionals/products/storage-and-handling).
The optional Bombay case follows [Lifeblood's anti-H explanation](https://www.lifeblood.com.au/news-and-stories/health-professionals-news/one-for-all).
RhD-negative does not imply pre-existing anti-D. Animation is conceptual.

## Camp model and changed results

Candidate sites are synthetic banks. The planner checks donor eligibility at
the injected clock, excludes baseline appointments/prior invitations and scores
nearby donors by three-day deficit × distance-adjusted turnout probability.
Per-group scarcity uses the largest component deficit, avoiding triple counting
one multi-product donation. Missing forecast history has zero weight. Greedy
selection obeys one total capacity and donor deduplication across sites; it is
not a global facility-location optimum. Expected arrivals sum probabilities;
monthly realization uses seeded Bernoulli trials followed by six-hour screening.
Invited non-attendees are not reinvited that month. Exogenous demand and baseline
appointments remain byte-identical across policies. Stage 10's previous camp
measurements describe immediate attendance; use the Stage 14 monthly report for
this implementation.

## Optional AI setup and remaining acceptance

Set server-only `AI_INTAKE_ENABLED=1`, `OPENAI_API_KEY`, `OPENAI_INTAKE_MODEL`
to an account-available Structured Outputs model. There is no model/price default.
The hospital must have a current parent record. Only synthetic text, clock,
instructions and schema leave the server. No profile, forecast, donor or patient
record is supplied. Provider billing/data handling need operator review before
enablement. No live provider call was made during implementation.

The Responses adapter uses strict `text.format`, `store:false`, 1,000 output
tokens, a 12-second abort deadline and 64 KiB response cap, without tools/retries.
Application validation checks nullable enums, 1–20 units and uncertainty strings.
Human confirmation checks a future UTC deadline within 24 hours. Refusal,
incomplete/invalid output, transport errors and rate limits produce sanitized
errors. No calibrated confidence is claimed. The endpoint has authenticated
access and per-call bounds; add a distributed per-user rate limit and provider
budget before public audience enablement. Implementation follows the
[official OpenAI Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).

Live model evaluation still requires account setup: replay parallel English,
Hindi and Hinglish examples, missing/conflicting fields, negation, routine versus
emergency, dates, injection, refusal, outages and 429. Retain only synthetic input,
validated fields, model ID, latency and discrepancies. Neither extraction nor
confirmation may create an emergency. Dictionary and mock transport tests prove
application boundaries, not a model's semantic accuracy.

## Atlas Charts evaluation: not selected

Existing forecast plots, retained JSON and ops templates cover the demo's
reporting. A second service adds no verified benefit while Atlas provisioning
is pending. No SDK, iframe, unauthenticated link or data source was enabled.

A future pilot needs an aggregate-only source, server/data-source authorization
independent of editable filters, short-lived scoped tokens, expiry/revocation
and cross-tenant denial tests, and current account costs/quotas. See
[embedding options](https://www.mongodb.com/docs/charts/embedding-charts/) and
[authentication providers](https://www.mongodb.com/docs/charts/configure-auth-providers/).
The evaluation is complete; no embedded-chart implementation is claimed.

## Separate infrastructure evaluations: execution deferred

No test account, budget or deployment is provisioned for these optional
experiments. Feasibility review is complete; they remain outside the minimum path.

| Experiment | Setup/cost boundary | Required eventual evidence |
|---|---|---|
| Dedicated failover | Separate synthetic M10+ replica set, test identity, backup, regional quote, stop/delete budget. Include hourly cluster, storage, backups and transfer. | Reconcile acknowledged workload IDs before/during/after supported primary failover; observe recovery, retries, duplicates and audit continuity. No guaranteed recovery time. |
| Mumbai versus US | Matched isolated regional deployments, equal tiers/data/indexes/auth/caching. Quote both clusters/functions, transfer and test duration. | Alternate bounded warm/cold samples; retain p50/p95 and split client-to-function from function-to-DB spans. Loopback pings cannot establish regional latency. |
| Client-side field encryption | Separate fixture/migration, exact driver/library mode, external KMS/key vault, decrypt roles and key-recovery drill. Verify edition/library/KMS costs; no blanket paid-tier assertion. | Prove ciphertext without keys, authorized/denied decrypt, key recovery, supported queries/indexes, schema migration and audit signature/canonicalization behavior. Defer indexed coordinates until supported semantics are established. Existing push-subscription encryption is not CSFLE proof. |

Sources: [Atlas failover requirements](https://www.mongodb.com/docs/atlas/tutorial/test-resilience/test-primary-failover/),
[configuration costs](https://www.mongodb.com/docs/atlas/billing/cluster-configuration-costs/),
[CSFLE modes](https://www.mongodb.com/docs/manual/core/csfle/) and
[limitations](https://www.mongodb.com/docs/manual/core/csfle/reference/limitations/).
No failover, regional latency result or encryption deployment is claimed.

## Local checks

From `project/`, Node 24:

```powershell
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run test:e2e -- tests/e2e/extras.spec.ts tests/e2e/domain.spec.ts tests/e2e/waste-lab.spec.ts tests/e2e/durable-code-red.spec.ts tests/e2e/portal-workflows.spec.ts tests/e2e/scaffold.spec.ts --workers=2
npm run waste:report
```

The headless graphics check enables Chromium software WebGL to exercise an actual
Canvas. Rehearse graphics performance, physical audio and hotkeys on the demo
laptop. Hosted Atlas/Clerk/AI and independent preview review remain separate.
