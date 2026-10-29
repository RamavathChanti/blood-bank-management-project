# Stage 6: portals, reservations and The Duel

Stage 7's [durable emergency guide](workflows.md) extends the schema/runtime permissions and adds Inngest-backed requests. New URGENT/CRITICAL requests use that intake; this guide's direct creation endpoint now accepts ROUTINE requests only. Workflow-managed requests use durable cancellation and bank dispatch approval. Existing manual requests/receipts retain their Stage 6 actions.

All records are synthetic. **Teaching model, not clinical software.** The Bank and Hospital portals use the configured MongoDB database through authenticated Node APIs. The Duel is a separate browser explanation. Local replica-set checks do not establish Atlas, Clerk or deployment connectivity.

## Setup and migration

Complete the [registry setup](registry.md) with a dedicated development/demo replica set and server-managed Clerk memberships. New databases use the normal seed command. Existing Stage 5 databases can add the receipt collection and indexes without deleting records or changing the saved fixture hash:

```powershell
# Temporary database-specific setup credential; stop the app during schema changes.
npm run registry -- upgrade --confirm=pulsegrid_dev
npm run registry -- verify
```

Upgrade requires the existing PulseGrid seed ownership marker, the exact target confirmation, and a permitted database name; it is disabled for `VERCEL_ENV=production`. Run setup against the corresponding isolated preview/demo environment separately. An upgrade never resets inventory, history, requests or receipts. Do not reset a database to apply this change. Restore the runtime credential before starting the app.

Expand the Stage 5 runtime custom role to these database-specific actions:

| Action | Collections |
|---|---|
| FIND | banks, hospitals, donors, units, unitEvents, requests, allocations, stock, alerts, operations |
| INSERT | units, unitEvents, requests, allocations, stock, operations |
| UPDATE | banks, hospitals, donors, units, requests, allocations, stock |

Keep schema/index administration, deletes, writes to `unitEvents`/`operations` after insertion, and access to `_registryMeta` out of the runtime role. These are an operator runbook, not a claim that account privileges have been configured or tested in Atlas.

## API contract

All paths below are under `/api/registry/`, use POST with JSON, require an exact same-origin Origin header, and accept no query parameters. Bodies are capped at 8 KiB. Ownership comes from the current authenticated BANK/HOSPITAL membership; state administrators retain read access but cannot impersonate staff for these mutations. Arbitrary status, ownership, counter, role, operator or naive-mode fields are rejected. Private results and errors remain no-store.

Every mutation requires a caller-generated `key` matching `[a-zA-Z0-9_-]{1,128}`. Keep the same key and payload when retrying an uncertain response. The key is scoped to institution and operation path. Reusing it with a different parsed payload returns 409 `IDEMPOTENCY_KEY_REUSED`.

| Path | Body beyond key / behavior |
|---|---|
| `banks/:bankId/collect` | `donorId`, `group`, `product`, `collectedAt` (ISO with timezone). Existing live synthetic donor/group required; no future or already-expired collections. Server derives bank, component, expiry, screening and quarantine state. |
| `banks/:bankId/units/:unitId/action` | `type`: START_TESTING, UPDATE_SCREENING, VERIFY_STORAGE, MAKE_AVAILABLE, ISSUE, RETURN, EXPIRE, DISCARD. UPDATE_SCREENING requires all five screen results; VERIFY_STORAGE requires `storage`; ISSUE requires boolean `preparationConfirmed`; RETURN/DISCARD require `note` (1–200 characters). No additional fields. |
| `hospitals/:hospitalId/requests` | `group`, `component`, integer `quantity` 1–20, `urgency`, `expectedTransfusionAt`. Expected use must be strictly in the future, within 24 hours. No patient input. |
| `hospitals/:hospitalId/requests/:requestId/search` | Empty `{}`, no key. Advisory scoped search; returns safe candidates, distance, preference and policy. |
| `hospitals/:hospitalId/requests/:requestId/reserve` | Key only. Claims **one** unit; returns `reserved`, allocation/unit/request IDs, current count, remaining demand and lease expiry. Repeat with a new key to claim the next unit. |
| `hospitals/:hospitalId/requests/:requestId/cancel` | Key only. Releases RESERVED units and cancels the request atomically. ISSUED stock must be returned by its bank first; cancellation is refused after synthetic transfusion. |
| `hospitals/:hospitalId/units/:unitId/action` | `type`: HANDOVER or TRANSFUSE, key only. Requires this hospital's current ISSUED allocation. Handover precedes synthetic transfusion; completion requires the full quantity. |
| `hospitals/:hospitalId/requests/:requestId/history` | Empty `{}`, no key. Up to 500 append-only events from that hospital/request, including released reservations even after slot reuse. |
| `banks/:bankId/maintain` | Key only. Up to 100 due unit/lease transitions per pass, plus authoritative reconciliation of all 24 group/component stock buckets. `more` means repeat with a new key. |
| `hospitals/:hospitalId/maintain` | Key only. Releases up to 100 of this hospital's due active leases across banks, updating affected counters. Physical shelf/issued-unit expiry belongs to bank maintenance. |

