# Unit Passport and tamper-evident audit

Stage 11, implemented 2026-10-29. **Teaching model, not clinical software.**
All units, people and requests are synthetic. The browser demo at
`/unit-passport` needs no credentials and never writes to a database.

## Replay the isolated demo

Run `npm run dev`, open `/unit-passport`, and keep **Isolated local tamper
fixture** selected. Nine recorded actions follow collection, testing,
screening results, storage verification, availability, reservation, issue,
handover and synthetic transfusion. Mock screening takes one fixture minute;
this is accelerated teaching time, not a screening-duration claim.

1. **Verify unit** shows `VALID / LOCAL_ONLY / MATCH`. Local mode has no HMAC
   key and makes no claim of server authentication.
2. **Alter event 3** fails its event hash at record three. That record and all
   subsequent timeline cards turn red. Expand **Inspect hashes** to compare.
3. **Remove event 3** and **Swap events 3 and 4** also identify position three.
   Each button starts from a clean independent fixture, so experiments do not
   accumulate unrelated damage.
4. **Change current expiry** keeps the event chain valid but produces a
   current-state mismatch. In authenticated registry mode this same edit also
   produces `SIGNATURE_MISMATCH`.
5. **Reset fixture** recreates the clean deterministic history. Reload is safe;
   no tampered history or unit data is persisted in browser storage.

The initial registry seed records **Imported baseline**, with its imported
screening/storage values. It does not invent collection or screening events
that predate the audit implementation. Newly collected units use the complete
normal workflow. The current product identifies the separated component; there
is no invented separation event for the existing collection model.

## Canonical and cryptographic contracts

`src/core/audit.ts` defines **PulseGrid canonical JSON v1**, not a claim of full
RFC 8785 compliance. Objects sort keys by JavaScript UTF-16 order; arrays retain
order; strings use JSON escaping without Unicode normalization; finite numbers
use JavaScript JSON number encoding (`-0` becomes `0`); Date values become UTC
ISO strings. Object properties with `undefined` are omitted; sparse/undefined
array entries, nonfinite numbers, bigint and nonplain objects are rejected.
The server removes undefined object properties before persistence so BSON's
null conversion cannot change a signed value. Normal domain input is validated
before it reaches signing. No caller supplies a hash, sequence or signature.

The initial previous hash and previous state hash are 64 zeroes. Every event
contains version, stable IDs and tenant scope, unit ID, one-based `seq`, actor,
timestamp, action/from/to, prior hash, prior state hash, resulting state hash
and canonical resulting state snapshot, plus existing ownership metadata.

```text
state        = current document excluding sig, auditSeq, auditHead
stateHash    = SHA-256(canonical(state))
event.hash   = SHA-256(event.prevHash + canonical(event excluding hash))
unit.sig     = HMAC-SHA-256(key,
                 "pulsegrid-unit-v1:" + canonical(unit excluding sig))
```

The signature covers **all persisted unit fields**, including scope, `_id`,
expiry, screening, storage, ownership, revision and the audit head/sequence.
The server uses Node's `createHmac` and constant-time comparison for valid
fixed-length hex signatures. The browser uses Web Crypto SHA-256 for its
untrusted local fixture and never receives the HMAC key.

Verification separately reports:

| Result | Meaning |
|---|---|
| Chain VALID / BROKEN / UNTRACKED | Sequences, tenant/unit identity, chronology, prior links, event hashes and event snapshots, from/to consistency, and signed unit head/tail agree / fail / have no history |
| Signature VALID / MISMATCH / UNSIGNED | Current unit's HMAC agrees / fails / is absent |
| State MATCH / MISMATCH | Last event's state digest agrees / disagrees with the full current unit state |
| First affected record | Earliest failing position, including a deleted tail; independent current-document damage has no failing event position |

The verifier consumes event order without sorting it. Database reads order by
sequence, which represents logical chronology rather than physical BSON order.
Changing stored sequences without changing hashes is detected. Sequence gaps,
duplicates, missing heads/tails, changed snapshots, wrong scope and reversed
timestamps fail. Missing entire histories are untracked, never clean.

## Transactional writes and schema upgrade

`Operations` uses `appendChange` for collection, reservation and all lifecycle
changes, including cancellation, lease expiry, expiry maintenance, returns,
workflow dispatch, handover and transfusion. Unit replacement, signed chain
append, allocation/request counters, stock and the retry receipt commit or
abort in the same snapshot/majority transaction. A per-unit signed head filter
and MongoDB write conflicts serialize concurrent writers. The unique
`unit_sequence` index enforces `{unitId, seq}` for sequenced records. The
database's existing identity policy uses globally unique unit IDs.

Before writing, the server checks the unit's HMAC and its head event. Changed
or unsigned current records return `409 AUDIT_INTEGRITY_FAILED`; an API action
cannot quietly re-sign a direct database edit. Older damaged events remain
detectable during full verification even after later appends. Temporary search
ranking fields are removed before a row reaches signing or persistence.

