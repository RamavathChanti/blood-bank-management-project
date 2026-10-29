# PulseGrid — College Demo

A Centralized Cloud Blood Bank & Emergency Registry teaching project, scoped to Mumbai City, Mumbai Suburban, Thane, and Pune. **Teaching model, not clinical software.** All future registry fixtures must be synthetic.

Stages 1–4 provide the local inventory/matching labs, worker-driven Pulse Map and simulated Code Red journey. Stage 5 adds the Atlas schema, scoped APIs, Clerk login and guarded seed/reset tooling. Stage 6 adds Bank/Hospital lifecycle workflows, transactional reservations, retry receipts, maintenance and The Duel. Stage 7 adds Inngest emergency orchestration and an authenticated Durable registry mode in Code Red. Simulation surfaces remain separate and do not write to Atlas. Live Atlas/Clerk/Vercel/Inngest provisioning and cloud acceptance still need account access. See the [registry setup](docs/registry.md), [reservation guide](docs/reservations.md), and [workflow setup, API and replay guide](docs/workflows.md).

## Run locally

Stage 11 adds **Unit Passport** at `/unit-passport`: an isolated nine-event
SHA-256 tamper/reset demo, authenticated HMAC verification, transactional audit
appends, a private integrity meter, retained admin alerts and daily Merkle
anchors. See [audit setup, replay and trust limits](docs/audit.md). Set a stable
server-only 32-byte hex `AUDIT_HMAC_SECRET` before registry seeding or inventory
writes. The local browser demo still needs no credentials. Scheduled jobs,
external GitHub publication and staff email are opt-in and disabled by default;
local checks do not certify hosted cron, Atlas, email or a public witness.

Stage 10 adds **Blood Weather** at `/waste-lab`: configurable weekly/platelet
forecasts, held-out baseline/Holt–Winters scores, optimized transfer planning,
and four reproducible monthly policy comparisons. `npm run waste:report` emits
the measured results and replay SHA-256. The [waste and forecasting guide](docs/waste-forecasting.md)
defines every metric, synthetic camp/alert assumptions, and the idempotent daily
Inngest proposal job. State admins can inspect scheduled proposals in `/registry`.
Hosted cron/quota acceptance remains pending cloud access.

Stage 9 adds the phone-first `/donor` audience app, an install manifest and QR,
encrypted Web Push, expiring synthetic sessions, offline IndexedDB responses and
accepted/declined counts on staff Code Red. See the [donor PWA setup and device
rehearsal](docs/donor-pwa.md). Local browser checks do not certify real Android or
installed iOS push delivery; the shared HTTPS/device rehearsal remains required.

Install Node.js **24.x** and npm. The major version is pinned in `.nvmrc`, `package.json`, and CI, matching Vercel's supported runtime. No service account or key is needed for Stages 1–4.

```powershell
cd 'C:\desktop\CC PROJECT\project'
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. Copying the example environment is optional at this stage. For a fresh clone, change into its repository directory instead of the absolute workspace path above.

```text
npm run lint          # ESLint, including boundaries for core/workers
npm run typecheck     # Generate Next route types, then TypeScript
npm test              # Vitest core tests
npm run test:integration # Real temporary MongoDB replica set, mocked Clerk identity
npm run test:workflow  # Actual local Inngest service, production workflow functions and temporary MongoDB
npm run test:cache     # After build: real production Next cache, database outage and recovery (~65s)
npm run workflow:dev   # Local Inngest UI/worker orchestration; set INNGEST_DEV=1 in the app
npm run registry:local-report # Seed sizes, indexes and transaction probe without accounts
npm run check         # All three above, then production build
npx playwright install chromium
npm run test:e2e      # Starts and stops its own production server; build first
npm run test:preview  # Exact PLAYWRIGHT_BASE_URL required; deployed smoke and optional signed race
npm run simulation:report # Measure both datasets and replay a month; JSON to stdout
npm run emergency:report  # Replay Code Red scenarios and seeded probability checks
npm run start         # Serve a previously built production app
```

Playwright tests desktop and phone-sized Chromium. It covers inventory explanations, FEFO reserve/cancel/issue/reset, compatibility grids, Pulse Map filters and keyboard markers, transfers, day replay, scenario persistence/recovery, demo-speed play/pause and UI responsiveness, navigation, disclaimers, worker initialization, health, 404 recovery, and viewport overflow. A busy port 3000 must be freed before local smoke testing. To target a deployment instead, set `PLAYWRIGHT_BASE_URL` to its exact origin before `npm run test:e2e`.

## Source layout

```text
src/app/                 App Router layouts, pages, boundaries, API handlers
  api/health/            Node.js liveness, no-store, no provider connectivity claims
