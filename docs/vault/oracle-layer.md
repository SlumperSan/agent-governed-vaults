# Oracle Layer

**Definition.** How the vault prices basket assets. At launch: **Chainlink Data Feeds consumed
directly**: one genuine feed per asset ([[chainlinkoracle]]). The bespoke multi-source median
([[oracleaggregator]]) is **retired** to `contracts/test/retired/` and non-selectable. Both
implement `IOracleAggregator` and both **fail closed**.

**Why it matters.** NAV, share issuance, redemption value, and the rebalance slippage bound all
read this layer. A price an attacker can move is a vault an attacker can drain, and the custom
aggregator's Byzantine bound (**audit C-6**) is why the Chainlink pivot happened. **C-6 is
RESOLVED**, not by patching the median but by deleting it from the launch path.

## Fail-closed posture (K-4 / SF-2, ACCEPTED)

`priceWad` reverts `StaleOracle` whenever it cannot produce a trustworthy price: freezing
**every NAV-reading path including exits** in consuming vaults. On the launch oracle that means:
the asset is unlisted, the feed reverts or answers non-positive, the answer is older than the
per-feed heartbeat, the price falls outside the sane-price band, or the L2 sequencer is down or
inside its post-recovery grace period. (On the retired aggregator it meant: fewer than `quorum`
sources fresh.) No escape hatch, by design: any exit during staleness *is* the stale-price exit the
breaker prevents. Config is **immutable after construction** in both implementations: no admin can
swap a feed or retune a heartbeat; a creator wanting different feeds deploys a different oracle from
the blessed set, and members see it at deposit time.

## OracleAggregator: the RETIRED custom multi-source median

*Everything in this section describes a contract that is no longer on the launch path. It lives at
`contracts/test/retired/OracleAggregator.sol` as the C-4/C-6 exploit evidence.*

- Median of independent sources per asset ([[oracle-sources]]: Chainlink-push, Uniswap V3 TWAP,
  Pyth pull-wrapper: *mechanism* diversity is the SF-1 listing criterion).
- Floors hardened (H-1, M-1): `MIN_SOURCES = 3`, `MIN_MEDIAN = 3`, strict-majority freshness
  quorum, staleness bounded to `(0, MAX_STALENESS_CEILING = 1 day]`. The old constructor permitted
  quorum 2-of-3, where the lower median at k=2 is `fresh[0]`: the **minimum**, biased downward,
  the exploitable direction for share issuance (audit C-4). M-1 also rejects literal address
  duplication (`[S,S,S]`).
- Consequence, stated openly: at three sources this leaves zero failure headroom, so an asset needs
  **five** sources for integrity *and* tolerance, which is why `base-mainnet.json`, the BASE reference configuration, is now
  NOT-DEPLOYABLE (#41). Freezes are deliberately **more** likely now (E2/E6): a quiet TWAP pool
  withholds (H-2) rather than quoting a stale tick as fresh.

## Audit C-6: the Byzantine bound (RESOLVED by the Chainlink-direct pivot)

Phase-2 re-verification quantified that "5 sources / quorum 3" is a **fault-tolerance** floor
(sound against benign withholdings), **not** a Byzantine one. Because `k` falls to the quorum via
withholding and the lower median at even `k` sits inside a 2-source minority, an actor controlling
`a` sources owns the price once `k ≤ 2a`. Byzantine safety requires:

```
quorum ≥ 2a + 1                (own the price only with a full Byzantine minority)
m ≥ 2a + f + 1                 (also absorb f benign withholdings)
```

m=5 **cannot** tolerate a=2. The cheapest adversary is the **vault creator listing two sources
they control**: this passes every constructor check. See [[c6-oracle-byzantine]]. C-6 was a launch
blocker; it is **RESOLVED** by retiring this design entirely.

## ChainlinkOracle: the launch oracle

[[chainlinkoracle]] is **the** `IOracleAggregator` on the launch path, at
`contracts/src/oracle/ChainlinkOracle.sol`. Assets: **WETH via ETH/USD, cbBTC via BTC/USD, USDC
pinned to $1.00**, and no cbETH, because Base publishes no cbETH/USD feed (only cbETH/ETH, which
the constructor now rejects on denomination). The `VaultFactory` oracle allowlist blesses specific
oracle *instances*, so the retired aggregator cannot be selected. It trusts Chainlink's own decentralized OCR aggregation per asset: **one feed per asset**, no median,
no quorum, no per-vault source set to misconfigure or selectively stall: removing the entire
surface C-6/H-1/M-1 live on (Byzantine-tolerant at the node-operator layer).

Honest tradeoffs (**ACCEPTED** vs the custom aggregator, which C-6 proves could not be secured):

- **Single-provider dependency: the named residual on launch gate 5.** The heartbeat, the
  sane-price band and the sequencer gate are the *only* defences against a bad Chainlink answer;
  there is no second source to cross-check against. A feed deprecation or freeze fails that asset
  **closed with no fallback**, and because a vault's oracle is `immutable` and the factory
  allowlist gates *creation* only, there is **no rotation lever** (residual 12, "curation
  immobility").
- Assets **without** a Chainlink feed on the chain cannot be listed.
- A feed updates only on heartbeat OR a deviation-threshold move, so a price up to ~the deviation
  band stale reads as "fresh": a bounded, inherent NAV arb; vault-side defence is M-15's
  `minSharesOut`/`minValueOut`.
- A **sane-price band** (`minPriceWad`/`maxPriceWad`) defends against a feed reporting a deprecated
  min/maxAnswer clamp during a depeg/flash-crash; L2 sequencer-uptime feed and grace period are
  also checked.

## Links

- [[architecture-overview]] · [[nav-and-shares]] (price_i) · [[two-mode-exits]] (breaker freezes
  exits) · [[sub-vaults]] (look-through pricing)
- Contracts: [[oracleaggregator]] · [[chainlinkoracle]] · [[oracle-sources]]
- Security & decisions: [[c6-oracle-byzantine]] · [[c3-oracle-brick]] · [[c4-depressed-price-theft]]
  · [[chainlink-direct-pivot]] · [[launch-readiness-gates]]
