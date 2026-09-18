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

**None of these are in `npm run gate`.** The root gate does not build or test this app, so a break
here is not caught by CI. Run them by hand, or wire them in.
