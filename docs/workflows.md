# Stage 7: durable emergency workflows

Checked 2026-10-29 with **Inngest SDK 4.26.1**, **CLI 1.49.0**, Node 24 and MongoDB 8.0.17. All records are synthetic. **Teaching model, not clinical software.** Local service execution and database tests are recorded in [Stage 7 evidence](../../_ai_context/STAGE_7_EVIDENCE.md). Atlas, signed Clerk sessions, Vercel deployment and Inngest Cloud acceptance are separate, still-open gates.

## Configure local development

1. Complete [registry setup](registry.md) for a dedicated development/demo replica set and server-managed Clerk hospital, bank and donor memberships. The simulator needs none of these accounts.
2. With the application stopped, use the setup database credential to run `npm run registry -- upgrade --confirm=pulsegrid_dev`, then `npm run registry -- verify`. Upgrade adds the `workflowSignals` collection/index and preserves existing records and the original seed hash. Never reset an established database just to install the schema.
3. Use the runtime credential in `.env.local`. Set `INNGEST_DEV=1`. No event/signing keys are needed for the local Dev Server. The receipt secret has a local-only fallback; use a separate random `WORKFLOW_RECEIPT_SECRET` of at least 32 characters for stable local receipts if desired. Keep the file ignored.
4. Run `npm run dev` in one terminal and `npm run workflow:dev` in another. Open `http://localhost:8288`; confirm **emergency-orchestration-v1** and **emergency-signals-v1** are synced from `/api/inngest`. Match localhost hostnames consistently for browser Origin checks.
5. Sign into `/code-red`, choose **Durable registry**, and queue a request using an assigned hospital account. Inspect the request ID, acknowledged event IDs, workflow/run ID and the Inngest timeline. **Local simulator** retains its own Stage 4 fixtures and clock and never sends these events.

The pinned CLI postinstall downloads the platform binary. Its Dev Server uses port 8288 and is a trusted local tool; do not expose it publicly. `npm run test:workflow` needs this port free and starts/stops an isolated service and temporary database itself. Do not run that test alongside a manually running Dev Server.

## Configure Vercel and Inngest Cloud