The existing GET APIs provide current units, requests, allocation slots, bank history and stock. Lists page at 100 rows; use the returned `next` cursor unchanged. Reservation IDs change when a slot is reassigned; pagination uses its stable database slot ID. A single allocation GET uses the visible reservation `id`, which stops being current after reassignment. Use request history to find earlier ownership.

## Matching policy and bounds

MongoDB `$geoNear` selects up to 100 banks within **250 km** of the authenticated hospital, in the assigned state. Every unit candidate must also match the bank's actual tenant. The stock query filters component, compatible groups, completed non-reactive screening, verified storage, collection time, AVAILABLE state, no existing reservation and expiry **strictly after** expected use. The pure engine rechecks product shelf life and all teaching readiness rules.

The database orders compatibility tiers before expiry and caps candidates at 500; application ordering adds straight-line distance and stable unit ID as tie breakers. Exact red cells are preferred; O-negative is conserved for other groups. Plasma uses reverse ABO compatibility and equal Rh preference within an ABO tier. Platelets require identical group. This is FEFO within the selected compatibility preference, not nearest-bank-first selection. Distances are not routed travel estimates or arrival guarantees. Search is bounded and does not prove statewide exhaustion beyond those bounds.

Search never claims stock. Reservation reruns the candidate query within a transaction, then conditionally `findOneAndUpdate`s a still-eligible AVAILABLE unit. Driver transaction retries reread state after concurrent conflicts; occupied/inconsistent ownership slots are skipped in favor of another candidate. A fixed cap of five outer retries handles duplicate-key races; unresolved contention returns an error, never a successful claim.

## Transaction and ownership invariants

Each successful reservation commits the conditional unit change, allocation slot, bounded request count, stock counter, lifecycle event and retry receipt together with snapshot read concern and majority write concern. Commands execute sequential database operations inside a session. Any later failure rolls back earlier writes. Request updates require `allocatedQuantity < quantity`; simultaneous calls against one request cannot overfill it.

The unconditional unique `allocations.unitId` index remains intact. There is exactly one durable slot for a unit. The slot has an immutable `_id`, a new reservation `id` for each ownership period, and ACTIVE → ISSUED → TRANSFUSED or RELEASED status. Only RELEASED slots may be replaced. Before reuse, events preserve the earlier request/hospital/allocation snapshot. Hospital history is projected from those events using hospital tenant and request filters. Per-unit revisions order events even when multiple actions share a timestamp; cryptographic chains, canonical signatures and tamper verification remain Stage 11.

`operations` stores fingerprinted results in the same transaction. Concurrent identical retries return the committed result without performing the mutation twice. A no-stock result is also durable: a later retry of that key still reports the original shortage; a new action/key searches newly arrived stock. Replaying an old success returns its historical receipt, not a new claim or an assertion that its lease is still active. Use current request/allocation reads for current status. Receipts have no TTL, preserving this guarantee; reset removes them only with the rest of the explicitly confirmed synthetic fixture. A larger deployment needs an explicit retention/archive policy.

Leases last at most 10 minutes and cannot outlive expected use or unit expiry. At the exact lease boundary, issue fails even if maintenance has not run. Availability, use and matching also enforce logical expiry without background cleanup. Cancellation/expiry releases RESERVED stock through the normal lifecycle; safe stock becomes AVAILABLE, physically expired stock becomes EXPIRED, and failed readiness becomes DISCARDED. Returned issued stock stays RETURNED_QUARANTINE and cannot be made available through this teaching workflow. Used stock remains owned for traceability.

