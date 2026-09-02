# Walkthrough — ChainlinkOracle.sol

**Risk: Critical (it is the only thing that prices a vault).** ~330 lines incl. NatSpec
(~116 non-comment). `contracts/src/oracle/ChainlinkOracle.sol`.

> **This is THE launch oracle.** It did not exist when any of the four internal adversarial passes
> recorded in [README §6](../README.md) ran — it was written as the C-6 remediation, after all of
> them. Read it against the retired design it replaced:
> [OracleAggregator.md](OracleAggregator.md) (C-6). Per the owner's standing decision, **all code in
> this repository is treated as unreviewed pending a paid external audit** — this walkthrough is
> preparation material for a reviewer, not a record that a review happened.

## Purpose

The single price surface every vault reads. `ChainlinkOracle` implements
`IOracleAggregator.priceWad(asset)` (`contracts/src/interfaces/IOracleAggregator.sol`) by mapping
**each asset to exactly one Chainlink Data Feed** — no median, no quorum, no per-vault source list.
Critical **C-6** is what put it here: the retired bespoke `OracleAggregator` medianed a
creator-curated source set, and curation could not secure it. The trust moved to Chainlink's own
OCR node-operator layer, which is outside this contract entirely.

**The interface name predates the pivot.** `IOracleAggregator` was written for the multi-source
median; nothing aggregates here. Its NatSpec says so, and it is the reason a reader meets the word
"Aggregator" all over a contract that reads one feed.

Config is **immutable after construction**, exactly like the design it replaced: no admin can swap
a feed, retune a heartbeat, repoint the sequencer feed, or move a band. A creator who wants
different feeds deploys a different `ChainlinkOracle`; members see which one before they deposit,
because `VaultCore.oracle` is an immutable constructor argument.

## Config (immutable after construction)

| Item | Where | Notes |
| --- | --- | --- |
| `feedOf[asset]` → `FeedConfig` | public mapping | `feed` (the Chainlink `EACAggregatorProxy`), `heartbeat`, `scale`, `minPriceWad`, `maxPriceWad`. `feed == address(0)` is the **unlisted sentinel** |
| `scale` | inside `FeedConfig` | `10**(18 - feedDecimals)`, cached at construction. Currently always `1e10` — the constructor pins `feedDecimals` to 8 |
| `usdc` | `immutable` | Pinned to `1e18`. `address(0)` disables the pin. The constructor **forbids doing both** — a pinned USDC must not also carry a feed |
| `sequencerUptimeFeed` | `immutable` | Set per chain. `address(0)` ⇒ not a sequencer L2, gate skipped |
| `GRACE_PERIOD` | `public constant` | `3600` s |
| `MIN_HEARTBEAT` / `MAX_HEARTBEAT` | `private constant` | `600` / `86_400` s. **Private** — a prospective member reads the per-asset `heartbeat` through the public `feedOf`, not these bounds |
| `MAX_BAND_RATIO` | `private constant` | `1000` — widest accepted ceiling/floor ratio |

The pin is a **decision, not a measurement**: a sustained USDC depeg is mispriced by exactly the
depeg. The stated alternative is to list USDC in the feed map instead of pinning it.

## What the constructor refuses to deploy

Everything below reverts `BadOracleConfig()`, i.e. the deploy fails while it is still fixable, and
nothing here re-runs at read time.

- **Array shape:** `n > 0` and all five parallel arrays equal length.
- **Per asset:** non-zero asset and feed; `asset != usdc_`; no duplicate asset; `feed.code.length > 0`
  (a codeless feed is one deploy typo that would return empty data forever).
- **Heartbeat bounds:** `MIN_HEARTBEAT (600) ≤ heartbeat ≤ MAX_HEARTBEAT (86_400)`. Both exist
  because config is immutable: above the ceiling the staleness guard is present but can never fire;
  below the floor it freezes the asset against a *healthy* feed. The ceiling is the slowest
  heartbeat tier Chainlink publishes; the floor was measured against the four feeds in the two
  shipped configs (medians 914–1232 s), so a tighter bound false-trips a healthy feed. The check is
  inclusive at the ceiling, which is why Base Sepolia's deliberately generous `86_400` passes.
