# Simulated Code Red contracts

Stage 4 runs at `/code-red`. **Teaching model, not clinical software.** Every request, institution, donor, test result and timestamp is synthetic. `core/emergency.ts` is a pure command-driven state machine; `emergency-matching.ts` contains geography, stock ranking, alert ranking and probability functions. The screen dispatches local commands. No providers, notifications, network writes, concurrent reservation guarantees or durable workflow are involved.

## Clock, fixtures and validation

All scenarios start with seed `monsoon` at `2026-10-28T03:30:00.000Z` (09:00 IST). The form's datetime input is explicitly **UTC**, independent of browser timezone. Hospital IDs must exist in the generated fixture; group, component and urgency are enumerated. Quantity must be an integer from 1–20. Expected transfusion must be strictly in the future and within 24 simulated hours. Wave wait is an integer 1–60 simulated minutes; assumed acceptance probability is 0–1. Invalid input leaves the current journey untouched.

Each fixture reuses the Stage 3 development registry and its last O-negative unit, with 24 separately enrolled synthetic O-negative alert profiles: eight near 2 km, eight near 7 km and eight near 18 km from Bank 1. Generated registry donors remain outside this curated alert cohort. Reliability and alert history are scenario sidecars to the shared donor model. This is a fixture choice, not a population coverage claim.

| Preset | Request | Expected outcome |
|---|---|---|
| Stock available | One O− PRBC, two-hour window | Existing screened stock can complete through dispatch, arrival, handover and use |
| Stock shortage | Two O− PRBC, two-hour window; only one available | Partial allocation; exhausted alerts or deadline leads to unresolved escalation |
| Screened recovery | Two O− PRBC, twelve-hour window; only one available | Explicit acceptance, travel, collection and six-hour mock screening can supply the missing component |

The clock advances only on `ADVANCE`, one simulated minute at a time. Chunking advances produces the same state. There are no timers, wall-clock reads or implicit completion. Reset/scenario change/reload rebuild the fixture and discard the journey; the Control Room's persisted configuration and Inventory lab are separate.

## Stock and travel

Eligibility reuses Stage 2 `stockReasons`: availability, ownership, component, component-specific compatibility, collection time, all five non-reactive screens, storage, configured lifetime and expiry strictly beyond expected use. Unknown banks and estimated arrivals beyond the deadline are excluded. Duplicate unit IDs are rejected.

Order: shared exact/compatible preference (including O− conservation), estimated travel, bank distance, FEFO, stable bank/unit IDs. At equal bank distance, earlier expiry wins. The table shows owned stock, newly collected components, requested group/component stock and eligible compatible alternatives. Released units remain visible after cancellation. Stock and donor-response regions support keyboard scrolling.