Set a stable `AUDIT_HMAC_SECRET` to **64 random hexadecimal characters** (32
bytes), separately for each environment, before seeding or inventory writes.
Store it in ignored `.env.local` or the service secret manager, never in
`NEXT_PUBLIC_*`, source control, screenshots or evidence. Missing or malformed
keys fail with `503 AUDIT_KEY_UNCONFIGURED`; there is no runtime fallback. The
disposable test/report tooling generates an ephemeral test-only key in memory.
Changing/losing this key invalidates existing signatures. This version does
not implement key rotation; retain the original key securely and design a
versioned migration before rotation.

For a marked dedicated development/demo database:

```powershell
npm run registry -- upgrade --confirm=pulsegrid_dev
npm run registry -- seed --confirm=pulsegrid_dev
```

Upgrade adds `anchors`, index definitions and optional audit-field validators
without changing data. The sequence index is partial so multiple pre-Stage-11
legacy events can coexist without a destructive migration. Legacy unsigned
records remain visibly unsigned/broken and writes are blocked. Neither upgrade
nor reseed signs existing records, invents prior events, or repairs missing
evidence. A new seed signs each new imported unit and its baseline atomically.
The original deterministic fixture hash remains independent of the secret.

For disposable legacy fixtures only, stop app/workers, select the correct
database and use the existing exact-name-confirmed reset. Reset deletes the
known registry collections including audit reports and anchors. Archive any
evidence required for review first. Do not reset an actual shared registry to
hide an integrity failure. Restore a trusted backup or investigate the source
of corruption; a silent re-sign is not recovery.

Runtime database permissions extend the reservation role: `find/insert/update`
on `units`; `find/insert` on `unitEvents`; `find/insert/update` on `operations`
and `anchors` (update on anchors records external publication receipts). Keep
existing request/allocation/stock permissions. Runtime does not require
delete, index/schema administration or `_registryMeta` access. Setup credentials
remain separate. Append-only application behavior cannot constrain an Atlas
administrator who retains direct database privileges.

## Private API and integrity meter

| Endpoint | Authorization and behavior |
|---|---|
| GET `/api/audit/passport/:unitId` | State admin, or a bank with current verified institution membership and matching unit bank/tenant/state; verifies one snapshot and returns a safe timeline |
| GET `/api/audit/status` | State admin; last report, last retained alert, latest anchor and its historical-head comparison |
| POST `/api/audit/verify`, JSON `{}` | State admin; same-origin JSON only; verifies the synthetic state and records a report/alert |

All responses are private/no-store, vary by Cookie/Authorization, and sanitize
provider errors. Missing and inaccessible unit IDs both return 403. Hospital
and donor roles cannot read complete bank provenance or admin reports. Existing
hospital request-history views retain their narrower scoped projection.
Passport output excludes donor IDs, raw snapshots, notes, signatures and
allocation snapshots. Every displayed event hash refers to the full server
record; the displayed projection alone is insufficient to independently
recompute that record's hash. The server performs full verification.

Control Room, State registry and Passport show the **Registry integrity**
meter. It requires an explicit refresh and state-admin authentication. The
timestamp identifies the last completed snapshot, not continuous monitoring.
Failure records include the affected unit and separate failure classes. Admin
alerts are durable `operations` rows under `state-audit-alert`, distinct from
donor notifications. A subsequent clean check does not erase the last alert.
Ordinary reports expire after 31 days using the existing receipt TTL index;
alerts, unit events and anchors are retained for investigation.

## Scheduled verification and daily anchors

Registered production functions in `/api/inngest`:

| Function | Manual event | Opt-in cron |
|---|---|---|
| `audit-verifier-v1` | `pulsegrid/audit.verify` | `*/15 * * * *`, UTC |
| `audit-daily-anchor-v1` | `pulsegrid/audit.anchor` | `TZ=Asia/Kolkata 15 2 * * *`, 02:15 IST |

Cron triggers are registered only with `AUDIT_JOBS_ENABLED=1`. Manual events
run through the signed Inngest callback, ignore caller data and derive their
time from the provider event timestamp. Both functions share the existing
Atlas concurrency key with limit one and have two retries. Durable step state contains only small counts/receipt IDs; private failure
lists and chain snapshots remain in the database. No timer is held
inside an HTTP request. Local Inngest service tests exercise both actual
production functions; hosted schedules and account quotas remain unverified.

The verifier reads units and all histories from one snapshot and detects
orphan histories left by deleted units. A run is explicitly bounded to 2,000
units and 1,000 events per unit, with a 25-second transaction timeout. It refuses
oversized input instead of reporting a clean truncated subset. Bounded cursor
batches avoid a MongoDB 8/driver 7 getMore timeout incompatibility. This is a
college-demo full scan; benchmark Atlas before enabling it and use paged,
checkpointed verification for a larger registry. These limits are not claims
of state-scale throughput. Two durable steps per function mean a planning
estimate of 9,021 function/step executions over 31 days if both schedules run
without retries (97 runs/day × 3 executions × 31); check the actual account
dashboard and shared workflows before opt-in.

