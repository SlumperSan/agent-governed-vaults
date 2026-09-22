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

**Live chain reads. No fixtures reach this app.** `src/lib/live-vaults.ts` calls
`apps/web/src/chain-reader.mjs`'s `plan*`/`assemble*` functions over viem, bound to the chain
`VITE_CHAIN_ID` declares (`packages/chain-config/src/chain-binding.mjs`, issue #204 — the client
refuses to read unless the RPC actually answers for that chain id). `apps/web/src/fixtures.mjs` is
the allocator front end's OWN test fixtures and nothing in this workspace's `src/` imports it;
`test/csp.test.mjs` fails the build if that ever changes.

**Three env vars, build-time only** (Vite inlines `import.meta.env.*` — a served page cannot read
them at runtime): `VITE_RPC_URL`, `VITE_CHAIN_ID`, `VITE_VAULT_ADDRESSES` (comma-separated). Unset —
which is the state of a production build today, since nothing from this repository is deployed on
Arc mainnet yet (`contracts/config/arc-mainnet.json`'s own `status` field says so) — and the page
renders an honest "not configured" state, never a bundled sample. `cp .env.example
.env.development.local` sets all three against **Base Sepolia**, the one live-read path this
repository can prove end to end right now (`contracts/config/deployments/base-sepolia.json`'s smoke
vault, with nothing to fill in — see the template's own header), so `npm run dev` exercises real
chain reads. Vite never loads `.env.example` itself, same convention as the root `.env.example`.

**Before the Arc cutover:** set the three vars in the Cloudflare Pages build environment for this
project, **and** update `public/_headers`' `connect-src` to the production RPC origin, in the same
commit — see that file's own comment on the directive, and `test/csp.test.mjs`'s coupling test,
which fails if `.env.example`'s `VITE_RPC_URL` and `_headers`' `connect-src` disagree.

**`VITE_VAULT_ADDRESSES` is cross-checked against `contracts/config/deployments/*.json` in
`npm run gate` and CI** (`scripts/vault-addresses-lint.mjs`, card A2), BLOCKING, not advisory. Every
address you set here must name a real deployed vault, on the chain this file's own `VITE_CHAIN_ID`
declares — an address that exists but on a different chain fails distinctly from a plain typo, since
it is the worse mistake. Before hand-editing this value on deploy day, run
`node scripts/vault-addresses-lint.mjs` (or just `npm run gate`) rather than trusting the edit.

**Not wired here:** a connected wallet's own position (shares, cost basis, queued exit,
pending-deposit and vote-custody reads — `chain-reader.mjs`'s `planPosition`/`planVoteCommit`).
`feat/wallet-connect-and-sign` adds the wallet connection this app needs before those reads have a
member address to read for; this app shows an honest "connect a wallet" notice in that slot.

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
- **`connect-src` already names an RPC origin** (`https://sepolia.base.org`, the provable
  Base Sepolia config — see "What it renders from" above), because this app now reads a chain
  rather than bundling fixtures. **Before deploying against a different `VITE_RPC_URL`, update
  `public/_headers`' `connect-src` to match, in the same commit**, or every read is refused by the
  browser with no build-time warning.
