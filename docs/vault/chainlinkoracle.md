# ChainlinkOracle

**THE launch price oracle**: one genuine Chainlink AggregatorV3 Data Feed per asset,
`IOracleAggregator`, immutable config, fail-closed. It **replaced** the bespoke
[[oracleaggregator]] median — which is retired to `contracts/test/retired/` and made
non-selectable by the [[vaultfactory]] oracle allowlist. At launch: WETH via ETH/USD, cbBTC via
BTC/USD, USDC pinned to $1.00, and **no cbETH** (Base publishes no cbETH/USD feed).
`contracts/src/oracle/ChainlinkOracle.sol`.

## Why it matters

This contract is the protocol's answer to [[c6-oracle-byzantine]]. The custom median in
[[oracleaggregator]] could not be secured against adversarial sources inside a constructor — its
integrity depends on a correctly-sized source set and a strict-majority quorum a creator can size
wrong and an attacker can game by selectively stalling sources. ChainlinkOracle **removes the median
entirely**: it trusts Chainlink's own decentralized OCR aggregation per asset. There is no median,
no quorum, and no per-vault source list to misconfigure — so the whole C-6 / H-1 / M-1 attack
surface disappears. This is the [[chainlink-direct-pivot]] decision made concrete.

## Deploy scaffolding (Phase 3)

Fully merged and ready for operator handoff:
- **`DeployChainlinkOracle.s.sol`** — deployment script; populates the chain's feed config at runtime (`base-mainnet.json` for Base). Its `requiresSequencerUptimeFeed(chainId)` is the deploy-time sequencer enforcement, and it is an ENUMERATION of exempt chains rather than a universal: a local node, Base Sepolia, and — on the owner's decision of 2026-09-04 — Robinhood Chain (4663), for which Chainlink publishes no uptime feed and has said it will not add one. On an exempt chain there is no deploy-time refusal and no price-time gate, so nothing enforces the feed there at all.
- **`scripts/verify-chainlink-oracle.mjs`** — on-chain verifier confirms each feed is live and responsive before go-live.
- **Integration test** (`AuditC6Integration.t.sol`) — ChainlinkOracle × VaultCore end-to-end flow.
- **Fuzz suite** — property-based safety of price staleness, bounds-checking, sequencer uptime, and feed failure paths.
- See [[go-to-market-plan]] for the safe deploy sequence.

## Key state

- `feedOf[asset]` — `FeedConfig { IAggregatorV3 feed; uint32 heartbeat; uint64 scale; uint128
  minPriceWad; uint128 maxPriceWad; }`. `scale = 10**(18 - feedDecimals)`, cached at construction.
  `feed == address(0)` is the unlisted sentinel.
- `usdc` (immutable) — a token pinned to $1.00 (WAD), matching the TWAP source's quote-leg pin. The
  constructor forbids an asset being both pinned USDC **and** carrying a feed.
- `sequencerUptimeFeed` (immutable) — Chainlink L2 Sequencer Uptime Feed; `address(0)` off a
  sequencer L2 (local / L1 / tests).
- `GRACE_PERIOD` = 3600 s — prices in the first hour after a sequencer restart are not trusted.

## How it prices (`priceWad`)

Order matters, and every failure surfaces as `StaleOracle(asset)` and nothing else:

1. **Sequencer gate first** (`_requireSequencerUp`) — reverts unless the L2 sequencer is up AND has
   been up longer than the grace period. No-op when no uptime feed is configured.
2. **USDC pin** — returns `1e18` for the pinned quote leg.
3. **Feed read** (`try latestRoundData`) — rejects `answer <= 0`, `updatedAt == 0`, a future
   timestamp, and staleness past the heartbeat (saturating lower bound). Normalizes by `scale`.
4. **Sane-price band** (when enabled) — rejects a price outside `[minPriceWad, maxPriceWad]`. This
   defends against a feed reporting a **deprecated min/maxAnswer clamp value** during a depeg /
   flash-crash, which reads as "fresh" but out-of-band; fail closed rather than price it.

Like [[oracleaggregator]] it **never returns 0** and **never returns a stale price** — every NAV
path in a consuming vault freezes on a bad read, including exits (the accepted K-4 / SF-2 posture).

## How it resolves C-6

[[c6-oracle-byzantine]] is a property of *median selection over a curated source set* — it lives in
[[oracleaggregator]]. ChainlinkOracle links the same finding with the **opposite** framing: by
having exactly one feed per asset and delegating aggregation to Chainlink's OCR network, there is no
"2-of-n freshness regime" for a creator to size wrong or an attacker to game. The finding is
**resolved**, not merely mitigated, for a vault that chooses this oracle.

## Tradeoffs (accepted, stated honestly)

- **Single-provider dependency:** a feed deprecation / freeze fails that asset closed (safe, but the
  vault freezes with no fallback).
- Assets **without** a Chainlink feed on the chain cannot be listed.
- A feed updates only on its heartbeat or a deviation-threshold move, so a price up to ~the
  deviation band stale reads as "fresh" — a bounded, inherent-to-Chainlink NAV arb. The vault-side
  defense is M-15's `minSharesOut` (see [[vaultcore]]).
- **`decimals()` assumption:** `scale` is cached on the convention that Chainlink holds `decimals()`
  constant across proxy upgrades. A decimals change on upgrade would silently mis-scale — accepted,
  documented, convention-backed.

## Construction-time proofs

The constructor reads each feed's `decimals()` and calls `latestRoundData()` to prove the feed
speaks the AggregatorV3 ABI where a mistake is still fixable. Because config is immutable, the
per-call raw-staticcall decode guard that [[oracleaggregator]] needs (C-3) is **not** repeated — no
listed feed can later revert-with-empty on a well-formed proxy. Codeless feeds, `decimals > 18`,
zero-address / duplicate assets, and an ill-ordered price band are all rejected.

## Links

- [[contracts-index]] · [[oracleaggregator]] · [[oracle-sources]] · [[vaultcore]]
- Architecture: [[oracle-layer]]
- Findings: [[c6-oracle-byzantine]] · [[c3-oracle-brick]]
- Decision: [[chainlink-direct-pivot]] · [[build-vs-buy]] · [[launch-readiness-gates]]
