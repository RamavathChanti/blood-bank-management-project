# Seeded state and Pulse Map

Teaching model, not clinical software. All data and timings are synthetic. The simulator has no network or database adapter; the Control Room and the standalone Inventory lab hold separate state.

## Configuration and generation

`core/simulation-config.ts` validates version 1, a nonempty seed (up to 80 characters), explicit timezone start clock (2020–2100), a bounded preset, and a named scenario. Unknown keys and invalid persisted configurations are rejected. Default: `monsoon`, Development, `2026-10-28T03:30:00.000Z`. The UI displays Asia/Kolkata time independently of the host/browser timezone.

`core/random.ts` uses FNV-1a UTF-16 seed hashing and Mulberry32. Geography, population, stock, historical issues and run events have named independent streams. The RNG has explicit 32-bit state. The engine uses no `Date.now()`, `new Date()` without an argument, `Math.random()`, network I/O, framework or server imports.

`core/state-generator.ts` keeps the four Stage 0 districts and their approximate centers fixed, then generates institution/donor coordinates within those districts. Institutions are labelled Demo Bank/Hospital; donors have synthetic nicknames and no contact data. The source plan's approximate group weights are O+ 35.1, B+ 30.5, A+ 21.6, AB+ 7.3, O− 2.0, B− 1.7, A− 1.2, AB− 0.4, normalized from a total of 99.8. This is a synthetic sampling assumption, not a demographic claim for the four districts.

| Preset | Banks | Hospitals | Donors | Initial components | Historical issue records |
|---|---:|---:|---:|---:|---:|
| Development | 4 | 4 | 200 | 120 | 112 |
| Demo | 20 | 50 | 5,000 | 900 | 840 |

Initial units have valid product lifetimes, clear mock screening and verified mock storage. Donor last-donation/eligible dates incorporate the latest seeded collection. Historical issues are aggregate records over the preceding 14 days; they are not linked to active units or included in run metrics. They provide the future Stage 10 baseline without manufacturing lifecycle records or clinical outcomes.

| Scenario | Controlled condition |
|---|---|
| `monsoon` | Baseline generated supply/demand |
| `last-o-negative` | Exactly one available O− PRBC; two one-unit requests at different hospitals |
| `stock-shortage` | Exactly one available O− PRBC; a two-unit request |
| `near-expiry` | Twelve initial platelet units expire at +1 hour; six-hour expected-use deadlines prevent their issue |
| `dengue-season` | Initial platelet request and an additional platelet Poisson arrival stream |

Scarcity fixtures deliberately override the statistical distribution. Scenario settings are fixed project assumptions, not provider, medical or seasonal measurements. At Stage 3 the last-unit result is an isolated single-worker ordering demonstration; it makes no distributed concurrency guarantee.

## Clock and event order

`Simulator.advanceBy(integerMilliseconds)` is the only way the core advances time. It retains sub-tick remainder and executes every fixed five-minute tick up to the target. Splitting an advance into arbitrary chunks gives the same state as a single advance. A run is bounded to 30 days. Starting, pausing or speeding playback never changes the random stream or fixed simulation clock.

Every tick processes:

1. Inventory expiry at `now >= expiresAt` before any matching.
2. Transfer arrivals: receive at the destination or record expiry during transit.
3. Due screening: all five non-reactive results permit availability; a shared reactive result discards the donation's three products.
4. Poisson request arrivals with synthetic morning and weekend/night patterns; dengue adds platelet-only arrivals.
5. Poisson donation opportunities, including increased weekend daytime opportunities. Search for an eligible synthetic donor using Stage 2's configurable conservative 120-day rule. A donation creates PRBC, platelet and FFP products with the original collection instant, verified mock storage, and six simulated hours in testing. No eligible donor means no manufactured supply.
6. A demonstration transfer at the first tick and at daily boundaries when eligible stock exists. Pick an available non-O− component by earliest expiry with an hour of travel headroom and move to the next bank. This is a simple visualization policy, not distance routing or Stage 10 optimization. Ownership stays at the source until receipt; a separate in-transit set removes it from both banks' available stock and all matching pools.
7. Retry open/partial requests in stable creation order, escalating remaining unmet quantity at the six-hour deadline. Apply Stage 2 exact/compatible preferences and FEFO. Tick-local sorted indexes avoid reassessing every unit for every request; final candidates still pass `matchInventory`, `RESERVE` and `ISSUE` through the domain engine. Plasma Rh variants remain equal preference. Mock FFP preparation is explicitly confirmed in this isolated simulation.

Matched components become ISSUED and requests become PARTIAL or ALLOCATED. No handover, transfusion or completed request is invented. Issued units are consumed from supply and are not included in inventory expiry. Stage 4 adds the emergency/donor-wave/handover journey. Stage 6 adds real atomic persistence.

