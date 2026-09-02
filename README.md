# Agent-Governed Index Vault Protocol

Permissionless vaults where members pool USDC into spot crypto index baskets and ratify
every rebalance by on-chain vote. Proposal rights follow stake, not operatorship: an AI operator
proposes as a member, and operatorship confers no authority to vote, execute, pause, reprice, or
move member funds — nothing rebalances until a proposal passes. Settlement in USDC; metered read access via x402. Base-native,
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

`VaultCore`, `Governance`, `FeeEngine`, `OperatorRegistry`, `ChainlinkOracle`, two execution
adapters (`AggregationRouterAdapter`, `DirectPoolAdapter`), `SubVaultRegistry`, `VaultFactory`
(with `VaultDeployer`, which carries `VaultCore`'s creation code).

- Creator locks ≥5% (withdrawal gate); 10% performance fee on realized profit with a cross-vault,
  per-`(member, operator)` high-water mark that follows operator identity.
- Commit-reveal governance; quorum vs. a 25% floor, a signer-count-plus-stake regime under 5 members;
  rules immutable after funding except full consensus + timelock (≤30d).
- 4-hour observation window; instant pro-rata in-kind exit, forward-priced (Mode F) from the
  moment any live proposal reaches its reveal phase — **not** from the moment one passes
  (`Governance.hasPendingExecution` is true from `commitDeadline` onward, and stays true while a
  passed proposal is inside its execution window), so a proposal that is ultimately defeated still
  queued the exits requested while it was live; exit fee ≤1% decaying with tenure — the fee
  fraction is retained by the vault rather than paid out, so it accrues to the remaining members'
  share value.
- Sub-vaults: depth ≤3, recursion block, stacked-fee cap, recursive look-through NAV.
  **Disabled at launch** — `VaultFactory.allowSubVaults = false` (the C-1 fix: root vaults only),
  so this code is dormant on the launch path.
- Safety — **one genuine Chainlink Data Feed per asset**, read directly. WETH is priced through
  ETH/USD and cbBTC through BTC/USD; USDC is pinned to $1.00. There is **no cbETH**, because Base
  has no cbETH/USD feed (only cbETH/ETH, which is not a USD price). There is no median, no quorum
  and no per-vault source set: each asset maps to exactly one feed, fixed immutably at
  construction. Three guards stand between a bad answer and NAV, and all three fail **closed**:
  an **L2 sequencer uptime gate** with a grace period after recovery, a per-feed **heartbeat**,
  and a **sane-price band**. `priceWad` reverts rather than return a stale, absent or implausible
  price, which freezes every NAV path including active-share exits (by design; pending
  observation-window capital is always reclaimable). Per-vault capacity caps are optional
  (`capacityCapUsdc == 0` is uncapped).
- **Named residual — single-provider dependency.** Those three guards are the *only* defences
  against a wrong Chainlink answer; there is no second source to cross-check against, so a feed
  that reports a plausible-but-wrong price inside its band and heartbeat is believed. A feed
  deprecation or freeze fails that asset **closed** with **no fallback**: every NAV path in a
  vault holding it — deposits, rebalances and exits alike — reverts until the feed recovers. A
  vault's oracle is `immutable` and the factory allowlist gates creation only, so there is no
  rotation lever (residual 12, "curation immobility", in
  [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md)).

Internal security-review rounds plus an AI pre-audit and two adversarial re-review passes; every
finding fixed, replaced or dispositioned ([docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md),
[docs/audit/AI-AUDIT-REPORT.md](docs/audit/AI-AUDIT-REPORT.md)). **"Dispositioned" is not
"closed", and the difference is load-bearing:** one High (**H-8**, the stake-blind `<5`-member
quorum regime) is partially fixed in code with its regime-flip mitigated only by configuration —
it remains open at the launch configuration — and a further class (**H-5/H-6/H-7/H-9**) is dormant
solely because `allowSubVaults = false`: not repaired in code, and live again if sub-vaults are
ever enabled. Hardened with invariant/fuzz
suites for share conservation, NAVps-non-decreasing, solvency, the cross-vault carry HWM, the
Chainlink oracle's fail-closed guards, and governance rounds.

## Agent integration

Agents bootstrap from one free call — `GET /.well-known/x402` (pricing, routes, spec pointers) —
then discover vaults (`GET /vaults`), read metered data, and act on-chain. See
[docs/AGENT-QUICKSTART.md](docs/AGENT-QUICKSTART.md), [docs/api/openapi.yaml](docs/api/openapi.yaml),
and [`/llms.txt`](llms.txt).

## Build & test

```bash
npm install && npm run gate
```

`npm run gate` mirrors [.github/workflows/ci.yml](.github/workflows/ci.yml) step for step —
`forge fmt --check`, entrypoint syntax, `forge build`, the ops check, the backend suite,
`forge test`, the gas snapshot, the EIP-170 runtime size check, and advisory slither — in about
30 seconds. `--list` explains every step and the deliberate divergences from CI. The individual
suites still run standalone:

```bash
cd contracts && forge build && forge test
```

```bash
npm run test:backend
```

Fuzz and fork gas is excluded from the snapshot gate: fuzz gas is a mean over a corpus that is not
reproducible across machines, and fork tests read live chain state at the latest block (regenerate
with `forge snapshot --nmt "testFuzz|testFork"`).

## Run it

| Goal | Start here |
| --- | --- |
| Deploy the contracts to Base Sepolia | [docs/TESTNET-CHECKLIST.md](docs/TESTNET-CHECKLIST.md) — one deploy command, one lifecycle smoke-test command |
| Full deploy semantics and wiring order | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Run the live stack (indexer, API, web) | [docs/RUNTIME.md](docs/RUNTIME.md) |
| Review the contracts | [docs/audit/README.md](docs/audit/README.md) |

## Status

**Launch verdict: NO-GO.** Every *security* gate is cleared; what remains is operational, legal
and calendar-bound — a testnet lifecycle re-run, a soak, a canary and a recorded restore drill,
all of which need a funded key rather than more code. The argued board is
[docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md); what is in flight right now is
[docs/NOW.md](docs/NOW.md) (`npm run cc` prints the computed state).

**On the external audit — read the qualifier.** An external audit was commissioned against the
launch tree at tag `v0.4.0-audit`. The owner has read the report and **attests that it surfaced no
major issues**. The report contains sensitive material and is **held privately** — it is
deliberately not reproduced or linked in this repository. That is an **owner attestation**, not
something a reader here can independently verify, and neither the scope list nor the
Low/Informational findings have been published. Do not describe this protocol as "audited"
without that qualifier.

**Deployed on Base Sepolia — testnet only, never mainnet, and that deployment is SUPERSEDED.**
Address book at
[`contracts/config/deployments/base-sepolia.json`](contracts/config/deployments/base-sepolia.json),
every address verified on-chain at the time of deployment. A vault has been created, registered
and funded with a USDC deposit priced by the live `ChainlinkOracle`; the remaining lifecycle
phases sit behind the protocol's own observation window and governance timelocks
([docs/TESTNET-REPORT.md](docs/TESTNET-REPORT.md)). **`contracts/src/` has changed since that
deploy** — the record's `sourceCommit` is `5934ef22`, and `VaultCore`, `VaultFactory` and
`ChainlinkOracle` have all moved since — so **no deployment of the current code exists on any
network**, and the lifecycle, soak and canary evidence earned against that bytecode is marked
STALE (gates 2/3/6 in [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md)). Re-verify with
`git diff --stat 5934ef22..HEAD -- contracts/src` before treating any of it as current.

**The oracle pivot is the most important delta for any reviewer.** Critical finding **C-6** showed
the original bespoke multi-source median aggregator could not be made Byzantine-safe by curation
alone, so it was **replaced rather than patched**: the launch oracle is `ChainlinkOracle`, reading
Chainlink Data Feeds directly, and a `VaultFactory` oracle allowlist makes only blessed oracle
instances selectable. The retired `OracleAggregator`, `PythSource` and `UniswapV3TwapSource` stack
now lives under `contracts/test/retired/`, kept solely as the C-4/C-6 exploit evidence — it is not
on the launch path and must not be deployed. See
[docs/audit/AI-AUDIT-REPORT.md](docs/audit/AI-AUDIT-REPORT.md) for the finding and
[docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md) for the handoff.

**Deployability blocker cleared (Sprint 7).** `VaultFactory` once compiled to 27,241 bytes against
the EIP-170 24,576-byte limit, because `new VaultCore(...)` embeds `VaultCore`'s entire creation
code — so the factory was undeployable on any chain while the suite stayed green, since Foundry's
test EVM does not enforce EIP-170. The catch: `VaultCore`'s creation code (24,731 B) is larger than
the runtime cap *by itself*, so it cannot live in any contract's runtime. It now lives in
`VaultDeployer`'s **creation** code, which the deployer's constructor writes into two immutable,
non-executable data contracts; the factory pins that deployer immutably and sends it constructor
arguments only. The factory is small and has roughly 21 kB of margin today; `VaultCore` is the
contract closest to the cap, at **20,481 B runtime / 4,095 B of margin** (measured with
`cd contracts && forge build --sizes` on 2026-09-01, after PR #90 reclaimed 3,849 B — an earlier
`~283 B` figure recorded here is superseded, and `contracts/test/Eip170.t.sol` floors the margin so
the number cannot silently regress). The trust model is unchanged — attestation is still factory-only,
so calling the deployer directly yields an unattested vault. Closes
[#10](https://github.com/SlumperSan/agent-governed-vaults/issues/10); see threat-model row PX-4 and
[docs/audit/walkthroughs/VaultDeployer.md](docs/audit/walkthroughs/VaultDeployer.md).

License: BUSL-1.1 — see [LICENSE](LICENSE).