- **Sane-price band:** either fully disabled (`min == 0 && max == 0`) or a usable band — non-zero
  floor, strict ordering `lo < hi`, and `hi ≤ lo * MAX_BAND_RATIO`. A **ceiling-only** band
  (zero floor, non-zero ceiling) is rejected on purpose: it guards the wrong side, because a
  deprecated `minAnswer` clamp is a **low** value. There is deliberately **no minimum width** — the
  correct width is a function of the asset's volatility class, which the constructor cannot observe.
- **Band containment:** when the band is enabled, the feed's **current** answer must fall inside it
  (`answer > 0`, `spotWad ∈ [lo, hi]`). This is the only "too tight" test available without a view
  on volatility, and it also catches a band written in feed decimals instead of WAD, or copied from
  another asset. Freshness is deliberately **not** checked — a deploy must not fail for a transient
  reason.
- **Denomination — `_requireUsdQuote(feed)`.** Everything downstream reads `priceWad` as **USD**.
  The check proves the quote leg from the feed's own `description()`: the last three bytes are
  `USD` **and** the byte before them is a pair separator (`' '` or `'/'`). The separator is the
  load-bearing half — a bare suffix match would accept `"ETH / PYUSD"`, an ETH price quoted in a
  USD-*ish token*. The failure it exists to stop is silent: Base publishes `CBETH / ETH` and no
  cbETH/USD feed, so a deployer reaching for cbETH wires the ETH-denominated feed and every vault
  prices cbETH at ~1.04 "dollars" forever. It runs **once, in initcode**, so `priceWad` is
  byte-for-byte unchanged and a later description edit upstream cannot retroactively fail a
  deployed oracle.
- **Decimals cross-check:** `decimals() == 8`, the USD-feed convention, corroborating the
  denomination above (Chainlink uses 18 for ETH-denominated feeds). The cost is stated in the
  source and accepted: a legitimate 18-decimal USD feed cannot be listed without a contract change.
- **Decode proof:** `latestRoundData()` is called once per feed at construction, and once on the
  sequencer feed when one is configured, so every listed feed is proven to speak the AggregatorV3
  ABI before any funds exist. This is why the per-call raw-staticcall decode guard the retired
  aggregator needed (C-3) is **not** repeated here.
- **Sequencer feed exemption:** the uptime feed is **deliberately exempt** from the USD-quote and
  8-decimals checks. It is a status feed, not a price feed — Base's reports 0 decimals and
  describes itself as an uptime status — so applying a price-feed denomination rule to it would
  reject every correct mainnet deployment.

## The read path — `priceWad(asset)`

Order matters, and it is the order below.

1. **`_requireSequencerUp(asset)`** — the L2 gate, before any price is trusted. No-op off a
   sequencer chain.
2. **USDC pin** — `usdc != address(0) && asset == usdc` returns `1e18` and stops.
3. **Listing** — `feedOf[asset].feed == address(0)` reverts `StaleOracle(asset)`. An unlisted asset
   is the **breaker**, never a zero price.
4. **Feed read**, inside `try/catch`. Rejected, each as `StaleOracle(asset)`: `answer <= 0`
   (non-positive, rejected *before* the cast); `updatedAt == 0` (unset / incomplete round);
   `updatedAt > block.timestamp` (a future stamp is never "fresh"); `updatedAt < minUpdated`
   (**stale past the heartbeat**, where `minUpdated` saturates at 0 so a heartbeat larger than the
   clock cannot underflow-panic and escape as something other than `StaleOracle`); and a `catch` on
   any revert.
5. **Decimals normalisation** — `priceWad_ = uint256(answer) * cfg.scale`, with
   `scale = 10**(18 - feedDecimals)` cached at construction. With the constructor's 8-decimals pin
   this is always `× 1e10`.