src/components/          Shared navigation, feature screens, browser worker check
  ui/                    Text-labelled status badges and loading/empty states
src/core/                Pure TypeScript; no framework, browser, server, or provider imports
src/lib/                 Public site constants and planned-feature copy (no secrets)
src/server/              Server-only data access boundary; import "server-only"
src/inngest/             Typed events, SDK client and durable emergency functions
src/workers/             Typed protocol, isolated simulation runtime and pacing scheduler
scripts/                 Local simulation sizing/monthly report (no provider access)
tests/unit/              Vitest pure logic checks
tests/e2e/               Playwright user journeys
.github/                 CI, deployed-preview smoke, and pull-request template
```

Simulation/public routes: `/`, `/inventory`, `/match-lab`, `/code-red`, `/duel`, `/unit-passport`, `/waste-lab`, `/public-board`, `/system`. Registry portals at `/bank`, `/hospital`, `/donor`, `/registry` access private data only through authenticated `/api/registry/*` endpoints. Bank/Hospital include collection, screening, request, reservation, issue and synthetic-use actions. `/sign-in` and `/sign-up` integrate Clerk when configured; new accounts have no membership by default. Every page includes the teaching disclaimer. `/system` initializes an explicit `monsoon` seed and teaching clock; it does not write to Atlas.

The Control Room runs simulation in its own worker. Only validated configuration is persisted in browser storage; reload starts paused at zero. Keep this simulation state outside Atlas. Future database modules must import `server-only`; MongoDB API routes must explicitly export `runtime = "nodejs"`. Current `/api/health` follows that runtime convention and reports `not-reported` when Vercel has not provided its actual region. A liveness success is not a database-health result.

## Environment and secrets

Stage 8 adds [bounded live polling and the cached Public Board](docs/live-updates.md). The Control Room shows a separate live registry summary alongside its simulator. `/api/public-board` exposes only district/group/component bands, with Next Data Cache revalidation and observed CDN cache headers. No new runtime service key is needed for polling. The guide records privacy/cache policy, outage behavior, full preview smoke configuration and the remaining two-session cloud rehearsal.

`.env.example` lists names and non-secret defaults only. Stage 5 uses `MONGODB_URI`, `MONGODB_DB_NAME`, `CLERK_SECRET_KEY`, the deliberately public `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, Clerk path defaults, and optional server-side `CLERK_AUTHORIZED_PARTIES`. A credential-free build and simulator remain supported; private APIs return 503 when auth is unconfigured. Configured but signed-out sessions receive 401. Stage 7 adds `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `WORKFLOW_RECEIPT_SECRET`, local-only `INNGEST_DEV`, and optional `WORKFLOW_DASHBOARD_URL`; see [workflow setup](docs/workflows.md). Optional push, external audit email/publication and chaos controls use separate opt-in configuration; see their stage guides.

Local secret files, Vercel account state, caches, and reports are ignored. Set actual service values in Vercel separately for Development, Preview, and Production when those stages begin. Use separate synthetic demo databases and credentials for preview/production. Only a Clerk publishable key may use the public prefix; never prefix MongoDB, Clerk secret, workflow, or bypass credentials with `NEXT_PUBLIC_`. Server-only modules must never be imported by client components, workers, or pure core code. The health response never includes credential presence, values, or connection strings.

## GitHub and Vercel setup

Git actions require the user's explicit chat authorization under the surrounding project rules. No remote, branch, commit, pull request, branch protection, or deployment is implied by these files. Follow CONTRIBUTING.md after authorization.

1. Use a personal GitHub account and a repository containing this directory's contents. Commit the lockfile and `.github/` with the source; never commit local secrets or tool output. Open the Stage 1 feature branch as a pull request to `main` and let `checks` run.
2. Import that repository into Vercel using the eligible personal Hobby account. Select Next.js, Node **24.x**, production branch `main`, and the checked-in `npm ci` / `npm run build` commands. Record the account's actual eligibility and compute mode.
3. **Root Directory is relative to the Git repository, not this Windows workspace.** With the mandated repository rooted at `project/`, select `.` (or leave Root Directory empty). If a separately authorized repository instead contains a `project/` child, select `project/` and move/adapt GitHub workflows to its repository root with `working-directory: project`. Do not set `project/` for a repository already rooted here: that would point Vercel to a nonexistent nested folder. The existing project rule requires Git setup to stay inside this folder, so the first layout is the selected baseline.
4. `vercel.json` selects a single Mumbai function region, **`bom1`**, for the Node handler. Prefer Atlas AWS Mumbai when provisioned in Stage 5. This is configured intent, not proof of cluster placement. If Free Atlas offers Singapore instead, change the Vercel region to **`sin1`** and redeploy. Static pages still use the CDN.
5. Deploy the pull request, record its exact URL and source revision, and verify `/api/health` reports `runtime: nodejs`, Node 24, `region: bom1`, and disconnected integrations. Run the UI smoke suite on that URL and replay it with a named reviewer.
6. Merge the reviewed passing change and verify the production URL from `main`. Record both deployments, their actual function region, and collaborator preview behavior in `_ai_context/STAGE_1_EVIDENCE.md` outside the repo (or the team's evidence store after cloning).

Vercel Hobby's private-repository author restrictions can block teammate previews. Verify the actual account/repository arrangement before promising automatic deployment for every collaborator. The fallback is an eligible owner-managed deployment with its review path recorded. Do not alter authorship, change visibility, or purchase a plan automatically.

## CI and deployed-preview smoke

`CI` runs on pull requests, pushes to `main`, and manual dispatch. It needs no service secrets. The `checks` job verifies lint, types, core tests, local replica-set API integration tests, production build, and browser smoke against that build. First integration execution downloads the MongoDB test binary; it never contacts Atlas or authenticates to a real Clerk instance.

Before enabling deployed smoke, create a GitHub Environment named `preview-smoke`. Set `PREVIEW_PROJECT_SLUG` to the Vercel project name, for example `pulsegrid`, and `PREVIEW_HOST_SUFFIX` to the actual account/team suffix, for example `my-team.vercel.app` for previews such as `pulsegrid-git-feature-my-team.vercel.app`. Verify both against the first real preview. If Vercel protection blocks tests, add the server-only `VERCEL_AUTOMATION_BYPASS_SECRET` there using an account-supported automation bypass. Otherwise leave it unset. Add environment reviewers as appropriate.

`Preview smoke` accepts successful non-production deployment events from `vercel[bot]`, or a manually supplied preview origin. It validates HTTPS and the configured hostname suffix before exposing the bypass credential, executes tests from the trusted default branch, and disables trace recording when that credential is present. Fork pull-request code does not run with the secret. Custom preview domains need an intentional validator update. Protected previews without a supported bypass need an authorized manual replay; do not claim that an authentication redirect passed a smoke test.

## Manual replay and review

Open the Control Room, follow Inventory, and confirm the labelled local fixture and disclaimer. Open System foundation, choose Check worker, and expect “Worker ready · fixed seed and clock received.” Reload; there is no persisted registry state. Tab from page load to Skip to content and activate it. Repeat on a narrow phone viewport, including the horizontally scrollable navigation. Visit an unknown route and use Return to Control Room. Inspect the health JSON independently.

Before declaring Stage 1 complete, record the local check results, exact preview and production URLs/revisions, successful CI runs, a named reviewer replay, actual deployment region, account eligibility, and private-repository collaborator behavior. Local checks alone do not satisfy that cloud/review gate.

## Stage 2 domain engine and replay

Open `/inventory`: A+ PRBC, two units, use in two hours selects `DEMO-002` before `DEMO-001`. An earlier-expiring O-negative unit is conserved. Each excluded unit shows its reasons. Reserve selected locally, cancel, reserve again, then issue; lifecycle events show the same FEFO order. Issue alone never completes the request. Reset restores stock and clears table filters. Select O-negative and two units to see a one-unit shortage. Select FFP to see the explicit synthetic preparation confirmation on the issue action. Table filters only affect display, not the matching pool. Reloading/navigating away discards this page's state.

Open `/match-lab`: select PRBC, FFP, or platelets; click any donor/recipient cell or use the selectors. Each cell has an accessible result label. Plasma reverses ABO and ignores RhD. Platelets are deliberately limited to identical ABO/RhD. See [domain engine contracts](docs/domain-engine.md) for types, lifecycle, preference ordering, clock semantics, configurations, and integration limits.

## Stage 3 Pulse Map and replay

Open `/`. The default is `monsoon`, Development, fixed `2026-10-28T03:30:00.000Z` (09:00 IST), paused. Choose a scenario and **Load scenario**, then Play or Advance 1 hour/day. Speeds range from 1× to one simulated day per pacing second. Pause cancels playback/replay work; Reset rebuilds the loaded fixture. Replay elapsed time rebuilds the fixture and advances to the same duration. Reload restores the seed/preset/scenario/start clock and starts at zero. Configuration is separate from the existing Inventory lab.

Use group/component filters, select a bank on the map or in the Bank selector, and inspect the eight unit gauges. Keyboard users can focus map markers and press Enter/Space. Hospital crosses reveal the synthetic request source. The first transfer starts at five simulated minutes and arrives an hour later; its arc changes from pink to cyan. Transfer stock is available at neither bank during travel. The map uses an offline SVG geographic projection with illustrative coastline/district halos and generated locations; it requires no tiles, map key, or external network. It is not a real institution directory.

Presets: Development has 4 banks, 4 hospitals, 200 donors, 120 initial component units and 112 historical issue records. Demo has 20 banks, 50 hospitals, 5,000 donors, 900 units and 840 historical issue records. Named scenarios: Monsoon baseline, Last O-negative unit, Stock shortage, Near-expiry inventory, and Dengue-season demand. Scarcity scenarios start with exactly one available O-negative PRBC unit; they demonstrate stock matching only. The full emergency/donor-wave/handover journey is available separately at /code-red (Stage 4).

All times and metrics are simulated. Stock fulfilment means full matching and issue, not transfusion. The five-minute engine models Poisson demand, daily/weekend patterns, donations, three component products, six-hour screening, reactive discards, expiry, and one-hour transfers. Small donor populations can exhaust eligibility; observed shortages are retained. Detailed contracts, replay definitions, size allowances and limitations are in [simulation documentation](docs/simulation.md).

`npm run simulation:report` compiles the pure engine and local report under ignored `.tools/simulation-report`, then prints UTF-8 JSON size, a fourfold planning allowance, actual host runtime, monthly metrics and deterministic state hashes for both presets. It never accesses Atlas. The demo dataset is about 1.95 MiB JSON; actual BSON/index size must be checked before Stage 5 database seeding.

## Stage 4 simulated Code Red

Open `/code-red`. **Stock available** reserves the last O-negative unit. Start, dispatch before its ten-minute lease expires, advance 60 simulated minutes, confirm handover, then confirm synthetic use. **Stock shortage** requests two units with only one available: dispatch the partial reservation, decline or ignore donor replies, and advance three minutes three times to see 5/10/25 km waves and unresolved escalation. Every wave shows the required donor count, assumed probability, population limit and target shortfall.

**Screened recovery** extends expected use to twelve hours. Start, accept Mock donor 4, dispatch the existing unit, advance 15 minutes and collect the synthetic donation. Advance 60 minutes and confirm handover/use of the first unit. Advance 360 minutes, pass all mock screens, dispatch the new component, advance 60 minutes, and confirm handover/use. Acceptance alone never supplies screened blood. Reactive screening, cancellation, lease expiry, deadline expiry and exhausted alerts retain explicit unmet outcomes. Reset or reload clears only this page's journey.

The form's expected-use input is UTC; countdowns, travel and match measurements are simulated. Travel is straight-line-derived, not routed. Donor ranking applies eligibility, fatigue, cooldown, quiet hours and request deduplication. See [Code Red contracts and replay](docs/emergency.md) for formulas, assumptions, transitions and limitations. `npm run emergency:report` reproduces analytic/Monte Carlo checks, scenario traces and state hashes without service credentials.

## Official references

- [Next.js installation and App Router setup](https://nextjs.org/docs/app/getting-started/installation)
- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel function region configuration](https://vercel.com/docs/functions/configuring-functions/region) and [region list](https://vercel.com/docs/regions)
- [Vercel Git integration and private-repository deployment rules](https://vercel.com/docs/git)
- [Playwright CI and deployment smoke](https://playwright.dev/docs/ci)

Documentation choices checked 2026-10-28. Account-specific availability and runtime behavior still need the recorded deployment checks.
## Stage 13 surge, priority and cost

Open **Surge Lab** in Operations (`/surge-lab`) for a bounded browser queue with
Stop/Reset, retained actual local Inngest measurements, production workflow
acknowledgement reconciliation and a dated cost/limits panel. The browser model
never writes to Atlas. `npm run surge:rehearse` runs three controlled queue
comparisons and a twelve-request production-workflow burst against an owned
local Inngest service and temporary MongoDB replica set, then refreshes the
sanitized evidence JSON; rebuild to display the new sample. See the
[surge guide](docs/surge.md) for metric definitions, official pricing sources,
300-bank assumptions, stop/drain/reset behavior and the remaining hosted gate.

## Stage 12 resilience

Open **Vital Signs** in Operations for admin-only measured health, observed
runtime faults, traces, retained alarms and acknowledged-ID reconciliation.
Durable Code Red retains a cohort of receipts across intakes and session reload.
See [resilience setup, recovery and rollback](docs/resilience.md) for Global
Config / legacy Edge Config variables, measurement limits, the ten-request
rehearsal, cold/warm cache behavior, alerts and the hosted acceptance checklist.
`npm run resilience:rollback-local` measures a local routing rehearsal after a
production build; it does not deploy or roll back a hosted environment.


## Stage 14 extras

Open `/cold-room`, `/camp-planner` and `/intelligence` for the selected visual
and intelligence demonstrations. Match Lab adds reduced-motion teaching
animations and an isolated Bombay case. Enable Demo Director for scene hotkeys;
Code Red sound is opt-in. The bank watchdog uses normal signed audit transactions;
AI intake requires server-only configuration, hospital membership and explicit
human review. The ops copilot uses safe aggregate templates without an LLM.
See [extras setup, replay, evaluation decisions and limits](docs/extras.md).

## Stage 15 submission and rehearsal

Open `/try` for Things worth trying, scene resets and synthetic donor QR
participation prerequisites. The [submission setup and API index](docs/submission.md)
links exact contracts, environment names, validation and guarded seed/reset.
The workspace `_ai_context/submission/` contains the editable college report,
slides, architecture, timed 10/8/5-minute scripts, acceptance matrix, viva
answers, release gates, recorded demo and prebuilt offline simulator.
Use `npm run submission:offline`, `submission:record`, `submission:documents`
and `submission:package` to regenerate the handoff; see the package README
for Python/FFmpeg requirements. No Git action or hosted mutation is performed.
Hosted deployed smoke, college-specific metadata, independent review and actual
laptop/phone/second-presenter rehearsal remain explicit acceptance gates.
