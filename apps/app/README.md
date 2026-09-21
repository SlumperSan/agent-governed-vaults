# `apps/app` — the explore surface at app.rwally.com

The vault explorer, v1. It renders one thing and it renders it honestly: the protocol is not
deployed on Arc, or on any mainnet, so the protocol card says so plainly instead of showing live
reads it does not have, above a table of vaults with no rows.

The order used to be stated the other way round here. In `index.html` the protocol card is the first
`<section>` and the vaults card the second, so the table is BELOW it.

It is deployed to the Cloudflare Pages project `rwally-app`, production branch `protocol/main`.

## What is on the page, and where each fact comes from

The protocol is not deployed on Arc, or on any mainnet, so there is no deployment record for this
page to read and no address for it to call. Every fact on the page follows from that:

| Thing | Source |
|---|---|
| The chain the protocol targets, Arc, id 5042 | Static copy in `index.html`. It names Arc itself, not anything this deployment has produced there |
| The seven contract addresses this page used to name | Nothing. The record they came from named the project's abandoned prior chain and was deleted along with it; this page names no address in its place, invented or otherwise |
| `VaultFactory.vaultCount()`, `VaultFactory.allowSubVaults()`, the oracle's settlement token | Nothing. There is no VaultFactory and no oracle on Arc to call, so `app.js` sends no `eth_call` and no `eth_blockNumber` request |
| Every vault row | Nothing. There is no `<tbody>` in `index.html` and `app.js` writes nothing into the page. The two vaults that existed on the project's prior chain were fully exited on 2026-09-18 and hold nothing |

## Three decisions that are easy to undo by accident

**1. The empty state is static markup, not a rendered value.** The sentence "This table lists no
vaults. The protocol is not deployed on Arc, so there is nothing to list." lives in `index.html`
and is never written by `app.js`, because `app.js` writes nothing: there is no live read to produce
it from. `test/claims.test.mjs` asserts the sentence is in the built HTML, so moving it into the
script, or letting some future live read stand in for it, reds the guard.

That sentence is deliberately a claim about the TABLE, not a count of vaults on some chain. Two
earlier versions of it went stale with nothing going red: one pinned a bare count that the next
`createVault` call falsified silently, the other pointed at a live `vaultCount()` read on a chain
the project has since abandoned. The guard is a static string match that reads no chain, so it can
only prove a sentence is present, never that it is true. Pin what this deployment controls, which
right now is that the table renders no rows.

**2. There is no `package.json`, and that is not an omission.** The repository root declares the
workspace glob `apps/*`. A workspace package that is absent from `package-lock.json` makes `npm ci`
fail at the root for every other session sharing this checkout, and the lock file is not this
directory's to edit. `apps/site` carries no `package.json` for the same reason. Build with:

```
node apps/app/build.mjs
```

**3. The CSP is strict enough to break the page silently if you stop respecting it.** `_headers`
ships `script-src 'self'` and `style-src 'self'` with no `'unsafe-inline'`, so an inline `<script>`
block, an inline `<style>` block and every `style="..."` attribute are blocked by the browser with
no error on the page and nothing in the build output. This is invisible on `file://` and on any
local server that does not send the header, so **verify against the deployed URL, not a local
file.** `test/claims.test.mjs` checks the markup for all three shapes for exactly this reason.

`connect-src` names no third-party origin, just `'self'`. The protocol is not deployed anywhere, so
this page makes no chain call and there is nothing to widen the policy for. The two fonts are
self-hosted copies of the faces `apps/site-next` uses, so `font-src 'self'` holds and nothing is
fetched from a font CDN.

## Layout

```
src/index.html   the page, all of it
src/app.css      the only stylesheet, palette carried from apps/site-next/src/tokens.css
src/app.js       inert. No chain call: nothing is deployed to read
src/_headers     the CSP. Copied to dist/_headers, where Pages reads it from
src/favicon.svg  the comic R on its tile, byte-identical to the site's
src/brand/       mark-comic.svg, byte-identical to the site copy in public/brand/
src/fonts/       two woff2 faces, self-hosted
build.mjs        removes dist/ and copies src/ into it
test/claims.test.mjs
```

