# Agent-Governed Index Vault Protocol

Permissionless vaults where AI agents pool USDC into spot crypto index baskets and govern
rebalances by weighted vote. Settlement in USDC; metered read access via x402. Base-native,
chain-agnostic contracts, no CEX integrations.

## Layout

| Path | What |
| --- | --- |
| `contracts/` | Foundry project — the protocol (immutable, no proxies). |
| `packages/indexer/` | Chain-agnostic event projections + persistence + a runnable daemon. |
| `packages/agent-sdk/` | Env-agnostic client: the x402 402→authorize→retry loop + typed methods. |
| `apps/api/` | x402-metered read API (challenge → EIP-3009 authorize → facilitator settle). |
| `apps/web/` | Vault Atlas — consumer app: discover, inspect governance/fees, deposit/exit. |
| `docs/` | Architecture, threat model, security reviews, design specs, deploy + audit handoff. |

## Contracts

`VaultCore`, `Governance`, `FeeEngine`, `OperatorRegistry`, `OracleAggregator`, two execution
adapters (`AggregationRouterAdapter`, `DirectPoolAdapter`), `SubVaultRegistry`, `VaultFactory`.

- Creator locks ≥5% (withdrawal gate); 10% performance fee on realized profit with a cross-vault,
  per-`(member, operator)` high-water mark that follows operator identity.
- Commit-reveal governance; quorum vs. a 25% floor, absolute signer counts under 5 members;
  rules immutable after funding except full consensus + timelock (≤30d).
- 4-hour observation window; instant pro-rata in-kind exit, forward-priced (Mode F) while a
  rebalance is passed-but-pending; exit fee ≤1% decaying with tenure, paid to remaining members.
- Sub-vaults: depth ≤3, recursion block, stacked-fee cap, recursive look-through NAV.
- Safety: multi-source median oracle with a staleness circuit breaker (freezes everything,
  including active-share exits, by design; pending capital is always reclaimable); per-vault
  capacity caps (optional — `capacityCapUsdc == 0` is uncapped).

Two internal security-review rounds plus a governance accepted-rows re-review; every finding
fixed or documented ([docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md)). Hardened with invariant/
fuzz suites for share conservation, NAVps-non-decreasing, solvency, the cross-vault carry HWM,
the oracle median, and governance rounds.

## Agent integration

Agents bootstrap from one free call — `GET /.well-known/x402` (pricing, routes, spec pointers) —
then discover vaults (`GET /vaults`), read metered data, and act on-chain. See
[docs/AGENT-QUICKSTART.md](docs/AGENT-QUICKSTART.md), [docs/api/openapi.yaml](docs/api/openapi.yaml),
and [`/llms.txt`](llms.txt).

## Build & test

```bash
cd contracts && forge build && forge test          # contracts (116 tests, incl. invariant/fuzz)
npm run test:backend                                # indexer + agent-sdk + api + web (46 tests)
```

CI runs both plus `forge fmt --check`, a gas-snapshot gate, and slither ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Status

Contracts, indexer (+persistence/daemon), metered API (+discovery), agent SDK, and the consumer
front end are built and tested to a pre-audit state. Not yet externally audited; not deployed to
mainnet — see [docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

License: BUSL-1.1 (contracts).
