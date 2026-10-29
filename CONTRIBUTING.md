# Contributing

Use Node 24 and `npm ci`. Keep domain logic in `src/core/`, server-only access in `src/server/`, and browser simulation in `src/workers/`. See README for the boundaries and verification commands.

The requested repository owner is a personal GitHub account. The repository should contain the contents of this `project/` directory, including `.github/`. The surrounding `_ai_context/` directory is local project context, outside this repository.

After the user explicitly authorizes Git actions, initialize the repository here if needed, name the default branch `main`, and create short-lived branches such as `feat/stage-1-foundation` or `fix/worker-startup`. Open a pull request into `main` with the supplied template. Do not work directly on `main` for normal feature changes.

Require the `checks` CI job, a current branch, and one independent approval on `main` where the account/repository plan supports those rules. If enforcement is unavailable, use the same manual review checklist and record that protection is advisory. Resolve review comments before squash merging. A solo self-check is not independent review; record it explicitly and seek a peer replay.

Every pull request needs a working Vercel preview URL, revision, check results, and named replay reviewer. Vercel Hobby restrictions can prevent collaborators' private-repository commits from deploying. Use an eligible owner-managed path and record its actual behavior; do not change authorship or make the repository public to evade a restriction.

CI runs lint, generated route types plus TypeScript, core tests, a production build, and desktop/mobile Chromium smoke checks. Preview smoke runs after an eligible Vercel deployment status or by manual dispatch. Configure the `preview-smoke` GitHub Environment first, as described in README.

Never commit `.env.local`, credentials, real medical data, generated build output, browser reports, or local tool caches. Never add a server secret to a `NEXT_PUBLIC_*` variable. An intentional operational change needs synthetic fixtures, meaningful checks, and updated documentation before its checklist task is marked complete.
