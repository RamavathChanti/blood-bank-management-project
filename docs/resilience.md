# Resilience and Vital Signs

Teaching model, not clinical software. Use synthetic records and a dedicated
development/demo environment. Open `/vital-signs` from Operations. All status,
trace, alert, reconciliation and control APIs require backend-verified
`STATE_ADMIN` membership. Private responses use `private, no-store`.

## Runtime controls

Stage 12's Edge Config integration supports both `EDGE_CONFIG` and
`GLOBAL_CONFIG` (the latter takes precedence). Vercel renamed the service to
Global Config; legacy connection strings remain supported. No SDK dependency
is needed: reads use the store's single-item REST endpoint and writes use
`PATCH https://api.vercel.com/v1/global-config/<id>/items`.

1. In the dedicated demo project's Storage settings, connect a Global Config
   store and pre-create one `pulsegridChaos` JSON item:

   ```json
   { "dbDown": false, "dbSlowMs": 0, "realtimeDown": false, "expiresAt": "1970-01-01T00:00:00.000Z" }
   ```

2. Set the server-only connection string (`GLOBAL_CONFIG` or `EDGE_CONFIG`),
   `DEMO_CONTROLS_ENABLED=1`, `DEMO_CONFIG_WRITE_TOKEN`, and, for a team store,
   `DEMO_CONFIG_TEAM_ID`. Use an API token scoped to the dedicated demo team;
   it is a privileged Vercel management token, not a read token. Limit its
   lifetime and don't put it in browser configuration. Keep other projects
   out of that team where possible. No tokens are returned to the browser.
3. Sign in as the state admin and refresh Vital Signs. Confirm the observed
   flags, then apply a fault. A successful PATCH means the write was accepted;
   replication can take several seconds. Refresh until the **observed** state
   agrees. A failed/timeout write is explicitly unconfirmed: it might have
   applied. Inspect the store/read state before retrying.
4. Untick faults and set delay to zero to restore service. Every UI update
   expires in ten minutes. The server rejects expiries beyond fifteen minutes,
   noninteger delays, delays outside 0–3000 ms, extra fields, and malformed
   configuration. Expired faults become inactive without another write.

Controls disabled is the default. Enabled but unreadable/malformed config
fails database access closed with a sanitized 503; there is no fallback that
silently treats an unknown flag as healthy. Config reads time out after two
seconds; writes after five. Only Vercel's HTTPS config hosts are accepted,
with redirects disabled. Writes require same-origin bounded JSON and admin
identity; headers and browser form fields cannot enable fault injection.

`dbDown` and `dbSlowMs` apply at the shared `database()` boundary, including
workflow steps, API operations and public-cache refreshes. These are injected
application faults, not proof that Atlas itself was stopped. A database handle
already obtained by a running operation is not revoked. Slowdown adds a delay
per acquisition, not per MongoDB wire command. Do not add a database probe to
emergency intake: it must acknowledge through Inngest even during this fault.

`realtimeDown` gates same-origin and BroadcastChannel refresh hints. This app
uses browser hints and bounded HTTP polling; no hosted realtime provider is
configured. `/api/refresh-hints` exposes only a boolean, no private records or
control credentials. Clients recheck it at most once per fifteen seconds of
active polling. Failed reads suppress hints. Timed polling, focus/reconnect
refresh, manual refresh and reload still fetch authoritative data. Existing
120-attempt, visibility/offline and capped backoff limits remain in force.

## Measurements and request traces

Vital Signs shows observed config state, a timed Atlas ping, workflow
configuration status (not an ingestion/delivery probe), and the actual polling
transport. Failed measurements remain unavailable/null. Materialized workflow
counts come from Atlas grouped by workflow status and exclude unpersisted
acknowledgements. `COMPLETED` means fulfilled through synthetic use;
`ESCALATED`, `CANCELLED`, and `FAILED` are separate outcomes.

Handlers emit `X-Correlation-Id`, `Server-Timing` and fixed-field JSON
`pulsegrid.observation` records. API, database acquisition, registry operations,
public aggregation, workflow ingestion/steps, config reads and refresh gates
are timed. `durationMs` is measured wall time for that span, including injected
delay when applicable; overlapping spans must not be summed. Database-access
timing alone is not MongoDB query latency. Auth and provider time appear in
the overall API span. No request bodies, URLs, cookies, receipts, donor data,
provider error strings or credentials enter these diagnostic observations.