6. **Sane-price band**, when enabled (`cfg.maxPriceWad != 0`): `priceWad_ < cfg.minPriceWad ||
   priceWad_ > cfg.maxPriceWad` reverts. Both comparisons are **exclusive**, so a price landing
   exactly on a bound passes. The band is the defence against a feed reporting a **deprecated
   min/maxAnswer clamp value** as a fresh price during a depeg or flash crash — Chainlink's
   on-aggregator circuit breakers no longer stop the proxy.

## The L2 sequencer gate — `_requireSequencerUp`

Skipped entirely when `sequencerUptimeFeed == address(0)`. Otherwise, inside `try/catch` (a
`catch` reverts `StaleOracle`):

- `answer != 0` ⇒ **down** ⇒ revert. (`0` = up, `1` = down.)
- `startedAt == 0` (uptime round not yet started) or `startedAt > block.timestamp` ⇒ treated as
  down ⇒ revert.
- `block.timestamp - startedAt <= GRACE_PERIOD` ⇒ revert. The grace window is anchored on
  `startedAt` and must have **fully** elapsed: prices published in the first hour after a restart
  are not yet trustworthy, because transactions queued during the outage are still draining.

The uptime feed's own `updatedAt` is **intentionally not** staleness-checked. The feed is
event-driven — it writes only on an up↔down transition — so a long-unchanged `updatedAt` is its
healthy steady state, and checking it would freeze pricing during normal uptime. `answer` and
`startedAt` are the authoritative signals. The consequence is a residual, listed below.

## Fail-closed — what a stale or out-of-band price does to members

**A price this contract will not vouch for freezes the vault, and that includes exits.** `priceWad`
reverts `StaleOracle(asset)` and never returns 0 and never returns a stale number, so every
NAV-reading path in a consuming vault reverts with it: `navWad`, `deposit`, `requestExit`,
`settleQueuedExit`, rebalance execution. **A member holding shares cannot get out until the price
is trustworthy again.** There is no hatch, no admin unfreeze, and no timeout — `VaultCore.oracle`
is immutable and no governance path touches it.

Scope it precisely rather than over-claiming: `navWad` prices only the assets a vault actually
holds, so an unpriceable asset freezes **the vaults holding it** — which is why the regression is
named `VaultCore::test_staleOracleFreezesDepositsAndExits_whenBasketHeld`. Within such a vault the
freeze is total, and note that `_deposit` reads `navWad()` **unconditionally**, before the capacity
branch and on both the pending and immediate paths, so an uncapped vault is no less frozen.

On the launch oracle a freeze has exactly **four** causes:

1. the asset's single feed is past its configured heartbeat;
2. the price is outside the sane-price band;
3. the L2 sequencer is down, or up but still inside the 3600 s grace window;
4. the feed is dead (reverting / non-decoding) or the asset is unlisted.

There is **no second source to absorb any of them** — see the single-provider residual below.

This is the accepted **K-4 / SF-2** posture, inherited verbatim from the retired design and stated
in `IOracleAggregator`'s own NatSpec: an exit hatch during staleness *is* the stale-price exit the
breaker exists to prevent. Freezing beats mispricing.

The one softening, and it is narrow: **`VaultCore.cancelPending()` reads no oracle**, so capital
sitting in an un-activated observation-window deposit can always be withdrawn during a freeze. That
covers deposits that have not yet minted shares. It does nothing for anyone who holds shares.

## The factory gates (C-6) — what they do and do not guarantee

Both gates live in **`contracts/src/VaultFactory.sol`**, not here, and both run in `createVault`
and `createChildVault`. See [VaultFactory.md](VaultFactory.md).

**`_requireAllowedOracle(oracle)` — the curated allowlist.** The factory's `allowedOracles_`
constructor argument fixes a set of blessed oracle instances. `oracleAllowlistEnforced` is
`allowedOracles_.length > 0`; when enforced, a vault whose oracle is not in `isAllowedOracle`
reverts `OracleNotAllowed()`. Each entry must be non-zero and have code.

