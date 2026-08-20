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
cd contracts && forge build && forge test          # contracts (128 tests, incl. invariant/fuzz)
npm install && npm run test:backend                 # indexer + agent-sdk + api + web (81 tests)
```

CI runs both plus `forge fmt --check`, a gas-snapshot gate, an EIP-170 runtime size check, and
slither ([.github/workflows/ci.yml](.github/workflows/ci.yml)). The gas gate covers the 124
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

**Audit candidate frozen — awaiting external audit.** Contracts, indexer
(+persistence/daemon/runnable entrypoint), metered API (+discovery, x402 facilitator), agent SDK,
and the consumer front end are built and tested to a pre-audit state, with a staged Base Sepolia
deploy path and a complete external-audit package. **Not yet externally audited. Not deployed to
any network** — the Base Sepolia work reached pre-flight only, and nothing was ever broadcast
([docs/TESTNET-REPORT.md](docs/TESTNET-REPORT.md)).

Four internal adversarial review rounds are complete. The last
([docs/reviews/SPRINT10-DEPLOYMENT-REVIEW.md](docs/reviews/SPRINT10-DEPLOYMENT-REVIEW.md)) covered
the EIP-170 deployment split — the only contract change since the Sprint-6 reviews — and found no
High or Medium issue. **Audit this tag: `v0.2.0-audit`.** Start at
[docs/CHANGES-SINCE-REVIEWS.md](docs/CHANGES-SINCE-REVIEWS.md), which states exactly what internal
review did and did not cover, then [docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md).

> **If `v0.2.0-audit` is not present in the repository, the freeze is content-complete but
> untagged**, because PRs [#17](https://github.com/SlumperSan/agent-governed-vaults/pull/17) and
> [#19](https://github.com/SlumperSan/agent-governed-vaults/pull/19) still need a human merge —
> the agent harness's permission classifier refuses `gh pr merge`, which is also what has kept
> the Sprint-8 merge train ([#14](https://github.com/SlumperSan/agent-governed-vaults/issues/14))
> from running. The exact merge-and-tag commands are in
> [docs/CHANGES-SINCE-REVIEWS.md §4](docs/CHANGES-SINCE-REVIEWS.md).

**Deployability blocker cleared (Sprint 7).** `VaultFactory` compiled to 27,241 bytes against the
EIP-170 24,576-byte limit, because `new VaultCore(...)` embeds `VaultCore`'s entire creation code —
so the factory was undeployable on any chain while the suite stayed green, since Foundry's test EVM
does not enforce EIP-170. The catch: VaultCore's creation code (24,731 B) is larger than the runtime
cap *by itself*, so it cannot live in any contract's runtime. It now lives in `VaultDeployer`'s
**creation** code, which the deployer's constructor writes into two immutable, non-executable data
contracts; the factory pins that deployer immutably and sends it constructor arguments only. The
factory is 2,718 B, `forge build --sizes` passes, and the trust model is unchanged — attestation is
still factory-only, so calling the deployer directly yields an unattested vault. Closes
[#10](https://github.com/SlumperSan/agent-governed-vaults/issues/10); see threat-model row PX-4 and
[docs/audit/walkthroughs/VaultDeployer.md](docs/audit/walkthroughs/VaultDeployer.md).

See [docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

License: BUSL-1.1 (contracts).
