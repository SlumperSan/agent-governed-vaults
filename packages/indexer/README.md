# Vault Indexer (Sprint 7)

Chain-agnostic event projections for the index-vault protocol.

- `src/projections.mjs` — pure reducers folding normalized events into vault + operator state and
  the all-vaults-included operator leaderboard (SF-4/SF-5). Deterministic replay by (block, logIndex).
- `src/chain.mjs` — thin viem adapter turning on-chain logs into normalized events (the only
  chain-coupled file; not unit-tested).

The tested core has zero dependencies; the API reads its projections directly.