What it **does**: it decides which oracle *instance* a **new** vault may be created against on that
factory.

What it does **not** do, enumerated because each of these is a thing a reader may assume:

- It does **not** bind a vault that already exists. `VaultCore.oracle` is immutable, so every
  deployed vault prices through its own oracle whatever any allowlist later says.
- It does **not** prove a feed is genuine. A `ChainlinkOracle` pointed at a creator-controlled
  **fake** `AggregatorV3` passes every constructor check in this file — it can return `"ETH / USD"`
  and 8 decimals while pricing whatever the creator likes. The allowlist is the answer to that;
  `_requireUsdQuote` is the complement, closing the *honest-deployer* hole the allowlist cannot see
  (an oracle blessed on the assumption its feeds are USD feeds, when one is not).
- It cannot be **added to or removed from**. There is no owner, no setter, no rotation path
  (residual below).
- It does **nothing at all when empty** — an empty `allowedOracles_` disables enforcement, which is
  the local/test configuration.

**`_requireOracleCoversBasket(oracle, basketAssets)` — the priceability probe.** It calls
`priceWad` for **every** basket asset and requires a non-zero result, reverting
`OracleMissingAsset(asset)` on a revert or a zero. Blessing an oracle *instance* says nothing about
whether it covers *this* basket: without the probe a creator could pair a fully-blessed oracle with
an asset it does not list, deposit USDC fine, and brick the vault permanently the moment that asset
is held. It runs **after** `_deploy` on purpose, so `VaultCore`'s constructor gets to diagnose a
malformed basket first (cap, duplicates, decimals) and this check has the last word on a different
question. Note what it is: a **creation-time misconfiguration** gate, not an outage gate — a feed
healthy at creation and dead later is the freeze above, not a rejected deploy.

## Shipped configuration (the actual numbers)

Read from `contracts/config/base-mainnet.json` and `contracts/config/base-sepolia.json`, block
`chainlinkOracle`, on `protocol/main`. These are deploy inputs, not contract constants.