1. Provision the existing Stage 5 dedicated Atlas environment and Clerk memberships first. Record the actual region, current runtime permissions, schema verification and transaction probe. Use distinct local/preview/demo databases and credentials.
2. Connect the intended Vercel project to the [official Inngest Vercel integration](https://www.inngest.com/docs/durable-execution/deploying-functions/platforms/vercel). Select the matching Inngest environment. Its server-only `INNGEST_EVENT_KEY` sends to that environment and `INNGEST_SIGNING_KEY` authenticates worker callbacks. Configure both in the intended Vercel environment; no values belong in source or `NEXT_PUBLIC_*` variables.
3. Set a random server-only `WORKFLOW_RECEIPT_SECRET` with at least 32 characters, stable across redeploys. It signs application acknowledgements, independently of Inngest signing-key rotation. Replacing it invalidates old receipt tokens; existing authorized hospital/Atlas records remain readable. Set `INNGEST_DEV=0` or omit it on Vercel. The client explicitly forces cloud mode on Vercel even if that variable is misconfigured, and intake rejects the misconfiguration.
4. Optionally set `WORKFLOW_DASHBOARD_URL` to the exact environment dashboard URL copied from Inngest, e.g. `https://app.inngest.com/env/production`. Code Red links there and displays the precise run/event IDs for lookup. This link requires your Inngest dashboard access; it grants no dashboard privileges. Local mode links to the Dev Server's Runs page.
5. Deploy and sync `/api/inngest`. This Node route exports GET/POST/PUT and `maxDuration=60`. The SDK checkpoint budget is 40 seconds, leaving time to checkpoint before the host limit. Clerk middleware skips this one route; the Inngest SDK checks its signing key. Browser emergency APIs retain their own Clerk/session authorization. Inspect an unsigned cloud-mode callback: it must fail; never remove signing to solve a deployment issue.
6. If Vercel Deployment Protection blocks callbacks, configure the integration's automation bypass using the account's supported controls. Keep protection changes and secret values out of source. Do not silently disable project access controls. Verify sync and signed callback execution from the dashboard, not just a GET liveness response.
7. Recheck the actual plan's priority, concurrency and execution limits. Function configuration uses supported v4 `priority.run`, eight retries and shared environment concurrency **2** for Atlas work, plus per-function/per-request concurrency **1**. Priority is critical **120** versus urgent **0**; it is queue ordering, not preemption or a guarantee of clinical response time. No measured cloud-priority claim is made by local tests.

No deployment, credential, service-account, networking or Git change is performed by this runbook.

## Runtime database permissions

Extend the [Stage 6 runtime role](reservations.md#setup-and-migration) using the setup account:

| Database action | Collections |
|---|---|
| FIND | banks, hospitals, donors, units, unitEvents, requests, allocations, stock, alerts, operations, workflowSignals |
| INSERT | units, unitEvents, requests, allocations, stock, alerts, operations, workflowSignals |
| UPDATE | banks, hospitals, donors, units, requests, allocations, stock, alerts, workflowSignals |

Do not grant runtime schema/index administration, deletes, `_registryMeta` access, or updates to append-only `unitEvents`/`operations`. The new donor update increments an alert revision inside a transaction, serializing competing requests' fatigue decisions. No extra real donor details or push/email subscriptions are introduced.

## Acceptance, identity and HTTP API

New URGENT/CRITICAL requests must use the durable intake. The older registry request-creation endpoint accepts only ROUTINE work and returns `USE_DURABLE_EMERGENCY_INTAKE` for a new emergency, so an alternate form cannot bypass event-service acknowledgement. Hospital's manual form creates routine work and points emergencies to Code Red. Existing Stage 6 requests/receipts remain readable and retain their manual lifecycle; complete or cancel those synthetic fixtures before rehearsing the new durable journey.

All browser POSTs require JSON, the exact same-origin Origin header and at most 8 KiB; queries and extra input fields are rejected. Tenant/state/institution ownership comes from current Clerk server metadata, never from the body. A state administrator can inspect status but cannot impersonate hospital/bank/donor actions. Responses are private/no-store.

`POST /api/emergencies` accepts:

```json
{
  "key": "client-generated-stable-key",
  "group": "O-",
  "component": "PRBC",
  "quantity": 1,
  "urgency": "CRITICAL",
  "expectedTransfusionAt": "2026-10-29T15:00:00.000Z"
}
```

Use your actual future UTC deadline, strictly within 24 hours. Quantity is 1–20; urgency is URGENT or CRITICAL. No hospital ID, patient input or operator-selected clock is accepted. Request IDs derive from a canonical hash of state, tenant, hospital and the complete normalized input, including the key. Retries of the exact payload keep one ID. Changing the payload represents a distinct request; the browser freezes an uncertain payload and its key for retry instead of editing it.

The route authenticates and validates, then **awaits `inngest.send` without first accessing MongoDB**. Only a nonempty service acknowledgement produces HTTP 202 with `accepted:true`, the stable request ID, event IDs, `statusUrl`, and a signed `receipt`. This means acknowledged/queued, not created, matched or fulfilled. An unavailable/uncertain send returns 503 with `ACKNOWLEDGEMENT_UNKNOWN`, `accepted:false` (no confirmed acknowledgement), stable request ID and a same-payload retry instruction. The provider might already have ingested an event when the HTTP response is lost; retry the same payload. Do not create a fresh key in response to uncertainty.

`GET /api/emergencies/:requestId` reads authorized status, trace and that hospital's allocation IDs. Send the returned receipt in the `x-emergency-receipt` header. Before Atlas creation, a valid receipt returns 202 `ACKNOWLEDGED_PENDING`. During a database outage it returns 503 `ACKNOWLEDGED_STATUS_UNAVAILABLE` while retaining `accepted:true` and the acknowledged IDs. Unknown IDs without a valid receipt return the same denial as inaccessible IDs. A receipt never bypasses Clerk authentication or cross-tenant authorization. After Atlas creation, own-hospital status can also be read without the receipt.

The first durable `persist-request` step revalidates the trusted event, checks the Atlas hospital membership and upserts exactly one request. A missing/reassigned hospital or a deadline already passed in the queue produces an explicit escalated record. Transient database failures remain retriable. If even the failure callback cannot access Atlas, the receipt and Inngest event/run history remain the evidence; the app does not invent a terminal database status.

## Typed events and human actions

Event schemas are defined in `src/inngest/events.ts`; runtime validation occurs at HTTP and worker boundaries. Event IDs include their type/purpose. Service-level event/function deduplication has a **24-hour** window; persistent request/operation/alert/signal records provide application idempotency beyond that window.

| HTTP suffix after `/api/emergencies/:requestId/` | Typed event | Additional body fields beyond `key` | Authorized actor |
|---|---|---|---|
| `donor.reply` | `pulsegrid/donor.reply` | `donorId`, `reply`: ACCEPTED or DECLINED | That live donor, in this request's recorded wave |
| `stock.ready` | `pulsegrid/stock.ready` | `unitId` | Owning bank; stock must already be AVAILABLE, screened and stored |
| `dispatch.approved` | `pulsegrid/dispatch.approved` | `unitId`, `allocationId`, boolean `preparationConfirmed` | Owning bank; exact active allocation and unexpired lease |
| `handover` | `pulsegrid/handover` | `unitId`, `allocationId` | Request hospital |
| `synthetic-use` | `pulsegrid/synthetic-use` | `unitId`, `allocationId` | Request hospital; handover is required before use |
| `cancel` | `pulsegrid/emergency.cancel` | None | Request hospital |
| `escalate` | `pulsegrid/emergency.escalate` | None | Request hospital |

The creation event is `pulsegrid/emergency.created`. Signal processing durably stores `workflowSignals`, applies authorized side effects, and sends `pulsegrid/emergency.changed` using `step.sendEvent`. The orchestration waits on that event with `match: "data.requestId"`. Outbound escalation notices use the separately typed `pulsegrid/emergency.escalated` event. Notification consumers beyond durable in-app alerts remain Stage 9.

Signal 202 means queued, not applied. `workflowSignals` records APPLIED/REJECTED and a fixed rejection reason; state admins can inspect these through the existing scoped registry reader. Hospital cancellation/escalation can queue while Atlas is unavailable when accompanied by its signed intake receipt; the worker rechecks membership before applying it. Other actor/unit/donor actions need a database authorization check before acknowledgement as well as before application.

## Workflow and safety rules

- Named durable steps cover persistence, stock search, reconciliation/readiness, atomic reservations, donor waves, dispatch, handover/readiness, waits and closure. All I/O, clock reads and random IDs occur inside steps. Long waits use `step.waitForEvent`; no Vercel invocation sleeps for a donor or delivery.
- Search/reserve reuses Stage 6's bounded 250 km / up to 100 banks / 500 stock candidates, compatibility preference and FEFO gates. It is not proof of statewide exhaustion or a routed travel estimate. Each reservation commits unit ownership, the unique allocation slot, counters, event and operation receipt together.
- Shortage opens 5/10/25 km waves around the nearest collection bank, with three-minute response windows. Eligible mock donors are ranked using Stage 4 rules; wave size uses the documented 0.23 independent-acceptance model and 0.95 target. The target can be unmet for a small population. Quiet hours, the rolling 30-day four-alert cap, 24-hour cooldown, opt-out, live audience expiry and per-request deduplication are checked before creating alerts. Donor profiles are bounded at 5,000 and recent alerts at 20,000; exceeding the latter fails closed for inspection.
- **Notification dispatch is a transactionally persisted IN_APP alert**, unique per request/donor. Donor portal shows it after refresh. No push, email, real donor contact or automatic collection is claimed. ACCEPTED/DECLINED uses the first valid reply for that wave; a late reply does not become an acceptance.
- A donor acceptance creates no blood unit or allocation. Staff separately collect, test all five screens, verify storage and make stock available through Bank. `stock.ready` merely wakes a search and cannot bypass those gates. A failed/insufficient collection remains unmet demand.
- Dispatch requires the full quantity, every exact current ownership slot, readiness/compatibility/deadline/lease checks, and explicit bank approval. FFP additionally needs preparation confirmation. The entire batch issues in one transaction. A failed check issues none of the pending batch. Regular portal ISSUE/cancel calls reject workflow-managed requests with instructions to use the durable actions; ordinary Stage 6 requests keep their existing behavior.
- A persisted early handover/use waits for its exact allocation to become issued/handed over. Duplicate signal and operation receipts suppress duplicate lifecycle effects. Stale approval for a released/reacquired allocation is rejected. Lease maintenance runs during reconciliation; after a ten-minute lease expires, a new allocation ID and bank approval are required.
- Signals are persisted before waking the workflow. An event arriving just before a wait registers may miss that wake; the workflow checks authoritative state again after a **maximum five-minute fallback wait**, bounded by the wave/request deadline. Persisted early replies remain available independently of Inngest's event matching window. This is bounded reconciliation, not a promise of instant update.
- Exhausted waves with no accepted donors, an unmet deadline, missing handover/use, explicit escalation and the wake budget produce explicit escalation. Partial RESERVED stock is released in the closure transaction. Cancellation before dispatch releases it; issued/used stock remains owned and goes to manual review, never back into available inventory. Completion requires the full quantity's explicit synthetic-use confirmation after handover.
- The loop allows at most 330 rounds and at most three durable operations per nonterminal round, plus setup/closure (under 1,000 total). A terminal exhaustion round can add one extra operation in place of its wait. The wake cap is explicit protective back-pressure; repeated events may produce budget escalation before a long deadline. Eight failed retries mark an existing workflow FAILED for dashboard inspection; a persistent outage can also prevent that write. Do not equate FAILED/ESCALATED with fulfilled or lost.

## Code Red and replay

The Durable registry view uses real authenticated emergency APIs. Intake payload/receipt/ID live in sessionStorage under the signed-in user ID; account changes remount the view. An uncertain creation/signal reuses the same body/key. Explicit 4xx creation rejection reopens editing. Status polls every five seconds while the tab is visible, up to ten minutes per status phase, then manual refresh remains available. This is the Stage 7 request view; Stage 8 cross-tab realtime/public caching is not claimed. The run history link and exact run/event IDs let an authorized operator locate the matching Inngest run.

For the minimum stock journey, queue as Hospital, copy the allocation IDs from status or Bank's scoped allocations, approve each through Code Red while signed into the owning Bank, then confirm handover and synthetic use as Hospital. For the shortage journey, open Donor's private alerts, reply as the assigned donor, and separately complete Bank collection/screening before sending stock-ready and approval. Refresh current allocation IDs after any lease expires.

```powershell
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:workflow
npm run build
npm run test:e2e
```

`test:integration` uses a real temporary replica set with injected identities and a replay journal/clock for deterministic donor waves, exhaustion, lost step responses, cancellation, correlation and expiry. `test:workflow` serves the **production SDK functions** through its Node HTTP adapter to the actual local Inngest CLI, tests HTTP callback retry, duplicate delivery, stock completion, donor/readiness recovery, cancellation and durable timeout, and retains sanitized run/event IDs. The browser harness renders the actual Durable Code Red component with explicit HTTP fixtures outside Next; it adds no authentication bypass to production. These checks do not establish a deployed Clerk-to-Atlas-to-Inngest journey.

Before closing the Stage 7 cloud gate, retain the deployed preview URL, actual environment/signed callback sync, real Clerk Hospital/Bank/Donor sessions, actual Atlas schema/permissions/transaction verification, and six scenario results: stock success, donor-wave success, exhausted waves, duplicate delivery, a retried failed step, and cancellation. Record request/event/run IDs, uniqueness/counter checks and sanitized run-history screenshots. Rehearse outage acknowledgements against the exact deployed synthetic environment and have a reviewer replay it. No account connection or deployment was available in this implementation session.

## References

Official sources checked 2026-10-29: [v4 function configuration](https://www.inngest.com/docs/reference/typescript/v4/functions/create), [typed event helpers](https://www.inngest.com/docs/reference/typescript/v4/functions/triggers), [event acknowledgement and ID deduplication](https://www.inngest.com/docs/durable-execution/guides-and-advanced/events-and-triggers/send-events), [event waits and early-delivery limitation](https://www.inngest.com/docs/durable-execution/primitives/step-waitforevent), [concurrency](https://www.inngest.com/docs/reference/typescript/v4/functions/concurrency), [platform limits](https://www.inngest.com/docs/durable-execution/limits), and [Vercel setup/checkpointing/signing](https://www.inngest.com/docs/durable-execution/deploying-functions/platforms/vercel). Account-specific entitlements and hosted behavior must still be verified.
