# Oracle Layer

**Definition.** How the vault prices basket assets: a multi-source median with a staleness
circuit breaker ([[oracleaggregator]]), or — the recommended pivot — Chainlink Data Feeds consumed
directly ([[chainlinkoracle]]). Both implement `IOracleAggregator` and both **fail closed**.

**Why it matters.** NAV, share issuance, redemption value, and the rebalance slippage bound all
read this layer. A price an attacker can move is a vault an attacker can drain — and the custom
aggregator's Byzantine bound (**audit C-6, OPEN**) is why the Chainlink pivot exists.

## Fail-closed posture (K-4 / SF-2, ACCEPTED)

If fewer than `quorum` sources are fresh for an asset, `priceWad` reverts `StaleOracle` — freezing
**every NAV-reading path including exits** in consuming vaults. No escape hatch, by design: any
exit during staleness *is* the stale-price exit the breaker prevents. Config is **immutable after
construction** in both implementations — no admin can swap sources, retune staleness, or lower the
quorum; a creator wanting different sources deploys a different oracle, and members see it at
deposit time.

## OracleAggregator — custom multi-source median

- Median of independent sources per asset ([[oracle-sources]]: Chainlink-push, Uniswap V3 TWAP,
  Pyth pull-wrapper — *mechanism* diversity is the SF-1 listing criterion).
- Floors hardened (H-1, M-1): `MIN_SOURCES = 3`, `MIN_MEDIAN = 3`, strict-majority freshness
  quorum, staleness bounded to `(0, MAX_STALENESS_CEILING = 1 day]`. The old constructor permitted
  quorum 2-of-3, where the lower median at k=2 is `fresh[0]` — the **minimum**, biased downward,
  the exploitable direction for share issuance (audit C-4). M-1 also rejects literal address
  duplication (`[S,S,S]`).
- Consequence, stated openly: at three sources this leaves zero failure headroom, so an asset needs
  **five** sources for integrity *and* tolerance — which is why `base-mainnet.json` is now
  NOT-DEPLOYABLE (#41). Freezes are deliberately **more** likely now (E2/E6): a quiet TWAP pool
  withholds (H-2) rather than quoting a stale tick as fresh.

## Audit C-6 — the Byzantine bound (OPEN)

Phase-2 re-verification quantified that "5 sources / quorum 3" is a **fault-tolerance** floor
(sound against benign withholdings), **not** a Byzantine one. Because `k` falls to the quorum via
withholding and the lower median at even `k` sits inside a 2-source minority, an actor controlling
`a` sources owns the price once `k ≤ 2a`. Byzantine safety requires:

```
quorum ≥ 2a + 1                (own the price only with a full Byzantine minority)
m ≥ 2a + f + 1                 (also absorb f benign withholdings)
```

m=5 **cannot** tolerate a=2. The cheapest adversary is the **vault creator listing two sources
they control** — this passes every constructor check. See [[c6-oracle-byzantine]]. C-6 is OPEN and
is a launch blocker.

## ChainlinkOracle — the recommended pivot (already in the tree)

[[chainlinkoracle]] is an **additive** `IOracleAggregator` that a VaultCore can be deployed with
*instead* of the custom median. It already exists in `contracts/src/oracle/ChainlinkOracle.sol` —
the pivot is a **wiring/deployment decision** ([[chainlink-direct-pivot]]), not unwritten code. It
trusts Chainlink's own decentralized OCR aggregation per asset: **one feed per asset**, no median,
no quorum, no per-vault source set to misconfigure or selectively stall — removing the entire
surface C-6/H-1/M-1 live on (Byzantine-tolerant at the node-operator layer).

Honest tradeoffs (**ACCEPTED** vs the custom aggregator, which C-6 proves could not be secured):

- Single-provider dependency — a feed deprecation/freeze fails that asset closed (safe, but the
  vault freezes with no fallback).
- Assets **without** a Chainlink feed on the chain cannot be listed.
- A feed updates only on heartbeat OR a deviation-threshold move, so a price up to ~the deviation
  band stale reads as "fresh" — a bounded, inherent NAV arb; vault-side defence is M-15's
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