| Chain | Asset | Feed | `heartbeatSeconds` | Band (WAD) |
| --- | --- | --- | --- | --- |
| Base mainnet | WETH | `ETH / USD` | `3600` (feed's own cadence 1200 s) | `100e18 … 100_000e18` |
| Base mainnet | cbBTC | `BTC / USD` | `3600` (cadence 1200 s) | `1000e18 … 1_000_000e18` |
| Base Sepolia | WETH | `ETH / USD` | `86_400` | `100e18 … 100_000e18` |
| Base Sepolia | LINK | `LINK / USD` | `86_400` | `1e18 … 1000e18` |

- Mainnet configures the Base **L2 Sequencer Uptime Feed**, and the config calls it MANDATORY.
  Read the mechanism from the contract, not from that note: omitting the feed does not revert
  anything, it **silently skips the gate** — which is exactly why the note is emphatic.
- **Base Sepolia sets `sequencerUptimeFeed` to the empty string, i.e. `address(0)`, so the gate is
  skipped on testnet** — deliberately, per the config note: the gate is exercised by
  `ChainlinkOracle.t.sol` against a mock (down / within-grace / up), and against three real Base
  outages in `ChainlinkOracleSequencerFork.t.sol`. **No testnet run is evidence about the gate.**
- **cbETH is not listed**, and this is the single-provider tradeoff made concrete: Base publishes
  only `CBETH / ETH`, and a single-feed-per-asset oracle cannot compose `cbETH/ETH × ETH/USD`.
- Every shipped band sits at exactly `MAX_BAND_RATIO` (1000×).

## Review focus

1. **The four `StaleOracle` surfaces vs. anything that could escape as a different error.** The
   contract's contract-with-the-vault is that *every* failure is `StaleOracle(asset)` and nothing
   else. The saturating `minUpdated` exists for exactly this reason. The source names the one
   acknowledged hole: a short or malformed return that fails ABI-decode of the `try`-returns tuple
   could surface as a `Panic` rather than `StaleOracle`, with the construction-time decode proof
   plus immutability, not the `catch`, doing the real work.
2. **`_requireUsdQuote`'s byte predicate.** It decodes `description()` from a raw `staticcall`,
   requires `ret.length >= 96` and `desc.length >= 4`, then reads `desc[n-1..n-4]`. Pressure-test
   the boundary arithmetic and the ABI-decode of an adversarial return, remembering it is initcode
   only and the attacker who matters here is a **typo**, not a hostile feed.
3. **The band's exclusive comparisons.** `<` and `>`, so a price exactly on a bound passes. This is
   what makes the band's coverage a property of the live price rather than of the config — worked
   through in `docs/LAUNCH-READINESS.md` §4 row 14, and the reason a band retune is an owner
   decision.
4. **The `usdc` pin vs. the feed map.** The constructor forbids an asset being both, but confirm no
   path can price a pinned USDC through a feed or vice versa, and that the pin returning before the
   listing check is the intended precedence.
5. **The sequencer gate's `startedAt` semantics** against a real uptime feed's round behaviour —
   including the first round after deployment of the uptime feed itself, and what a feed that has
   never transitioned reports.
6. **Consuming-side blast radius.** Every `VaultCore` path that reads a price and what each does on
   revert; specifically whether `cancelPending` is genuinely the only oracle-free member path.

## Accepted risks here (do not re-report)

- **K-4 / SF-2 — fail-closed freezes exits.** Stated in full above. Deliberate; the alternative is
  a stale-price exit.
- **Single-provider dependency (LAUNCH-READINESS §4 row 13).** The launch oracle is Chainlink and
  only Chainlink. A feed that reports a plausible-but-wrong price *inside* its heartbeat and
  *inside* the band is not contradicted by anything in the protocol — NAV, share issuance, exit
  value and the rebalance slippage bound all read that one number. Separately, a deprecation or
  freeze fails that asset closed with no fallback. The **only** protocol-side defences are the
  three in this file: the sequencer gate, the per-feed heartbeat, and the sane-price band.
  Chainlink's decentralization lives at its own OCR node-operator layer, not in this contract. The
  member-side defence at entry is M-15's `minSharesOut`; **there is none on the exit side** (dropped
  for the `VaultCore` byte budget). Asset universe is bounded to WETH + cbBTC as a direct
  consequence of the on-chain denomination check.
- **Aggregator-swap drift — the cached `scale` (LAUNCH-READINESS §4 row 14).** Chainlink swaps the
  aggregator behind an `EACAggregatorProxy` as routine operation (`phaseId` counts the swaps) and
  holds `decimals()` constant across them by *convention, not enforcement*. `scale` is read once,
  in the constructor. A `decimals()` change would mis-scale every price for that asset by a power
  of ten, permanently and without a revert. Four things bound it, and none of them is "this cannot
  happen":
  - Only `decimals()` matters at runtime — nothing in `priceWad` reads `description()`.
  - The band fail-closes on every drift with a Chainlink precedent (its only other shipped
    precision is 18), **but that is a property of the live price and it expires on both sides** as
    price moves; row 14 works the boundaries.
  - The residual is therefore a ±1-decimal change, which has no Chainlink convention behind it and
    no observed occurrence in the survey row 14 records.
  - **The re-read fix was rejected on freeze semantics, not gas.** Re-reading `decimals()` per call
    and reverting on mismatch was measured and is affordable; it was rejected because it converts a
    benign upstream operation into a permanent vault-wide freeze nothing on-chain could lift. Under
    drift a member on a childless vault still exits whole (`_settleExit` sizes the payout from
    balances and consults the oracle only to *value* it); under a false freeze nobody exits ever.
  - **Detection is off-chain and is not fully delivered.** `scripts/verify-chainlink-oracle.mjs` is
    read-only and keyless, and its `decimals() == 8` check is complete *at the sampling instant* —
    but row 14 records that nothing in CI or cron runs it, so its cadence is a human habit rather
    than an automated control. The automated half is the canary's `feed-identity` signal
    (`docs/CANARY.md` §3(g)), which **is** on `protocol/main` — but PR **#127 is open**, and it
    fixes a defect in which the drift ALERT and the benign aggregator-swap notice share one
    transition key, so a drift arriving on the sweep after a swap dispatches **nothing at all**.
    Until #127 lands, **do not read this mitigation as delivering**; the signal exists, the page
    path does not reliably fire.
  - Executed evidence for the on-chain half: `test/audit/AuditAggregatorSwapDrift.t.sol`. Row 14
    also records that the band exists in three unbound copies (test literals, the chain JSONs, and
    the deploy env) with nothing machine-checking that they agree — the named `BAND-BINDING` gap.