`screenshots/` (explore-desktop-1440.png, explore-mobile-375.png) was removed from the repo in the
Phase 1 repo-cleanup pass (2026-09-15) — unreferenced by any code, build, or test, and the two
files were ~1.7 MB combined. They were reference material, not a build input; retake and attach to
a design doc/wiki page if they're needed again rather than re-committing binaries to git history.

## Tests

```
node --test --test-reporter=tap apps/app/test/claims.test.mjs
```

Seven checks: the empty-state sentence survives into the build, the page states plainly that the
protocol is not deployed, no contract address of any kind survives into the build, no banned claim
shape appears in any built file, `_headers` carries every required directive and names no external
origin in `connect-src`, the markup has no inline script or style, and the page makes no request to
any origin at all, with `app.js` carrying no `fetch()` call.

**It runs in CI and in the gate, as its own step.** The root `package.json` declares `test:app`,
`.github/workflows/ci.yml` runs it at line 137, and `scripts/gate.mjs` invokes it immediately before
`test:backend`. It is deliberately NOT a glob inside `test:backend`: this file rebuilds `dist/`,
and the repository-wide walks in `test:backend` enumerate files first and read them after, so
batching them together lets this build delete a path another guard has listed and not yet opened.

This paragraph previously said it was not wired in and to run it by hand. That stopped being true
when `test:app` was added, and a stale instruction to run a check manually is worse than none: it
invites someone to conclude the check is optional.

The repository-wide claims guard, `scripts/test/claims-lede-truth.test.mjs`, **does** walk this
page once it is built: `dist` is deliberately absent from that file's `SKIP_DIRS` and `.html` is in
its `PUBLIC_EXT`. Build before running the gate, or the guard reports a pass over prose it never
read.

## Deploy — DO NOT. This directory is retiring, and deploying it reverts the member surface

**The copy-pasteable command that used to be here is removed rather than annotated.** It was correct
when written. It is now a way to silently undo the cutover: this directory and `apps/vaults-ui` claim
the **same** Cloudflare Pages project (`rwally-app`, production branch `protocol/main`), the DNS is
already pointed, and there is no staging step — so a deploy from here replaces the member surface the
instant it finishes, with no warning and nothing reding in the gate.

What it would put back: this page, **reading chain 4663, which the protocol is no longer on.** Its
live reads were never re-pointed at Arc and, per the owner's 2026-09-19 decision that
`apps/vaults-ui` takes this address, they will not be.

If a genuine rollback is ever wanted it is the owner's call, made knowing it restores a chain the
protocol left — not something to reconstruct from a runbook. See the
[README's Production Map](../../README.md#production-map), which is the single source of truth for
what serves `app.rwally.com`, and [`DEPLOYMENTS.md`](../../DEPLOYMENTS.md).

Build details, for whoever has to read this directory rather than publish it: build with
`node apps/app/build.mjs` (there is no `package.json` here on purpose — npm workspace glob concerns).
Pages picks up a Functions bundle from `./functions` at the working directory; there is no such
directory here and there should not be one.

## What is deliberately not built

Everything in `Design/app-spec-2026-09-05.md` past v1's first screen: the vault detail page, the
hive activity screens, stake, vote, and every wallet action. The Connect control in the masthead is
inert and says so, carries `aria-disabled` rather than `disabled` so it keeps its place in the tab
order, and names its reason through `aria-describedby`.

The control is inert because this page has no wallet code at all: `app.js` sends no
`eth_requestAccounts`, does no signing, and touches no `window.ethereum`. That is true independent
of whether the protocol is deployed anywhere, so the title and the note say what is true of this
page rather than of chain state, and they say the same thing as each other: a sighted reader gets
the `title`, a screen-reader user gets the `aria-describedby` note, and those two disagreeing is
its own defect.
