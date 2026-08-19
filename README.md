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
| `packages/canary/` | Read-only post-launch watcher for the DEPLOYMENT §6 signals ([docs/CANARY.md](docs/CANARY.md)). |
| `apps/api/` | x402-metered read API (challenge → EIP-3009 authorize → facilitator settle). |
| `apps/web/` | Vault Atlas — consumer app: discover, inspect governance/fees, deposit/exit. |
| `scripts/` | Operational runners — `smoke-test.mjs` drives the full on-chain lifecycle via `cast`. |
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
cd contracts && forge build && forge test          # contracts (119 tests, incl. invariant/fuzz)
npm install && npm run test:backend                 # indexer + agent-sdk + api + web (81 tests)
```

CI runs both plus `forge fmt --check`, a gas-snapshot gate, an EIP-170 runtime size check, and
slither ([.github/workflows/ci.yml](.github/workflows/ci.yml)). The gas gate covers the 115
deterministic tests — fuzz gas is a mean over a corpus that isn't reproducible across machines, so
it's measured but not gated (regenerate with `forge snapshot --nmt "testFuzz"`).

## Run it

| Goal | Start here |
| --- | --- |
| Deploy the contracts to Base Sepolia | [docs/TESTNET-CHECKLIST.md](docs/TESTNET-CHECKLIST.md) — one deploy command, one lifecycle smoke-test command |
| Full deploy semantics and wiring order | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Run the live stack (indexer, API, web) | [docs/RUNTIME.md](docs/RUNTIME.md) |
| Review the contracts | [docs/audit/README.md](docs/audit/README.md) |

## Status

**v0.1.0-rc1** — release candidate. Contracts, indexer (+persistence/daemon/runnable entrypoint),
metered API (+discovery, x402 facilitator), agent SDK, and the consumer front end are built and
tested to a pre-audit state, with a staged Base Sepolia deploy path and an external-audit package.
Not yet externally audited; not deployed to any network.

**Known blocker before any deployment:** `VaultFactory` compiles to 27,241 bytes of runtime code
and exceeds the EIP-170 24,576-byte limit, because it embeds `VaultCore`'s creation code for
`new VaultCore(...)`. Foundry's test EVM does not enforce EIP-170, so the suite is green while the
factory is undeployable on-chain. `forge build --sizes` fails on this, which is why the `contracts`
CI job is red. Tracked in [#10](https://github.com/SlumperSan/agent-governed-vaults/issues/10);
it must be resolved before running [docs/TESTNET-CHECKLIST.md](docs/TESTNET-CHECKLIST.md).

See [docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

License: BUSL-1.1 (contracts).
