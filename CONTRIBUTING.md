# Contributing

## ⚠ Feature freeze — read this before opening a new-surface PR

**New feature and new-surface proposals are paused** until the Production Map in the
[README](README.md#production-map) is finalized and the Phase 1 cleanup lands. In scope for the
freeze:

- New `apps/*` directories (new sites, new front ends, new services).
- New public endpoints (new paid or free routes, new API surfaces).
- New domains (anything beyond the surfaces already named in the Production Map: `rwally.com`,
  `app.rwally.com`, and the planned-but-unbuilt `status.rwally.com` / `docs.rwally.com`).

**A PR proposing a new surface during the freeze is deferred, not rejected.** Open it, say
plainly in the description that it's a new-surface proposal, and expect it to sit until the
Production Map is finalized — it will not be closed for that reason alone. This exists because the
repository just resolved one live conflict from surfaces multiplying ahead of a single source of
truth (a duplicate paid endpoint that had settled on the wrong chain, now removed — see the
Production Map's history), and the freeze is how we avoid creating the next one while that map is
still settling.

Bug fixes, docs, tests, chores, and work on **existing** surfaces (`apps/site-next`, `apps/app`,
`apps/api`, `apps/web`, and the contracts) are not affected by the freeze.

## Branch naming

This repository uses a `<type>/<short-description>` convention. Observed prefixes in this repo's
history, use whichever fits:

| Prefix | Use for |
| --- | --- |
| `feat/` | New functionality |
| `fix/` | Bug fixes |
| `docs/` | Documentation-only changes |
| `chore/` | Maintenance, dependency, tooling, config work |
| `test/` | Test-only changes |
| `ops/` | Operational tooling, CI, drills |
| `audit/` | Audit-finding remediation (e.g. slither triage) |
| `site/` | Site copy/design changes scoped to a specific site surface |
| `design/` | Design specs and visual passes |
| `deploy/` | Deployment records and runbooks |

Pick the prefix that matches the *primary* nature of the change; keep the description short and
hyphenated (e.g. `docs/governance-files`, `fix/site-open-redirect`).

## Test gate

Before opening a PR for review, run the full gate locally:

```bash
npm install && npm run gate
```

`npm run gate` mirrors [`.github/workflows/ci.yml`](.github/workflows/ci.yml) step for step:
`forge fmt --check`, entrypoint syntax, `forge build`, the ops check, the backend suite,
`forge test`, the gas snapshot, the EIP-170 runtime size check, and advisory slither. Run
`npm run gate --list` to see what each step does and where it deliberately diverges from CI. A PR
that doesn't pass `npm run gate` should say so explicitly and why, rather than being opened silently
red.

Individual suites can still be run standalone (`cd contracts && forge test`, `npm run
test:backend`, `npm run test:app`) while iterating, but the full gate is what's expected before
requesting review.

## PRs open as drafts

**Every PR in this repository opens as a draft.** That is the norm here, not an exception: draft
status signals "in progress, not yet asking for review," and moving a PR out of draft is itself a
signal that it's ready for the owner's explicit review. Do not mark a PR ready for review, and
never merge, without that explicit owner sign-off — this applies even to PRs that pass the gate
cleanly, and especially to anything touching `contracts/`, `apps/api`'s payment path, or a live
deploy target (see [DEPLOYMENTS.md](DEPLOYMENTS.md) for what's currently live).

## Where to look first

- [README.md](README.md) — protocol overview, current deployment status, the Production Map.
- [docs/NOW.md](docs/NOW.md) — what's in flight right now, and what's blocked on a human; run
  `npm run cc` alongside it for the live computed state.
- [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md) — the launch gate board, argued.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) —
  before touching contracts.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability; do not use a public issue for that.
