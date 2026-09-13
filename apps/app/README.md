# `apps/app` — the explore surface at app.rwally.com

The vault explorer, v1. It renders two things and it renders both honestly: a protocol card whose
three most load-bearing facts are re-read from chain 4663 in the reader's own browser every time the
page loads, above a table with one row per vault, read the same way.

The order used to be stated the other way round here. In `index.html` the protocol card is the first
`<section>` and the vaults card the second, so the table is BELOW it.

It is deployed to the Cloudflare Pages project `rwally-app`, production branch `protocol/main`.

## What is on the page, and where each fact comes from

| Thing | Source |
|---|---|
| The seven contract addresses, the chain id, the deploy block and instant | `contracts/config/deployments/robinhood-mainnet.json` at `origin/protocol/main`, which records every one of them as read back from the chain with `cast` at block 54,991,182 |
| `VaultFactory.vaultCount()` | An `eth_call` from the browser, on load |
| `VaultFactory.allowSubVaults()` | An `eth_call` from the browser, on load |
| `ChainlinkOracle.usdc()`, then `symbol()` on the token it names | Two `eth_call`s from the browser, on load |
| The block the reads landed at | `eth_blockNumber`, same load |
| Every vault row | `VaultFactory.allVaults(i)` for each index, then four `eth_call`s per vault (`navWad`, `totalShares`, `holderCount`, `capacityCapUsdc`), all from the browser on load. `1 + n + 4n` calls in total, so the cost grows with the vault count |
| The "Age" and "Performance vs SPY" columns | Nothing, and they were removed rather than left blank. `VaultCore` exposes no `createdAt()` and no `name()`, and per-vault performance against an index needs price history this page does not hold. A header promising a figure the page cannot read is the same defect as a false sentence, in table form |

**The token that `usdc()` names is USDG, and the page prints what `symbol()` returned rather than
what the getter is called.** The getter keeps the name `usdc` because that is the name in the
contract and in `scripts/soak/deployment.mjs`; the token at `0x5fc5360D…` answers `symbol()` with
`"USDG"` and `decimals()` with 6. Printing "USDC" there would be a false statement produced by
trusting a variable name over a chain read.

## Three decisions that are easy to undo by accident

**1. The fallback block is static markup, not a rendered value.** The sentence "Vault rows are read
from chain 4663 when this page loads. None are listed here until that read returns, and none are
invented if it fails." lives in `index.html` and is never written by `app.js`. A claim produced by a
fetch disappears exactly when the fetch fails, which is the moment a reader most needs to be told
what is true. `app.js` hides the block once a row renders, and does not otherwise touch it.
`test/claims.test.mjs` asserts the sentence is in the built HTML, so moving it into the script reds
the guard.

That sentence describes WHERE the rows come from, not how many exist, and it is the third wording.
The first pinned "`vaultCount()` reads 0", true when written and false from the moment vault #1 was
created. The second pinned "this table lists no vaults", true until the rows were built. Both went
false with nothing going red, because the guard is a static string match that reads no chain: it can
only prove a sentence is present, never that it is true. The current wording holds whether the read
returns, fails, or never runs, which is the property to preserve when changing it.

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

`connect-src` names one third-party origin, `https://rpc.mainnet.chain.robinhood.com`. It is the
only external request the page makes. The two fonts are self-hosted copies of the faces
`apps/site-next` uses, so `font-src 'self'` holds and nothing is fetched from a font CDN.

One more constraint on the fetch, which is not visible in this repository at all: the RPC's CORS
preflight allows exactly one request header, `content-type`. Adding a second turns a working read
into a browser-side failure. `app.js` sends that header and no other, and no credentials.

## Layout

```
src/index.html   the page, all of it
src/app.css      the only stylesheet, palette carried from apps/site-next/src/tokens.css
src/app.js       both read passes: the protocol panel, and the vault rows
src/_headers     the CSP. Copied to dist/_headers, where Pages reads it from
src/favicon.svg  the comic R on its tile, byte-identical to the site's
src/brand/       mark-comic.svg, byte-identical to the site copy in public/brand/
src/fonts/       two woff2 faces, self-hosted
build.mjs        removes dist/ and copies src/ into it
test/claims.test.mjs
screenshots/
```

## Tests

```
node --test --test-reporter=tap apps/app/test/claims.test.mjs
```

Eleven checks: the empty-state sentence survives into the build; the row container `app.js` writes
into exists in the markup; no column header promises a figure this page cannot read; every pinned
vault-row selector is recomputed from its signature with viem and compared; the column order and
their decimal scales are pinned; whatever renders rows also updates the count chip; the factory address is on the page; no banned claim
shape appears in any built file; `_headers` carries every required directive; the markup has no
inline script or style; and the page fetches from no origin but the chain RPC.

The five added with the vault rows guard what a runtime failure cannot tell you. An earlier draft
of this paragraph claimed they guard a *silent zero*, on the theory that `eth_call` answers an
unknown selector with `0x` which decodes to zero. **That was never true here and was not probed
before being written.** Chain 4663 answers an unknown selector with a JSON-RPC error
(`{"code":3,"message":"execution reverted"}`), which `rpc()` throws on; and `BigInt('0x')` is a
`SyntaxError` anyway, so the zero is unreachable by two independent paths.

The real failure is loud but **wide**: `Promise.all` means one bad selector takes down every row,
and the page reports a failure without being able to say which call broke. A renamed `tbody` id is
worse, because it is silent: every read succeeds and the table simply stays empty. And the column guard exists because the rendering was otherwise
unpinned, so reordering the cell array or changing a decimal scale relabelled real numbers with
every other check still green.

**The first version of that column guard did not work, and the claim that it did was made without
running the case.** It sliced the source to a delimiter (`])) {`) that does not occur in `app.js`,
so `indexOf` returned `-1`, the window became the whole rest of the file, and its order check
chained only three of the four cells. Swapping TVL and NAV per share rendered each under the
other's heading and passed all ten checks. It now asserts its own window before using it, bounds
the window's length, and compares all four cell positions by index. All three cases are run as
controls: the swap, a broken delimiter, and a dropped chip update each red a named test.

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

## Deploy

```
node apps/app/build.mjs
cd apps/app && npx wrangler@latest pages deploy dist --project-name=rwally-app --branch=protocol/main
```

Run the deploy from `apps/app`. Pages picks up a Functions bundle from `./functions` at the working
directory; there is no such directory here and there should not be one.

## What is deliberately not built

Everything in `Design/app-spec-2026-09-05.md` past v1's first screen: the vault detail page, the
hive activity screens, stake, vote, and every wallet action. The Connect control in the masthead is
inert and says so, carries `aria-disabled` rather than `disabled` so it keeps its place in the tab
order, and names its reason through `aria-describedby`.

Its reason changed with this pass. It used to say deposits open "when a vault exists", which made
the control's own copy a hostage to chain state: vaults now exist and the button is still inert, so
that sentence had quietly become a broken promise. The blocker was never the factory. `app.js`
contains no wallet code at all, so the title and the note now say what is true of this page, and
they say the same thing as each other: a sighted reader gets the `title`, a screen-reader user gets
the `aria-describedby` note, and those two disagreeing is its own defect.
