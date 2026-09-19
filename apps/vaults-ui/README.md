# `apps/vaults-ui` — vaults, proposals, votes, holdings

A React surface over the allocator front end's logic. Four reads over one vault: the vault list,
the position, the open proposal with its votes, and what the vault holds.

## It does not implement any of the numbers

Every governed figure is derived by a module under `apps/web/src/`, each of which mirrors a
contract term for term and has a test under `apps/web/test/` that runs in `npm run test:backend`.
`vite.config.ts` aliases `@atlas/*` onto those files and `src/lib/atlas.ts` is the only place that
imports them. A component that recomputed a quorum or a fee would be a second implementation of a
consensus rule, drifting from the first the moment either changed.

`src/lib/atlas-modules/*.d.ts` are hand-written types for those untyped ESM modules. **They are
the weak point of this app and they have already been wrong once**: `proposalPhase` was declared as
returning a string, TypeScript believed it, and the page threw at render because it actually
returns `{phase, index, deadline, deadlineLabel}`. `tsc` and `vite build` both passed. If you
change a declaration here, run the smoke below — it is the only thing that checks these against
the real modules.

## What it renders from

`apps/web/src/fixtures.mjs` — the allocator front end's test fixtures, not a live chain read. The
page says so on screen. Pointing it at a chain means swapping the two imports in `src/App.tsx` for
`apps/web/src/live-adapter.mjs`; no component knows where a vault came from.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run typecheck` | `tsc -b --force` |
| `npm run lint` | oxlint |
| `npm run smoke` | Server-renders `App` once and fails if it throws |
| `npm run build` | typecheck + client bundle |

**`typecheck`, `lint` and `smoke` are still not in `npm run gate`.** What IS covered, as of
2026-09-19, is `test/` — `npm run test:backend` enumerates `apps/vaults-ui/test/*.test.mjs`, so the
gate's `backend` step runs it, and `test/csp.test.mjs` runs `npm run build` in its own `before`
hook rather than skipping when `dist/` is absent. **So a broken `vite build` here now fails the
gate**, and a type error that `tsc` alone would catch still does not. Wiring the rest needs a
matching pair of steps in `scripts/gate.mjs` and `.github/workflows/ci.yml`, because
`scripts/test/wired-scripts.test.mjs` refuses a package script that only one of the two invokes.

## Deploying

**Settled.** The owner decided on 2026-09-19 that this workspace takes `app.rwally.com` and
`apps/app` retires into it rather than standing beside it — one member surface, one address, no new
name to market. `wrangler.toml` here carries the **existing** Pages project, `rwally-app`, pointed
at this source directory rather than `apps/app`'s.

```bash
npm run build --workspace apps/vaults-ui
cd apps/vaults-ui && npx wrangler@latest pages deploy dist --project-name=rwally-app --branch=protocol/main
```

**THE NEXT DEPLOY AGAINST THAT PROJECT REPLACES THE LIVE VAULT EXPLORER.** The DNS is already
pointed, so there is no cutover step to forget and no moment where the change is staged — it is live
the instant the deploy finishes. That is the intended end state and **it is the owner's call, not a
deployer's.** This repository has already shipped the wrong directory to a live Pages project once.

The rest, unchanged and still worth knowing:

- **Output directory is `dist/`**, which is what the Pages project's build output points at.
- **`public/_headers` is the edge policy**, and Pages reads it from the root of the SERVED
  directory, which is why it lives in `public/` and not beside `wrangler.toml`. `test/csp.test.mjs`
  asserts it lands at `dist/_headers` byte-identically and that the policy still matches what the
  build emits, so a deploy that would have shipped no policy reds in the gate instead.
- **There is no `functions/` directory and there should not be one.** Pages bundles Functions
  relative to the directory wrangler runs in, which is why `apps/site` keeps its `wrangler.toml`
  beside `apps/site/functions`. This app has no Function and needs none. `apps/app/README.md`
  records the hazard from the other side: Pages picks up a Functions bundle from the working
  directory if one is sitting there.
- **One thing to check before the first deploy:** `connect-src` is `'self'`, because this app reads
  bundled fixtures rather than a chain. The moment it is pointed at `apps/web/src/live-adapter.mjs`,
  the one RPC origin has to be added to `public/_headers` **in the same commit as the code that
  calls it**, or every read is refused by the browser.
