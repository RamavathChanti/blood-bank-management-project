# Stage 2 domain and inventory contracts

Teaching model, not clinical software. All records are synthetic. No service keys, accounts, network access, or framework are required by `src/core/`.

## Boundaries and records

`validation.ts` supplies strict, dependency-free parsers. Unknown fields, invalid enums, nonfinite numbers, impossible dates, ambiguous timestamps, wrong product/component combinations, inconsistent ownership, invalid counters and malformed deferrals are rejected. Parsers return detached records with UTC timestamps. Readonly TypeScript types prevent accidental writes; runtime deep freezing is not promised. Invalid donor inputs fail closed as ineligible; invalid inventory/request inputs throw rather than being silently accepted.

`domain.ts` exports groups, components, products, lifecycle statuses, per-infection screening, and shared `Unit`, `Donor`, `Bank`, `Hospital`, `BloodRequest`, `Allocation`, and `LifecycleEvent` types with parsers. Unit ownership includes request/allocation IDs, recipient group, expected-use time and lease times. Allocation IDs are stable per unit; releases and reassignments retain history as separate lifecycle events. Events record actor, timestamp, action, old/new status, ownership IDs, screening/storage snapshot and lease/deadline when present. These ordinary events are not a cryptographic audit chain. Actor IDs do not prove authorization.

## Time and product policy

Every operation receives an explicit timezone-bearing clock; there is no `Date.now()` call in the engines. Elapsed days are exactly 24 hours. Default product lifetimes from collection are PRBC/SAGM 42 days, PRBC/CPDA-1 35 days, closed-system platelets 5 days and unopened frozen FFP one UTC calendar year, clamping February 29 to February 28. Component separation preserves collection time. `createCollectedUnit` calculates expiry from product and injected rules. A shorter labelled lifetime is permitted; a label beyond the configured maximum fails readiness. `ShelfLifeRules` can shorten/lengthen day-based products explicitly; FFP remains the supported one-calendar-year product.

At `now >= expiresAt`, stock is expired. Match/reserve/issue require expiry strictly beyond now and expected use, even if the stored status is stale. Past request deadlines fail; expected use equal to now can be assessed, but cannot acquire a positive reservation lease. Unknown storage/screening fails closed. Live adapters must supply authoritative time and the same product policy to each operation; simulator clocks must stay separate from live provider time.

## Lifecycle

`transitionUnit(unit, command, {now, actorId, eventId, shelfLife?})` returns a new unit and event. IDs are supplied by callers and must be unique/idempotent at persistence boundaries. Lifecycle timestamps cannot move backwards.

| Command | Allowed state and result |
|---|---|
| START_TESTING | COLLECTED → TESTING |
| UPDATE_SCREENING | TESTING → TESTING; any REACTIVE result → DISCARDED |
| VERIFY_STORAGE | COLLECTED/TESTING; FAILED → DISCARDED |
| MAKE_AVAILABLE | TESTING → AVAILABLE only with all five NON_REACTIVE results, verified storage and valid lifetime |
| RESERVE | AVAILABLE → RESERVED after full match checks and bounded request quantity |
| CANCEL_RESERVATION / EXPIRE_RESERVATION | RESERVED → AVAILABLE after readiness recheck, EXPIRED for expired products, otherwise DISCARDED for failed readiness; expiry action requires `now >= leaseExpiresAt` |
| ISSUE | RESERVED → ISSUED, same owner/group/component/deadline, live lease, full readiness and compatibility recheck; FFP requires explicit synthetic preparation |
| HANDOVER | ISSUED → ISSUED with receipt timestamp, once only |
| TRANSFUSE | ISSUED → TRANSFUSED after handover and readiness checks |
| RETURN | ISSUED → RETURNED_QUARANTINE with an explicit reason; ownership cleared; no route back to availability or issue |
| EXPIRE | Any nonterminal state → EXPIRED only at/after product expiry |
| DISCARD | Any nonterminal state → DISCARDED with a reason |

TRANSFUSED, EXPIRED and DISCARDED are terminal. Unknown commands and invalid transitions throw. The default reservation lease is 10 minutes (configurable per reserve call within 0.01–1,440 minutes) and is capped at expected use/product expiry. At exact lease expiry issue is rejected. A lease is never implicitly renewed. Cancellation can release before issue; an expired lease stays unavailable until explicitly reconciled. Issued stock cannot be cancelled back onto a shelf. Returned stock can only remain quarantined, expire or be discarded until a separately verified handling policy exists. No clinical thawed-plasma storage interval is implemented.

