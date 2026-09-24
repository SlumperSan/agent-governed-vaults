# Walkthrough: ChainlinkOracle.sol

**Risk: Critical (prices every NAV path of every vault that binds it).** 367 lines, about half of
them NatSpec. `contracts/src/oracle/ChainlinkOracle.sol`.

The launch oracle. It replaced the retired median design ([OracleAggregator](OracleAggregator.md))
under audit finding **C-6**. Deployed on Arc mainnet (chain 5042) at
`0x0C60b9a4C207dd622CcC0Ee3C51b5c274cb7B979` and allowlisted in the Arc `VaultFactory`
(`isAllowedOracle` reads `true`). This walkthrough was written from the contract source, not from
the prose of the rejected PR #140.

## Purpose

Implements `IOracleAggregator.priceWad(asset)` with **exactly one Chainlink AggregatorV3 feed per
asset**. The feed's own off-chain OCR aggregation is the trust, so there is no source set, no
median and no quorum for a vault creator to size wrongly (the C-6 surface). Configuration is fixed
in the constructor and has no setters. A creator who wants different feeds deploys a different
instance, and `VaultFactory`'s blessed-oracle allowlist decides which instances a vault may bind.

## Config (immutable after construction)

`feedOf[asset]` returns `FeedConfig { feed, heartbeat, scale, minPriceWad, maxPriceWad }` (`:51-64`).
The public getter is what a member inspects before depositing. Two further immutables:

- `usdc`: a token pinned to `1e18` (`:70`). `address(0)` disables the pin.
- `sequencerUptimeFeed` (`:75`): `address(0)` means not on a sequencer L2, and the gate is skipped.

The constructor (`:166-272`) rejects a configuration, with `BadOracleConfig`, unless every one of the
following holds:

- **Lengths and addresses.** `n > 0`, all arrays are the same length, there is no zero asset and
  no zero feed, there are no duplicate assets, and `asset != usdc_`, so a pinned USDC cannot also
  carry a feed (`:176-190`).
- **Heartbeat within `[MIN_HEARTBEAT, MAX_HEARTBEAT]` = `[600, 90_000]` seconds** (`:131-132`,
  `:186`). The 90,000 s ceiling is 24 h plus one hour of jitter allowance, measured on Arc. The
  rationale is the constant's own NatSpec (`:81-130`).
- **The feed has code** (`:189`).
- **Sane-price band.** Either disabled (both bounds 0), or `0 < lo < hi <= lo * MAX_BAND_RATIO`
  with `MAX_BAND_RATIO = 1000` (`:144`, `:196-199`). A ceiling-only band is rejected because a
  deprecated `minAnswer` clamp is a *low* value.
- **USD denomination.** `description()` must end in `USD` as a whole word, with a `' '` or `'/'`
  separator (`_requireUsdQuote`, `:297-308`). This is a *misconfiguration* guard, not an
  authenticity guard: a hostile fake feed can claim `"BTC / USD"`. Authenticity is the allowlist's
  job.
- **Exactly 8 decimals** (`:218-219`), which caches `scale = 1e10` (`:245`).
- **The band contains the feed's current answer**, when a band is set (`:251-255`). This catches a
  band written in feed decimals, or one copied from another asset. Freshness is deliberately *not*
  checked at deploy.
- **A sequencer feed, if given, has code and decodes `latestRoundData`** (`:266-269`).

## `priceWad(asset)`: the whole algorithm (`:313-340`)

1. **Sequencer gate** (`_requireSequencerUp`, `:346-366`). It is a no-op when no uptime feed is
   configured. Otherwise it reverts unless `answer == 0` (up), `startedAt` is non-zero and not in
   the future, and more than `GRACE_PERIOD = 3600` s has passed since the restart. It also gates the
   USDC pin.
2. **USDC pin.** The asset `usdc` returns `1e18`.
3. **Unlisted asset.** Reverts `StaleOracle(asset)`: the breaker fires, it does not return zero.
4. **`latestRoundData` under `try/catch`.** Any of the following reverts `StaleOracle(asset)`:
   `answer <= 0`, `updatedAt == 0`, `updatedAt > block.timestamp`, `updatedAt` older than the
   heartbeat (a saturating lower bound, so no underflow panic), a price outside an enabled band, or
   the feed call itself reverting.
5. Otherwise it returns `uint256(answer) * scale`, an 8-decimal USD answer normalised to WAD.

**Every failure surfaces as `StaleOracle(asset)`.** The contract has no path that returns 0, and
none that returns a price older than the heartbeat.

## Breaker semantics (K-4, inherited deliberately)