Counters are derived from authoritative eligible AVAILABLE unit records in the affected bank/group/component bucket inside the mutation transaction. Bank maintenance repairs every bucket, including zero-count buckets and stale expiry counters. Counter reconciliation never repairs contradictory ownership automatically; such records fail closed for operator review.

Stage 6 maintenance is an authenticated manual action. Until Stage 7 adds scheduled workflow execution, idle expired leases remain unavailable until a staff maintenance pass; they cannot be issued or double allocated. Request deadlines block further reservation/issue but do not invent a fulfilled or escalated outcome. Requests have an injected server clock per call; the browser cannot set the reservation clock or lease length. Durable event-service acknowledgement and outage recovery are not Stage 6 claims.

## Portal and Duel replay

1. Sign into `/bank` with Bank A. Record a collection using an existing synthetic donor ID and its matching group (the setup seed generator/report provides these). Check that COLLECTED/TESTING stock is quarantined. Start testing, enter all five mock screen results, verify storage, and make it available. Try premature availability and reactive screening; verify rejection/discard. Use loaded-unit pagination as needed.
2. Sign into `/hospital` in another browser profile. Create a request with use within an hour, select it, search, and reserve the next unit until allocated or explicitly short. Verify compatible preference and FEFO. Use Refresh progress to see changes; no realtime subscription is claimed yet.
3. Return to the bank and issue the reserved unit. FFP requires the explicit synthetic preparation checkbox. Return to the hospital, refresh, confirm handover, then confirm synthetic transfusion. Verify COMPLETED only after the required quantity is used.
4. Create another request, reserve, then cancel. Confirm the unit and counters are released. Reserve it under Hospital B; load A's request history and verify its earlier ownership remains. Let a lease reach its boundary, verify issue is denied, run maintenance and reacquire. Return an issued unit and verify permanent quarantine in this workflow.
5. If a mutation response is uncertain, use Retry pending action; new mutations lock until its original key recovers. This retry state lives in the mounted portal; navigating/reloading discards the browser's pending key. Inspect current records before starting another creation action after a reload. There is no durable emergency acknowledgement in this stage.
6. Open `/duel` without credentials. Run the conditional model: one claim, zero double allocations. Select naive read-then-write: two stale-read claims, one double allocation. Reset cancels the shared countdown. Both modes use isolated memory, scheduled A-first ordering and no registry API; they are not live concurrency or throughput measurements.

## Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run test:e2e
```

The integration suite uses a real temporary MongoDB 8.0.17 WiredTiger replica set and injected/mock identities. It checks 100 simultaneous attempts against 10 units, a simultaneous one-request overfill attempt, identical request/reservation retries, partial shortages, rollback after a late write failure, compatibility/expiry/storage/screening/tenant gates, slot reuse/history, cancellation, lease expiry, counter reconciliation, returns and complete synthetic use. The race writes a sanitized report to `_ai_context/artifacts/stage-6-race.json`.

Browser tests cover production fail-closed pages/APIs and both Duel modes. Test-only Vite serves the actual portal workflow component from `tests/portal-harness.html` with explicitly intercepted API fixtures, covering bank screening/collection, hospital actions and same-key error recovery on desktop/mobile. Vite is a development test dependency; this harness is outside the Next app and supplies no production authentication bypass. These component checks do not prove a signed Clerk session or a browser-to-Atlas journey.

Before claiming Stage 6's live acceptance condition, record a deployed preview, signed Bank/Hospital sessions, actual Atlas privileges/schema/transaction verification, the full cross-browser lifecycle, a concurrent cloud reservation replay, tenant denials and a reviewer. Those account-dependent checks remain open with Stage 5.

## References

Checked 2026-10-29 with installed MongoDB Node driver 7.7.0 types and real database execution: [compound operations](https://www.mongodb.com/docs/drivers/node/current/crud/compound-operations/), [driver transactions and sequential session operations](https://www.mongodb.com/docs/drivers/node/v6.x/crud/transactions/), and [Vite's test-harness server API](https://vite.dev/guide/api-javascript.html).