A daily anchor requires a clean snapshot. It sorts unit identities, hashes
`"leaf:" + canonical({unitId, seq, hash})`, combines nodes as
`SHA-256("node:" + left + right)`, duplicates an odd final node and defines the
empty root as `SHA-256("empty:pulsegrid-audit-v1")`. Unique `{stateId, day}`
enforces one immutable first snapshot per IST day, including concurrent or
replayed jobs. This commits the snapshot taken at the first successful daily
run, not a claim of midnight historical reconstruction. Retained private heads
allow comparison to historical events after legitimate newer appends.

Optional external publication is implemented but **disabled**. Set
`AUDIT_GITHUB_ENABLED=1`, `GITHUB_ANCHOR_REPOSITORY=owner/repository`,
`GITHUB_ANCHOR_BRANCH` to a precreated dedicated branch, and
`GITHUB_ANCHOR_TOKEN` to a fine-grained server token with **Contents: write on
only that selected independent audit repository**. The adapter writes
`audit-anchors/YYYY-MM-DD.json` containing only version, day, root and count;
no unit IDs, tenant IDs, signatures, donors or clinical-style data leave the
server. It reuses identical existing content and refuses to overwrite a
conflicting witness. A GitHub receipt is a publication observation, not an
independent revalidation of that remote repository on every page refresh.
External publication failures retry separately from the already committed
daily root. No repository or branch is created by this implementation.

Optional staff email is also disabled. With `AUDIT_EMAIL_ENABLED=1`, set
`RESEND_API_KEY`, `AUDIT_STAFF_EMAIL` and `AUDIT_EMAIL_FROM` to a verified sender.
Only failed scheduled checks send aggregate counts and a sign-in instruction,
without private unit data. A stable provider idempotency key covers retries
within the provider's retention window. The manual HTTP Verify action records
the in-app alert and sends no email. No email or GitHub write was sent during
local development; adapters were exercised with mock transports.

## Isolated database tamper rehearsal and trust limits

Use a separate explicitly named database such as `pulsegrid_demo_audit`, never
the audience/live demo registry. Configure the same app's server key and a
separate setup user, seed it with the confirmed target, and sign in as admin.
Verify a known seeded unit cleanly. In Atlas Data Explorer, change only that
unit's `expiresAt` (BSON Date). Reopen its Passport: chain VALID, signature
MISMATCH, state MISMATCH. Run **Verify registry now** to retain the alarm. In a
second independent fixture, change an event actor: its chain fails at that
sequence while the current-unit signature can remain VALID. Reset the isolated
database through `registry -- reset --confirm=pulsegrid_demo_audit` with workers
stopped, or restore the original trusted backup. This Atlas rehearsal is a
documented follow-up, not a claimed cloud test.

This is **tamper evidence**, not tamper prevention or clinical authenticity.
An application-server/key compromise can sign false records. A database
administrator can delete both a unit and all its history; current scans alone
cannot discover an entirely erased identity. Retained earlier anchors expose
missing committed heads, but database-only anchors can themselves be replaced.
A rewritten unanchored history has no external timestamp witness. A public
commit is useful only if its history and access are independently controlled
and reviewers retain/compare that witness. GitHub repository owners may alter
history too. Hashes do not establish that a real-world donation/test occurred.
The implementation does not promise blockchain consensus, prevention of
privileged edits, immediate alerts between scans, or recovery of missing data.

## Checks and sources

```powershell
npm test
npm run test:integration
npm run test:workflow
npm run lint
npm run typecheck
npm run build
npx playwright test tests/e2e/passport.spec.ts
```

Integration tests use a temporary real MongoDB 8.0.17 replica set, injected
identities and ephemeral keys. They cover serialized concurrent appends,
duplicate sequence rejection, full reservation/transfusion provenance,
transaction rollback, current/event tamper distinctions, orphan histories,
legacy unsigned units, tenant/role denials, seed integrity, replay-safe Merkle
anchors and optional adapter privacy. Core tests independently recompute
digests and odd-leaf trees and cover missing/reordered/duplicate/tail events.
Desktop/mobile browser tests cover the demo and authentication failures.

Official sources checked 2026-10-29:
[Node crypto/HMAC and timing-safe comparison](https://nodejs.org/api/crypto.html),
[MongoDB driver transactions and sequential session operations](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/),
[Inngest schedules and timezones](https://www.inngest.com/docs/durable-execution/guides-and-advanced/events-and-triggers/schedules-and-delayed-starts),
[GitHub contents API and fine-grained token permissions](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents),
[Resend send-email contract](https://resend.com/docs/api-reference/emails/send-email).
Canonicalization and Merkle domain separation above are explicit project
protocol choices, not inferred vendor standards.