A revert here reverts every NAV-reading path in a consuming vault: deposit, exit settlement and
rebalance valuation (`ChainlinkOracleVaultIntegration.t.sol:test_staleFeedFreezesDepositsAndExits`).
A vault that binds this oracle has no fallback feed and no rotation lever (`VaultCore.oracle` is
immutable). A deprecated or frozen feed fails its vault closed. That is the accepted cost of C-6.

## The Arc deployment, as configured and as read on chain (2026-09-23)

| Field | `arc-mainnet.json` | Live `feedOf(cirBTC)` / immutables |
|---|---|---|
| Asset | `cirBTC` `0x171a…baa0` | same |
| Feed | `0xa109B535…03De` | same, and `description()` reads `"BTC / USD"` |
| Heartbeat | 90000 | 90000 |
| Scale | (8 decimals) | `1e10` |
| Band | 4,000 to 4,000,000 USD (WAD) | `4e21` to `4e24` |
| USDC pin | `true` | `usdc()` = `0x3600…0000` |
| Sequencer feed | `""` (Arc is an L1, owner exemption 2026-09-18) | `address(0)` |

## Review focus

1. **The Arc deployment runs on two of the three defences.** With `sequencerUptimeFeed = 0`,
   `_requireSequencerUp` returns early and the gate fails *open*. Staleness and the band remain.
   This is correct only as long as Arc has no sequencer to go down. It is pinned as a property of
   the contract by `scripts/test/config-doc-truth.test.mjs`.
2. **cirBTC is priced by the BTC/USD feed.** The oracle values the wrapped asset at the
   underlying's price. A cirBTC depeg from BTC is invisible to it, and the 1000x band is far too
   wide to catch one. That is a listing decision, not a code defect. The vault-side exposure is
   exit and deposit value measured against a price the asset may not fetch.
3. **Deviation-band staleness.** A feed updates on its heartbeat *or* a deviation move, so a price
   up to the deviation threshold away from market still reads as fresh. On the 24 h BTC tier this
   is a bounded NAV arbitrage. The vault-side defence is M-15's `minSharesOut`, which covers the
   immediate-mint deposit path only.
4. **Aggregator `decimals()` drift is not re-checked after construction** (`:228-242`), and this is
   an accepted residual. The band catches most drifts
   (`AuditAggregatorSwapDrift.t.sol:test_backstop_*`), while ±1-decimal drifts can sit inside a
   real band (`test_residual_*`), and the backstop lapses at some price levels (`test_expiry_*`).
   **The comment at `:235-236` used to say that under drift "a member still exits whole" — fixed**,
   per `Findings/2026-09-19-a-member-does-not-exit-whole-under-decimals-drift`: the oracle-derived
   fee fraction is withheld from the member's actual tokens, so a +1-decimal drift manufactures a
   phantom gain and takes the full fee clamp. Treat the risk as fee loss on exit, not as
   exit-whole.
5. **A malformed return.** A feed whose `latestRoundData` returns a short tuple can surface as a
   decode panic rather than `StaleOracle` (acknowledged at `:225-227`). The mitigations are the
   construction-time decode proof and the immutable config. Confirm that no consumer depends on the
   revert *selector* being `StaleOracle` for a correct outcome.
6. **The USDC pin is a decision, not a measurement.** A sustained USDC depeg is mispriced at $1.
   The alternative, listing USDC with a USDC/USD feed, is mutually exclusive with the pin and is
   enforced at `:185`.

## Tests

- **Unit, `contracts/test/audit/ChainlinkOracle.t.sol`:** WAD normalisation; fail-closed on each
  read failure (unlisted, stale, zero or negative answer, unset round, future timestamp, reverting
  feed); band boundaries; every constructor rejection; the USDC pin; every sequencer branch
  including `test_sequencer_gatesUsdcPinToo` and the grace boundary.
- **Fuzz, `ChainlinkOracleFuzz.t.sol`:** exact normalisation, non-8-decimal rejection, staleness
  always failing closed, non-positive answers, band enforcement.
- **Parameter bounds, `AuditOracleParamBounds.t.sol`:** heartbeat floor and ceiling (including
  `test_theArcWorstObservedGapPricesUnderTheNewCeiling`), band width, ceiling-only and degenerate
  bands, and bands off the live price.
- **Drift, `AuditAggregatorSwapDrift.t.sol`:** the backstop, residual and expiry cases in focus
  item 4.
- **Integration, `ChainlinkOracleVaultIntegration.t.sol`:** a vault prices its basket through the
  feed, and a stale feed freezes both deposits and exits.
- **Fork, `ChainlinkOracleSequencerFork.t.sol`:** the sequencer gate against a real uptime feed.
- **Allowlist, `AuditOracleAllowlist.t.sol`:** only an allowlisted oracle may back a vault
  (the C-6 remediation).