Distance uses a spherical-Earth haversine calculation with radius 6,371 km, following the [author's geographic calculation reference](https://www.movable-type.co.uk/scripts/latlong.html). Estimated travel is `ceil(distanceKm / 30 * 60 + 5)` minutes. This is a straight-line-derived estimate, **not a routed ETA**, and includes no traffic, roads, terrain, transport logistics or clinical preparation model. Radar rings use computed distances with illustrative angles.

## Donor ranking and waves

Mock medical eligibility comes from the Stage 2 configurable teaching policy. Alerts then require component-compatible group, fewer than four alerts in the scenario month, no alert in the preceding 24 hours and no previous alert for this request. Quiet hours are 22:00 inclusive to 07:00 exclusive IST; only `CRITICAL` bypasses quiet hours. It cannot bypass eligibility, fatigue or deduplication.

Score = `10 / estimatedArrivalMinutes + 2 * reliability + min(daysSinceEligible, 365) / 365 - 0.25 * alertsThisMonth`. Descending score and stable donor IDs determine order. The UI exposes inputs, scores, exclusions, distances and estimated arrivals. Eligibility is rechecked at collection. Collection advances the profile's whole-blood interval using the existing conservative 120-day policy.

Waves use cumulative radii 5, 10 and 25 km, excluding previously alerted donors. The default wait is three simulated minutes, configurable before starting. Each wave stores send/close timestamps, selected IDs, population, required count, computed chance and whether the target was possible. Declines are final; late/duplicate replies are rejected. At the close instant pending alerts become `TIMED_OUT`. An unmet requirement opens the next radius after the wait. Three exhausted waves produce `ESCALATED`, with neighbouring-district/manual coordination explicitly unresolved. Empty populations still produce zero-alert waves and terminate finitely.

The remaining donor requirement is unallocated quantity minus accepted/collected opportunities. Accepted donors pause further waves while their opportunity covers the shortage; they can still fail to collect or miss the deadline. A reactive result removes that opportunity and resumes widening on the next advance. A short deadline does not disqualify an alert opportunity: the UI explains that collection and screening may be too late, and the request remains unresolved unless ready stock arrives. No new screened component is promised within the alert wait.

## Probability model

Choose the smallest `n` satisfying `P(Binomial(n,p) >= k) >= target`, bounded by the eligible population. `k` is remaining donor count; each donor models one requested component unit. Independent replies with common fixed `p` follow the [NIST binomial model](https://www.itl.nist.gov/div898/handbook/eda/section3/eda366i.htm). The default target is 95% and `p=.23`; this is a configured assumption, not an observed rate or a screening-success guarantee.

The implementation accumulates a truncated Bernoulli convolution, tracking mass reaching `k` directly to avoid factorial overflow and cancellation in `1 - CDF`. Sizing is O(population × k); population is capped at 5,000 and `k` at 1,000 (UI quantity cap: 20). Empty populations, zero required donors, `p=0`, `p=1` and insufficient populations have explicit finite outputs. An insufficient batch sends available candidates and labels its actual chance below target. Later batches calculate their own chance; failed previous batches do not count as successes or renew eligibility.

At `p=.23`, minimum counts for k=1/2/4 are 12/19/32. The curated fixture adds only eight fresh donors per radius: batch chance for one acceptance is 87.6426%, visibly below 95%. Manual replies are scenario choices. **Sample seeded replies** draws one deterministic Bernoulli response per pending donor, keyed by seed, donor ID and send time. Repeating the action cannot reply twice.

Tests compare an independently written factorial/binomial sum across n/k/p combinations, verify minimum-n thresholds and impossible boundaries, check large-n stability, and compare 20,000 seeded Monte Carlo trials for k=1/2/4. `npm run emergency:report` prints analytic/empirical results, three end-to-end traces and complete-state SHA-256 fingerprints. Compiled tooling stays under ignored `.tools/emergency-report`; no services are accessed.

## Reservation to completion and failure paths

Start validates, searches and reserves screened stock using `transitionUnit`. Reservations have at most the existing ten-minute injected-clock lease; each minute releases expired leases and rechecks stock readiness. Released stock needs an explicit new search/reservation. First-full-stock-match time records the **first** full screened allocation and remains historical if a lease later expires. First-accept time is separate. Both are simulated minutes since start, not treatment time or cloud latency. An unresolved full match is displayed as unresolved, never zero.

Dispatch issues reserved units only after revalidation and a deadline-arrival check. FFP requires explicit synthetic preparation confirmation on the action. Each unit records estimated arrival. Handover requires that arrival to have elapsed and records the domain handover event. Synthetic use requires handover, transitions units to `TRANSFUSED` and counts use. Partial use remains partial; completion requires the full requested quantity. Repeated replies, collection, screening, dispatch, handover or use cannot double count.

Accepted donor → estimated arrival at collection bank → **Collect synthetic donation** → `COLLECTED → TESTING` with missing/pending screens → wait six simulated hours → choose the mock result. All five non-reactive screens plus verified storage permit `AVAILABLE` and a fresh stock search; a reactive result discards the component. New stock must still fit compatibility, expiry, travel and deadline checks. Neither acceptance nor collection increases allocated quantity. Only the requested product is generated, retaining collection timestamp and Stage 2 lifetime; this is a bounded single-request path, separate from the Control Room's three-product population engine.

Cancellation before dispatch releases active reservations, cancels pending/accepted alerts and preserves collected/testing stock in quarantine. After issue/use, cancellation is blocked with a handover/manual-coordination explanation. Exhaustion or deadline closes the journey as `ESCALATED`, releases active reservations, cancels pending/accepted alerts and retains issued/transfused records for manual review. The local screen cannot resume an escalated request or erase issued ownership. Reset starts another synthetic run. Escalation never represents success or contact to a real district.

## Replay

1. Stock available: Start → Dispatch → Advance 60 min → Confirm handover → Confirm synthetic use. Full match is at minute 0; explicit use completes at minute 60.
2. Stock shortage: Start → optionally Decline a donor → Dispatch the partial reservation → Advance 3 min three times. Observe all radii and unresolved escalation at minute 9.
3. Screened recovery: Start → Accept Mock donor 4 → Dispatch → Advance 15 min → Collect → Advance 60 min → Confirm handover/use of the initial unit → Advance 360 min → Pass all mock screens → Dispatch → Advance 60 min → Confirm handover/use. These generous UI advances complete at minute 495; the report's finer advances reach full match at 375 and completion at 435.
4. Start again and advance ten minutes without dispatch: lease releases and allocation drops. Search again to reacquire. Cancel before dispatch and inspect released stock. Reload returns to unstarted Stock available.
5. In recovery choose a reactive result after the wait: discard, unmet demand and later waves. Accept in the short shortage window without ready stock: deadline escalation retains unmet demand.

Run `npm run check`, then `npm run test:e2e` against the build, and `npm run emergency:report`. Hosted preview, independent review, Atlas/auth/atomic concurrency and durable Inngest execution remain in their existing stages.