- **Curation immobility — no oracle rotation path (LAUNCH-READINESS §4 row 12).** The allowlist is
  fixed in `VaultFactory`'s constructor: no add, no remove, no owner. State the fact plainly, and
  then the part that is counter-intuitive: **a rotation lever would not rescue a single stuck
  dollar.** `VaultCore.oracle` is immutable, `Governance` has no oracle surface, and the allowlist
  is read only by `_requireAllowedOracle` at creation — so it governs new vault creation and
  nothing else. What a lever would buy is "future creators may select a different oracle", which a
  factory redeploy already achieves, at the priced cost that `OperatorRegistry.wire` is one-shot so
  a replacement factory starts a disjoint reputation universe. Against that, an owner able to bless
  is an owner able to bless a `ChainlinkOracle` over a fake `AggregatorV3` — the C-6 vector itself —
  and it would be the protocol's first standing privileged role. Evidence:
  `test/audit/AuditOracleRotation.t.sol`.
- **A genuinely frozen uptime feed reads "up".** Because the gate does not staleness-check the
  uptime feed's own `updatedAt` (see above), an uptime feed stuck at `answer == 0` is
  indistinguishable from a healthy one. Accepted; it is the posture standard Chainlink L2 consumers
  take, and checking `updatedAt` would freeze pricing during normal uptime.
- **The USDC pin does not measure USDC.** A sustained depeg is mispriced by exactly the depeg. The
  documented alternative is to list USDC in the feed map instead of pinning it; the constructor
  forbids doing both.
- **A price sitting inside the deviation band reads as fresh.** A Chainlink feed updates on its
  heartbeat **or** a deviation-threshold move, so a price up to roughly the deviation band stale is
  legitimately "fresh" to this contract. This is a bounded, inherent-to-Chainlink NAV arb; E7/EE-5
  is the same residual seen from `VaultCore`. **Read the vault-side defence from `VaultCore`, not
  from this file's NatSpec**, which names `minSharesOut`/`minValueOut` as a pair: only
  `deposit(amountUsdc, minSharesOut)` exists, it is enforced on the **immediate** path only
  (`SlippageExceeded`, M-15), and `VaultCore`'s own M-15 note records that exit has **no
  `minValueOut` overload** — the byte budget did not allow it. Row 13 says the same thing.
- **No freeze alerting today.** LAUNCH-READINESS §4 row 2 records that the canary's
  `oracle-freshness` signal has **not** been ported and emits `skipped` on a launch vault, so
  nothing alerts on the freeze described above. Operational gap, recorded here so it is not
  re-derived.
- **`ChainlinkSourceAdapter` is named in this file's NatSpec but no longer exists in
  `contracts/src/`.** The `IAggregatorV3Description` comment refers to it; after the C-6 prune it
  survives only inside `contracts/test/retired/OracleAggregator.sol`. A stale symbol reference in a
  comment, not a behavioural defect — recorded rather than silently patched, because changing
  `contracts/src/` is a contract change.