The request drawer shows a selected API correlation. Emergency observations
also include `requestId`, linking intake/retries to workflow observations.
Workflow steps correlate by the same emergency ID; use the saved event IDs,
request's run ID and Inngest history for the durable trace across processes and
waits. The UI's last 300 observations and observed failure-to-next-success
recovery durations belong to **one warm process** and disappear on restart.
They are not a fleet dashboard, durable receipt ledger, infrastructure p95,
service uptime guarantee or workflow queue-depth measurement. There is no
invented zero-loss/zero-latency reading on an unavailable service.

## Outage rehearsal and acknowledgement accounting

1. Verify healthy dependencies and a stable receipt secret. Warm `/public-board`
   and retain its `generatedAt` and availability bands. Use a separate cold
   demo cache/environment for the cold-cache check, not destructive cache
   eviction against the warm demonstration.
2. As admin, enable `dbDown`. Observe its active value. Refresh the Public Board
   after its thirty-second data-cache revalidation window. A warm Next Data
   Cache serves the last successful aggregate when background revalidation
   fails. Its timestamp stays old and the UI labels stale data. A cold cache
   returns uncached 503, with no successful empty-stock substitute. Vercel CDN
   headers can be unknown locally; retain actual hosted headers separately.
3. As a hospital, submit ten distinct synthetic emergencies in Durable Code
   Red, choosing realistic deadlines for the rehearsal. After each **202 with
   accepted=true and provider event IDs**, use Start another emergency. The
   prior signed receipt remains in the **Retained acknowledgement cohort**.
   Up to 100 receipts are kept under that user's sessionStorage key. Reload
   preserves them within the session; switching users uses a separate key.
   Export the private receipt JSON before closing the session. Select a prior
   receipt to inspect its own status while others remain retained.
4. A send timeout, 503, or missing provider event ID is **not acknowledged**.
   Keep the exact frozen payload and retry it with its original key. Exclude
   such submissions from loss calculations until an acknowledgement arrives.
   Atlas status can return 503 alongside a valid retained acknowledgement;
   that does not revoke the acknowledgement or prove a lost request.
5. Restore flags. As admin, paste the cohort's IDs into Vital Signs. The
   reconciliation endpoint deduplicates up to 100 supplied IDs and restricts
   lookup to the admin's state. This is an operator-declared cohort: retain
   signed receipts/provider history to substantiate membership. Unknown IDs
   remain pending persistence; ordinary materialized workflows remain
   accepted/in progress. Completion, escalation, cancellation and failure stay
   separate. Intake-to-first-persistence delay comes from the workflow's
   accepted timestamp and first persisted trace timestamp; missing times stay
   unavailable. It is not a database restoration timestamp.
6. Reconcile all ten to outcomes, inspect allocation ownership, alerts, stock
   counters and unit event uniqueness, then retry the same ten payloads and
   repeat. Report observed loss as **0/10 only when all ten have terminal
   fulfilled/escalated/cancelled outcomes**. Pending or failed runs leave the
   loss result unknown; investigate provider history before declaring loss.
7. Explicitly test workflow-service ingress failure too. Submit while that
   dependency is unavailable: the API must return accepted=false/unknown and
   retain the payload, then reuse the same request/event ID on retry. Test a
   failed callback/step and exhausted retry alarm separately. Do not claim
   database-independent intake survives a failure of its durable ingress.
8. Drop hints, then restore them; verify polling continues and hints recover.
   Inject a bounded database delay and inspect measured durations and pending
   UI. For a donor, go offline, reply, reload, reconnect and verify IndexedDB
   replays the same key once. Late replies must remain visibly too late.

Locally verified cases use actual Inngest SDK functions/CLI and temporary
MongoDB replica sets; Edge Config transport and principals are injected.
See `_ai_context/STAGE_12_EVIDENCE.md` outside the application root for exact
measurements, fixtures, reports and limits. Hosted CDN, signed Clerk sessions,
actual config propagation and cloud recovery require a configured deployment.

## Alerts, recovery and reset

