# Oracle Sources

> **⚠ RETIRED — none of this is on the launch path.** These sources existed only to feed
> [[oracleaggregator]]'s median, which the C-6 pivot replaced ([[chainlink-direct-pivot]]). The
> launch oracle reads **one genuine Chainlink Data Feed per asset** directly, with no
> `IPriceSource` layer at all — see [[chainlinkoracle]]. `PythSource.sol`,
> `UniswapV3TwapSource.sol` and their vendored `FullMath`/`TickMath` now live under
> **`contracts/test/retired/`**, kept as the C-4/C-6 exploit evidence. Read this note as history.

The `IPriceSource` implementations that fed [[oracleaggregator]]'s median: a Chainlink push-feed
adapter, a Uniswap V3 arithmetic-mean-tick TWAP, and a Pyth pull-oracle wrapper. Each returned
`(priceWad, updatedAt)` and degraded to `(0, 0)` — the aggregator's not-fresh signal — rather than
reverting. `contracts/test/retired/` (was `contracts/src/oracle/`).

## Why it matters

The aggregator's whole safety argument rests on **mechanism diversity** (SF-1): a spot-market TWAP
fails in ways a Chainlink push feed and a Pyth pull feed do not, so a median across the three
classes is not defeated by any single upstream. Correlated upstreams are *not* independent sources —
"3 sources" behind one price mechanism is one source wearing three names. These contracts are also
**post-audit-freeze, additive**: the TWAP and Pyth sources implement the existing `IPriceSource` and
modify nothing inside the `v0.2.0-audit` tree.

## ChainlinkSourceAdapter (push)

Defined in `contracts/test/retired/OracleAggregator.sol`. Wraps an `IAggregatorV3` feed, normalizes to WAD by
`10**(18 - feedDecimals)` (cached). A non-positive answer surfaces as `(0, 0)` — the aggregator
treats it as not-fresh, never a revert. `updatedAt` is the feed's own last-write timestamp. This is
the "when did someone last write?" mechanism class.

## UniswapV3TwapSource (spot-market TWAP)

`contracts/test/retired/UniswapV3TwapSource.sol` (Sprint 11; was `contracts/src/oracle/`). Prices `asset` in USD by composing up
to two V3 TWAPs and pinning USDC to $1.00 — one hop (`asset`/`usdc`) or two hops
(`asset`/`intermediate` then `intermediate`/`usdc`, e.g. cbETH→WETH→USDC). Everything is immutable;
the vendored `TickMath` / `FullMath` keep the whole path in-repo.

**Freshness lives here, not in the aggregator.** `latestPrice` cannot delegate its staleness to the
aggregator because a TWAP has no writer — a hardcoded `block.timestamp` would be unconditionally
"fresh". So the source withholds (returns `(0, 0)`) unless: (1) `observationCardinality >=
minCardinality`; (2) the oldest retained observation is at least `window` old (so `observe()`
interpolates over history instead of extrapolating from the live tick); and (3) the newest
observation is no older than `maxObservationAge`.

- **H-2 (live-tick weight).** `observe([window, 0])` synthesizes the endpoint from the newest
  observation using the *current* tick; the live tick's weight in the "historical" mean is
  `min(A, W)/W` where `A = now - newestObservation`. The old guards bounded `A` and the oldest
  observation independently, so the shipped `1800/3600` config permitted `A = 2×` the window. Now
  `MAX_LIVE_TICK_WEIGHT_DIVISOR = 20` caps the live tick at **<= 5% of the window**, enforced both in
  the constructor (`maxObservationAge * 20 <= window`) and at read time. A naive
  `require(now - newestTs < window)` was tested and is **not** enough (it still permits >90% error).
- **H-2, second half.** `latestPrice` used to hardcode `updatedAt = block.timestamp`, so a source
  computing over a stale tick stamped itself zero seconds old and the aggregator's staleness bound
  could not reject it. It now reports `_newestObservationTs()` — the real age of the backing data.
- **H-3.** The test mock was **replaced** — the old one generated cumulatives from a single live
  tick, so a correct historical TWAP and a live-tick extrapolation were numerically identical and no
  assertion could fail for H-2's class.
- The whole computation runs behind `try this.computePriceWad()` so `FullMath.mulDiv` reverts and
  `observe()` on a codeless pool both convert to `(0, 0)`.

The USDC leg is a **pin, not a measurement**: a sustained depeg mis-prices every asset this source
quotes, by exactly the depeg. The median across mechanism classes is the mitigation (one source of
several cannot move a lower median).

## PythSource (pull oracle)

`contracts/test/retired/PythSource.sol` (Sprint 11; was `contracts/src/oracle/`). Wraps `getPriceUnsafe` (deliberately the
*Unsafe* variant — freshness is the aggregator's decision, made once, not duplicated here).
Immutable `pyth`, `priceId`, `maxConfBps`. Normalizes by exponent to WAD.

- **Pull-oracle staleness consequence:** `publishTime` reflects **keeper economics**, not Pyth
  liveness — on a quiet chain the on-chain price can be hours stale while Pythnet's aggregate is a
  second old. So `maxStaleness` must be chosen against the actual on-chain update cadence, not only
  basket volatility; a too-tight bound silently drops this leg, turning an advertised 2-of-3 into an
  effective 2-of-2 with no margin (see gate discussion in [[launch-readiness-gates]]).
- **Confidence gate:** rejects a reading whose `conf` exceeds `maxConfBps` of price
  (`MAX_CONF_BPS_CEILING` = 2000 = 20%) — a feed in disagreement with itself declines to vote.
- Exponent bounds `[MIN_EXPO = -36, MAX_EXPO = 18]`; sub-WAD-dust prices return `(0, 0)`.
- The constructor **reads the feed** (`getPriceUnsafe` reverts on an unknown id), so a mistyped
  32-byte price id cannot be deployed — a silent-`(0,0)` source is invisible in a 2-of-3 quorum
  until the day another source fails.

## K-4 tie-in

Because a source can withhold when its data goes quiet, a *market* going quiet becomes a **breaker
input** (a freeze) rather than a silently-stale number — strictly the safer failure. If enough
sources withhold, `priceWad` reverts `StaleOracle` and every NAV path freezes, including exits, with
no hatch (the accepted K-4 / SF-2 tradeoff).

## Links

- [[contracts-index]] · [[oracleaggregator]] · [[chainlinkoracle]] · [[vaultcore]]
- Architecture: [[oracle-layer]]
- Findings: [[highs]] · [[c6-oracle-byzantine]] · [[threat-model-commitments]] ·
  [[launch-readiness-gates]]
