# `apps/app` — the vault explorer at app.rwally.com

One page: a stat strip over a table with a row per vault, every figure read from Robinhood Chain by
the reader's own browser. No server, no database, no wallet connection, and no control that signs
anything.

Rebuilt 2026-09-16. Before that it was a status card: four reads, a list of protocol addresses, and
a table with no rows carrying the static sentence "This table lists no vaults."

## Where every fact comes from

| On the page | Read by |
| --- | --- |
| Vaults | `VaultFactory.vaultCount()` |
| Each vault's address | `VaultFactory.allVaults(i)`, once per vault |
| Creator, net asset value, share price, holders, capacity used | five calls per vault, on the vault |
| Latest block | `eth_blockNumber` |
| Total value in vaults, holder positions | summed in the browser from the per-vault reads |

**The vault list is discovered, not shipped.** `VaultFactory` declares `address[] public allVaults`,
so Solidity gives it a public getter `allVaults(uint256)` and a browser can index straight into the
array. The first draft of this rebuild shipped the two addresses as static markup and said the
factory exposed no enumeration function. That was false, and it was false because it came from
reading a checkout behind origin rather than the contract. Because the list now comes from the
chain, this table cannot fall behind it. The only address this repository supplies is the factory's;
a guard pins that it is the only one the page may hard-code.

## Three decisions that are easy to undo by accident

**1. There is no return column, and that is the point.** A vaults screen normally leads with APR and
a PnL curve. This protocol publishes no return history, and the chain serves no time series to a
browser, so any such figure would be a performance claim nothing here supports. Share price is
`navWad / totalShares`, a ratio of two current reads, and it is never converted into a return: that
would need an entry price this page cannot read. If you add a column, it must survive the same
question, which is *which call answers it?*

**2. The framing sentence is static markup.** A claim produced by a fetch disappears exactly when
the fetch fails, which is the moment a reader most needs to be told what they are looking at. The
lede, the caption, the column headers and the row markup all ship in the document; only the figures
arrive. The row is a `<template>` cloned per vault, so what a reader inspects is what shipped rather
than a string built in JavaScript.

**3. A failed read is named, never blank.** Every figure lands in a slot reading `reading` until it
resolves. A failure writes `read failed` across the stat strip and a sentence into the table's empty
slot saying the list could not be read, so an empty table is never mistaken for a protocol with no
vaults. One `catch` in `app.js` does all of it, and the stamp carries the reason.

## Units, which are the easiest thing here to get wrong

`navWad` and `totalShares` are WAD, 18 decimals. `capacityCapUsdc` is USDG, 6. The capacity
percentage scales the WAD figure down rather than scaling the cap up, and every conversion runs on
`BigInt`: a funded vault's `navWad` exceeds the safe integer range once scaled, and a `Number`
conversion loses the tail silently rather than throwing.

Capacity precision follows magnitude. These vaults hold tens of USDG against a 50,000 cap, so a
fixed one decimal prints a real 0.04% as `0.0%`, which a reader cannot tell from an empty vault.
Small figures carry three decimals, and anything that would still round to zero reads
`under 0.0001%`.

`Holder positions` in the stat strip is the sum of each vault's `holderCount`. One address holding
in two vaults counts twice, which is why the label is positions and not holders.

## Content Security Policy

`src/_headers` ships `default-src 'none'` with the chain's public RPC as the only third-party
origin. Two consequences that stay invisible until production:

- `script-src 'self'` blocks an inline `<script>` with no error on the page, so all behaviour lives
  in `app.js`.
- `style-src 'self'` blocks every `style="..."` attribute, so the utilisation bar takes its width
  from a custom property set by `app.js` rather than from an attribute.

`_headers` must land at the root of the served directory, and `build.mjs` copies it from `src/`. A
missing `_headers` is not an error and is not reported: the deploy serves with no policy at all and
looks identical to a correct one.

## Tests

`npm run test:app` at the repository root, also a step of `npm run gate` and of CI. It asserts
against `dist/`, not `src/`: the reader receives the build output, and a check that reads the source
proves the author's intention rather than the deploy's content.

The repository-wide claims guard walks the built page too, because `dist` is not in its skip list
and `.html` is in its public extensions. `test/claims.test.mjs` is the narrow, page-specific half.

## Deploy

```
node apps/app/build.mjs
cd apps/app && npx wrangler@latest pages deploy dist --project-name=rwally-app --branch=protocol/main
```

Run the deploy from `apps/app`. Pages picks up a Functions bundle from `./functions` at the working
directory; there is no such directory here and there should not be one.

## What is deliberately not built

Every wallet action: deposit, exit, stake, vote. `app.js` contains no wallet code at all, and the
page carries no control that implies one. The previous version had an inert Connect button whose own
copy had become a broken promise once vaults existed; this rebuild removed the control rather than
rewriting the excuse.

A per-vault detail page is not built either. Everything a row shows is a call, and a detail page is
worth building when it can show something a row cannot, rather than the same five figures larger.