## Matching and local batches

`matchInventory(units, request, now, shelfLife?)` validates input, rejects duplicate unit IDs, returns every assessment with rejection reasons/explanation, eligible candidates in order, selected units and shortage. Requested quantity minus already allocated quantity bounds selection. Only AVAILABLE, unowned, screened, storage-verified, compatible stock surviving the deadline is eligible.

Compatibility uses antigen-set calculations independent of test truth tables. PRBC permits 27/64 pairs; FFP reverses ABO and ignores RhD (9/16 ABO, 36/64 expanded pairs); platelets use a deliberately stricter identical ABO/RhD policy (8/64). Clinical exceptions, crossmatch decisions and other antigens are outside scope.

Deterministic selection policy:

1. PRBC exact group first; other compatible groups in fixed `O-, O+, A-, A+, B-, B+, AB-, AB+` order with O-negative moved to last for other recipients. For example A+ chooses `A+ → O+ → A- → O-`. This is project policy, not a clinical ranking.
2. FFP ABO-identical first, then compatible ABO groups in O/A/B/AB order. Both RhD variants of an ABO group share a tier. Platelets have one identical-group tier.
3. Within each tier, earliest expiry first (FEFO), then lexical bank ID and unit ID for stable ties. Distance/travel ranking arrives in Stage 4.

`reserveLocalStock` returns updated units/request, stable per-unit current allocations, events and shortage. `issueLocalStock` emits issue events in the same preference/FEFO order. `releaseLocalStock` returns readiness-checked cancellation/lease-expiry updates and adjusts the allocation count; its CANCEL mode cancels reservations, not the entire hospital request. None of these local batches writes to Atlas, resolves concurrent writers, or claims cloud idempotency. Partial allocations stay PARTIAL. Donor acceptance has no stock mutation API and cannot count as inventory. Request COMPLETED validation requires all requested units' synthetic-use count; issue/handover do not increment that count. Future adapters must verify those counters against authoritative events.

The future Stage 6 transaction must conditionally revalidate current stock and owner, bound request count, update unit/current allocation/request/counters, and append events together. Maintain one current allocation document per unit; do not erase prior ownership events. Authorize actors and related bank/hospital IDs on the server. Stage 2's single-thread local state is not a substitute for this transaction.

## Mock donor rules

`donorEligibility(input, now, rules?)` uses completed UTC-calendar age (a February 29 birthday advances on March 1 in nonleap years): first donation 18–60 inclusive, repeat 18–65. A valid prior donation timestamp identifies a repeat donor. Defaults: 350 ml at ≥45 kg, 450 ml at strictly >55 kg, mock Hb ≥12.5 g/dL, conservative 120 elapsed days between all synthetic whole-blood donations. Eligibility starts at the maximum of supplied `eligibleFrom`, last donation plus interval, and temporary-deferral end dates; equality is allowed. A permanent deferral always blocks. Future donation history, incomplete records and malformed deferrals block. Age, weights, Hb and interval are configurable; complete clinical deferrals, apheresis and real donor fitness are excluded.

## Sources and validation

Domain defaults implement the surrounding `_ai_context/STAGE_0_TEACHING_RULES.md` contract. Compatibility references rechecked 2026-10-28: [Lifeblood blood group tables](https://www.lifeblood.com.au/patients-recipients/blood-plasma-platelets/blood-for-transfusion/matching-blood-groups) and [component compatibility](https://www.lifeblood.com.au/health-professionals/products/component-compatibility). Product and selected donor-rule citations remain in the Stage 0 source register; no new clinical policy is introduced here.

Run `npm run check` then `npm run test:e2e`. Unit tests cover all 192 component pairs against separately authored literal tables, expiry and eligibility boundaries, exclusions, preference/FEFO, partial stock, leases, cancellation/reacquisition, returns, FFP preparation, clock injection and input immutability. Browser tests cover the local journeys on desktop and phone-sized Chromium. Hosted previews and independent review remain at the earlier Stage 1 deployment gate.
