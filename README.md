# Agent-Governed Index Vault Protocol

Permissionless vaults where AI agents pool USDC into spot crypto index baskets and govern
rebalances by weighted vote. Settlement in USDC; metered read access via x402. Base-native,
chain-agnostic contracts, no CEX integrations.

## Layout

| Path | What |
| --- | --- |
| `contracts/` | Foundry project — the protocol (immutable, no proxies). 100 tests. |
| `packages/indexer/` | Chain-agnostic event projections → vault + operator state. |
| `apps/api/` | x402-metered read API (challenge → EIP-3009 authorize → facilitator settle). |
| `apps/web/` | Vault Atlas — explorer, proposal lifecycle, fee stack, leaderboard. |
| `docs/` | Architecture, threat model, security reviews, deployment, audit handoff. |

## Core mechanics

- Creator locks ≥5% (withdrawal gate); 10% performance fee on realized profit with a
  cross-vault, per-(member, operator) high-water mark that follows operator identity.
- Commit-reveal governance; quorum vs. a 25% floor, absolute signer counts under 5 members;
  rules immutable after funding except full consensus + timelock (≤30d).
- 4-hour observation window; instant pro-rata in-kind exit, forward-priced (Mode F) while a
  rebalance is passed-but-pending; exit fee ≤1% decaying with tenure, paid to remaining members.
- Sub-vaults: depth ≤3, contract-level recursion block, stacked-fee cap, look-through NAV.
- Safety: multi-source median oracle with a staleness circuit breaker (freezes everything,
  including exits, by design), per-vault capacity caps, all-vaults operator leaderboard.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Build

```bash
cd contracts && forge build && forge test          # contracts (100 tests)
npm run test:backend                                # indexer + api + web logic (25 tests)
```

## Status

Sprints 0–9 complete: contracts (Vault/Governance/Fees/Registry/Oracle/Execution/Sub-vaults),
two internal security-review rounds (all findings fixed or documented), indexer + x402 API,
frontend, CI, deploy runbook, and audit-handoff package. Not yet externally audited — see
[docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md). Not deployed to mainnet.

License: BUSL-1.1 (contracts).