## Worker and UI

`workers/simulation-runtime.ts` handles load, play, pause, speed, advance, reset and replay. `simulation.worker.ts` provides fixed 250 ms pacing callbacks, independent of measured wall-clock drift. Speeds 1, 60, 3,600 and 86,400 multiply injected pacing deltas; slow hardware/timer throttling can make actual playback slower than its nominal speed. Core outcomes at a given simulated duration remain identical.

Explicit advance/replay work is split into one-hour chunks with event-loop yields, so pause/reset commands can interrupt it. Automatic playback executes at most six simulated hours per callback at the highest speed. The main thread receives aggregate snapshots, the latest 20 activities and recent/active transfers, not the donor population or complete unit arrays. Worker termination on unmount cancels its timers/state. `/system` retains an initialization-only handshake using the same worker.

The map uses a dependency-free offline SVG equirectangular projection of the pilot coordinates. District halos and coastline are illustrative; there is no external map service, real facility list, turn-by-turn routing or physical-device certification. Markers support keyboard activation; bank selection also has an HTML selector. Eight ring segments indicate stock presence by group, while central counts and detailed meters show available component units. Group/component filters update counts without changing matching policy or the underlying dataset. Days-of-supply forecasting is deferred.

Only the validated loaded configuration is stored under `pulsegrid.simulation.v1`; no donors, units, progress or tenant data is persisted. Load applies draft controls and starts a new paused run. Reset rebuilds the loaded fixture. Replay rebuilds it and advances to the current elapsed duration, then pauses. Reload restores configuration at time zero. Corrupt/unavailable storage falls back visibly; invalid user configuration preserves the last working run. Worker errors show a recovery message.

## Metrics

| Label | Definition |
|---|---|
| Requests | All requests generated/introduced since simulation start; historical issues excluded |
| Stock fulfilment | Requests with every required unit matched/issued ÷ all requests; empty denominator displays unavailable |
| Median/p95 match | Nearest-rank creation-to-full-match latency in simulated minutes; partial/unresolved requests excluded; no samples displays unavailable |
| Expired | Component units reaching EXPIRED while in inventory; percentage = expired ÷ all initial/new component units in the run |
| Available stock | AVAILABLE, unexpired, screened mock units outside transit; testing/issued/expired stock excluded |
| Heartbeat | Requests created in `(now − 60 min, now]` divided by 60 simulated minutes; ECG indicates recent activity and is not measured cloud throughput |

Six-hour timeouts and five-minute event resolution are teaching assumptions. Low median match time does not imply physical transport, screening, handover or transfusion occurred instantly. No-request/zero-stock states remain valid. The small eligible population can run out during a month; the model retains the resulting shortage.

## Size, limits and replay

`measureDataset` counts exact UTF-8 JSON bytes and budgets four times that size against a deliberately small 64 MiB project allowance. `npm run simulation:report` compiles under ignored `.tools/simulation-report`, generates both datasets, simulates 30 days, and emits initial size, host timings, final metrics and SHA-256 of the complete deterministic state. It performs no writes except its ignored compiler output and never accesses a provider.

The measured default demo JSON is 2,047,323 bytes (~1.95 MiB); fourfold allowance is 8,189,292 bytes (~7.81 MiB). Development is 127,348 bytes. The allowance is conservative planning, not a measurement of BSON or indexes. On 2026-10-28, [Atlas Free cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) documented 0.5 GB for uncompressed BSON plus indexes; the [cluster comparison](https://www.mongodb.com/docs/atlas/manage-clusters/) lists 512 MB. Stage 5 must measure the actual seeded database plus indexes and remaining account headroom before enabling a database import. There is no Atlas seed/reset command in this stage, and no simulated tick persistence.

Worker setup/structured-clone communication and lifecycle were checked against [MDN Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers). Existing domain rules and source qualifications remain in `docs/domain-engine.md` and the surrounding Stage 0 context.

Run `npm run check`, `npm run test:e2e` against the production build, and optionally `npm run simulation:report`. Tests cover both presets and references, distributions, every scenario, full-month byte replay, arbitrary chunk boundaries, absence of ambient randomness/wall-clock reads, domain ordering equivalence, screening gates, donor intervals, expiry equality, matching safety, transfer accounting, metrics and playback. Browser checks cover desktop/mobile filtering, keyboard selection, arcs/activity, saved/invalid configuration, day replay, larger preset play/pause, responsive inputs, absent API/provider traffic and viewport bounds. Local artifacts and cloud/review limitations are recorded in `_ai_context/STAGE_3_EVIDENCE.md` outside the project repository.