- On exhausted orchestration or signal retries, emit a `pulsegrid.alert` /
  `WORKFLOW_FAILURE` JSON alarm **before** trying Atlas, and persist an
  idempotent retained `state-workflow-alert` operation. Orchestration failures
  mark existing nonterminal requests FAILED; completed/cancelled/escalated
  outcomes remain intact. An ingress acknowledgement whose workflow never
  materialized still has its ID in the alarm/provider history. If Atlas is
  down, persistence is retried by the failure handler; inspect platform logs
  and failed Inngest failure-handler runs as an independent fallback.
- The existing audit verifier retains `state-audit-alert` rows and now emits
  aggregate `INTEGRITY_FAILURE` JSON alarms. Vital Signs lists the last twenty
  retained integrity/workflow alerts; a later healthy check does not erase
  them. Audit's optional staff-email adapter remains disabled until configured.
- For operators, filter platform logs for `event=pulsegrid.alert` and Inngest
  failed runs. Configure the account's supported log alert/notification route
  separately if proactive delivery is required. This implementation does not
  claim an external email, Slack notification, pager, or configured hosted
  alert subscription. No external messages were sent in local verification.
- During an incident, first inspect active flags and config availability,
  receipt-secret continuity, provider event acceptance, failed runs and API
  correlation IDs. Disable faults via Vital Signs or the Vercel store if the
  app is unreachable; otherwise wait for expiry. If config is unreachable,
  restore the config service before expecting database work to proceed.
- Restore Atlas access, allow existing retry backoff, inspect failed callbacks
  and use the Inngest dashboard's supported retry mechanism for exhausted
  runs. Replay original payloads/signals/keys rather than inventing new IDs.
  Reconcile acknowledged cohorts, stock/allocations and audit integrity before
  claiming recovery. Issued stock and failed workflows may require manual
  review; never turn FAILED into fulfilled to clear an alarm.
- Reset only the explicitly confirmed dedicated development/demo database
  using `docs/registry.md` safeguards. Export receipts/evidence first, stop
  producers/schedules, settle/cancel active workflows, disable faults, reset
  fixtures, and warm the Public Board. Do not erase forensic alerts or active
  receipt history as part of outage recovery. A demo reseed is separate work.

## Broken deployment and rollback

`node scripts/rehearse-rollback.mjs` rehearses a **local routing change** between
the current Next production build and a deliberately failing HTTP stand-in.
It verifies known-good health JSON, observes 503, restores the route, verifies
the same JSON and writes measured recovery timings. It never contacts Vercel
or changes Git. Those milliseconds are not a hosted rollback measurement.

For the outstanding hosted acceptance rehearsal:

1. Use the dedicated synthetic demo project and identify a tested immutable
   production deployment. Record its URL/ID, config/secret compatibility and
   baseline health/Public Board/request status. Keep receipt/HMAC keys stable.
2. Prepare and publish a deliberately broken demo version to that dedicated
   project with an eligible known-good predecessor. Record its URL/ID and
   start an observer's timer when the failing public response is observed.
   No live registry or real-user deployment belongs in this rehearsal.
3. Use Vercel's **Instant Rollback** dashboard action for the project, or
   `vercel rollback` followed by `vercel rollback status`. Hobby permits the
   immediately previous eligible production deployment; a preview alone may
   not be eligible. Verify the current account's entitlement before rehearsal.
4. Stop the timer only after known-good API response, page assets and Public
   Board work through the intended domain. Record observed failure duration,
   route restoration, exact deployment IDs and any manual steps. Reconcile
   every acknowledged ID and verify integrity separately after rollback.
5. Rollback restores an earlier build/configuration; it does not reverse
   external database changes, config-store changes or durable workflows. Use
   backward-compatible schemas/events. Check cron behavior and keys. Vercel
   disables automatic production-domain assignment after rollback; use its
   documented promotion/undo flow only after the fix has been verified.

This hosted exercise remains pending until account access, deployment URLs,
and the external provisioning gates from prior stages exist. No hosted
deployment, rollback, fixed recovery promise or independent review is claimed.

Official references checked 2026-10-29:
[Global Config rename and legacy compatibility](https://vercel.com/docs/global-config/migration-guide),
[reading configuration](https://vercel.com/docs/global-config/using-global-config),
[REST writes and propagation](https://vercel.com/docs/global-config/vercel-api),
[Instant Rollback scope and restrictions](https://vercel.com/docs/instant-rollback),
[rollback procedure](https://vercel.com/docs/deployments/rollback-production-deployment).
