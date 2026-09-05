# Agent-Governed Index Vault Protocol

RWAlly is the AI agent trading index on Robinhood Chain.
Permissionless vaults where members pool USDG into spot crypto index baskets and ratify
every rebalance by on-chain vote. Proposal rights follow stake, not operatorship: an AI operator
proposes as a member, and operatorship confers no authority to vote, execute, pause, reprice, or
move member funds; nothing rebalances until a proposal passes. Settlement in USDG on Robinhood
Chain mainnet (chain id 4663), where the protocol is deployed. The
contracts carry no chain-specific code, so the same immutable bytecode is deployable on any EVM
chain; no CEX integrations. The next iteration, RWLY, is designed to accrue the protocol's fees
into official Robinhood Stock Tokens; RWLY launched 2026-09-05 at
0x2eed8ae78AE1aa6824e1C378F46d5C51b6B7FDF9 with a fixed supply of 1,000,000,000, on a third-party
launchpad, and that accrual design is not built.

The basket the chain configuration prices is ETH and BTC. On Robinhood Chain those are WETH
(`0x0bd7…ad73`) and cbBTC (`0xcec1…0be4`), priced from that chain's own Chainlink `ETH / USD` and
`CBBTC / USD` feeds, with USDG (`0x5fc5…d168`) as the settlement token. Every one of those
addresses was read off chain 4663 rather than typed from memory, and all of them are committed in
[`contracts/config/robinhood-mainnet.json`](contracts/config/robinhood-mainnet.json).

**Deployed on Robinhood Chain mainnet (chain 4663), and the launch verdict on the board is still
NO-GO**; those are two different facts, and the second did not stop the first. Read
[Status](#status) before anything else in this file.

## Why it exists

The S&P 500 tells you what five hundred companies are worth because someone writes the weights
down and everyone can check them. Nothing tells you what autonomous agents would hold if they had
to argue for it in public and win a vote.

A vault here is one answer to that, made checkable. An agent-operator proposes a basket and a
weighting. The members whose money it is vote the proposal up or down by commit-reveal. What
executes is recorded on-chain next to the proposal that asked for it and the votes that carried
it. So the holdings are not an opinion published by anyone: they are a timestamped record of what
an operator proposed and what members were willing to fund, on contracts that cannot be edited
afterwards.

That record is exactly what it says and nothing more. It is not a claim that the conviction was
correct, and it is not a forecast.

## Status

**Deployed 2026-09-05 on Robinhood Chain mainnet (chain id 4663), on the owner's decision
of 2026-09-04, and on no other mainnet.** The address book is
[`contracts/config/deployments/robinhood-mainnet.json`](contracts/config/deployments/robinhood-mainnet.json):
`VaultFactory` `0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1`. That file is written from what
the chain returned and is the authority for every address in it; nothing in this README is.

**The singletons are deployed and wired, and no vault has been created on it yet.** `smokeVault` is
null in that record and `verifiedWiring["factory.vaultCount()"]` is 0, both read from chain 4663 at
block 54,991,182. So there is nothing to deposit into there and no member funds are at stake. Vault
#1 is the creator Safe `0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c`'s to create: `createVault` fixes
`msg.sender` as the vault's immutable creator and attested operator, and no later transaction can
correct that. Two
limits apply there and are stated wherever the chain is named: Chainlink publishes no L2 Sequencer
Uptime Feed for 4663 and has said it will not add one, so `oracle.sequencerUptimeFeed` is the zero
address and the gate returns early rather than reverting; and the feeds publish on an 86,400 s
heartbeat, so a price up to a full day old is accepted, exactly `ChainlinkOracle.MAX_HEARTBEAT`.

**Launch verdict: NO-GO.** That verdict is unchanged and was not cleared by deploying. The argued
board is [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md) (nine gates, each with its evidence),
and it is the authority whenever this section and that document disagree. What is in flight right
now is [docs/NOW.md](docs/NOW.md); `npm run cc` prints the computed state.

**What remains is operational, legal and calendar-bound.** Two gates are open on the board: the
soak drills (gate 3) and the canary re-run (gate 6), both marked STALE because the evidence behind
them was earned against contracts that have since changed. Both need a funded testnet key and a
re-run rather than more code. The testnet lifecycle (gate 2) and the recorded restore drill
(gate 7) were open until recently and are now GO.

**On the external review: read the qualifier.** An external audit was commissioned against the
launch tree at tag `v0.4.0-audit`. On 2026-08-29 the owner attested, having read the report, that
it surfaced **no major issues**. The report contains sensitive material and is **held privately**.
It is deliberately not reproduced or linked in this repository. That is an **owner attestation**,
not something a reader here can independently verify, and neither the scope list nor the
Low/Informational findings have been published. Do not describe this protocol as "audited" without
that qualifier. Whether that attestation currently stands as the basis for the gate is recorded in
gate 1 of [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md), not here.

**The lifecycle evidence is Base Sepolia, and only Base Sepolia.** The full lifecycle has been run end to end on testnet:
create, deposit, activate, propose, commit, reveal, finalize, execute, exit; and gate 2 of the
board records that run and its stated limits. The address book committed at
[`contracts/config/deployments/base-sepolia.json`](contracts/config/deployments/base-sepolia.json)
now describes the **current** deployment, at `sourceCommit` `8a0e1155`, and the per-phase
transaction table for the run against it is
[`docs/evidence/testnet-lifecycle-run.json`](docs/evidence/testnet-lifecycle-run.json). That
deployment carries the adapter fix in
[#108](https://github.com/SlumperSan/agent-governed-vaults/pull/108) and the mutex in
[#101](https://github.com/SlumperSan/agent-governed-vaults/pull/101); the earlier stack at
`5934ef22`, which predated both, is superseded and lives in git history.

One qualifier, because "current" is narrower than it sounds: the only `contracts/src/` change
between `8a0e1155` and `protocol/main` is a NatSpec-only edit to `VaultDeployer.sol`, and with
solc's default `ipfs` metadata that still changes `VaultDeployer`'s own bytecode trailer. The
**vaults** it produces are byte-identical to a `protocol/main` build, because `VaultCore.sol` is
unchanged. The address book's `bytecodeCurrency` block states this precisely. No testnet run is
evidence about the mainnet deployment, and the gate board remains the authority on what is proven.

## Contracts

`VaultCore`, `Governance`, `FeeEngine`, `OperatorRegistry`, `ChainlinkOracle`, two execution
adapters (`AggregationRouterAdapter`, `DirectPoolAdapter`), `SubVaultRegistry`, `VaultFactory`
(with `VaultDeployer`, which carries `VaultCore`'s creation code).

- Creator locks ≥5% (withdrawal gate); 10% performance fee on realized profit with a cross-vault,
  per-`(member, operator)` high-water mark that follows operator identity.
- Commit-reveal governance; quorum vs. a 25% floor, a signer-count-plus-stake regime under 5 members;
  rules immutable after funding except full consensus + timelock (≤30d).
- 4-hour observation window; instant pro-rata in-kind exit, forward-priced (Mode F) from the
  moment any live proposal reaches its reveal phase, **not** from the moment one passes
  (`Governance.hasPendingExecution` is true from `commitDeadline` onward, and stays true while a
  passed proposal is inside its execution window), so a proposal that is ultimately defeated still
  queued the exits requested while it was live; exit fee ≤1% decaying with tenure; the fee
  fraction is retained by the vault rather than paid out, so it accrues to the remaining members'
  share value.
- Sub-vaults: depth ≤3, recursion block, stacked-fee cap, recursive look-through NAV.
  **Disabled at launch**. `VaultFactory.allowSubVaults = false` (the C-1 fix: root vaults only),
  so this code is dormant on the launch path.
- Safety: **one genuine Chainlink Data Feed per asset**, read directly. WETH is priced through
  ETH/USD and cbBTC through CBBTC/USD; the settlement token, USDG on the stated target chain, is
  pinned to $1.00. There is **no cbETH**, because no cbETH/USD feed was read for either mainnet
  configuration (Base has only cbETH/ETH, which is not a USD price). There is no median, no quorum
  and no per-vault source set: each asset maps to exactly one feed, fixed immutably at
  construction. Three guards stand between a bad answer and NAV, and all three fail **closed**:
  an **L2 sequencer uptime gate** with a grace period after recovery, a per-feed **heartbeat**,
  and a **sane-price band**. On Robinhood Chain (chain id 4663) only the last two of those run:
  Chainlink publishes no L2 Sequencer Uptime Feed there, and `_requireSequencerUp` returns early on
  a zero address, so the gate is skipped at price time under the owner-approved exemption of
  2026-09-04; see `docs/DEPLOYMENT.md` and `contracts/config/robinhood-mainnet.json`. `priceWad` reverts rather than return a stale, absent or implausible
  price, which freezes every NAV path including active-share exits (by design; pending
  observation-window capital is always reclaimable). Per-vault capacity caps are optional
  (`capacityCapUsdc == 0` is uncapped).
- **Named residual: single-provider dependency.** Those three guards are the *only* defences
  against a wrong Chainlink answer; there is no second source to cross-check against, so a feed
  that reports a plausible-but-wrong price inside its band and heartbeat is believed. A feed
  deprecation or freeze fails that asset **closed** with **no fallback**: every NAV path in a
  vault holding it (deposits, rebalances and exits alike) reverts until the feed recovers. A
  vault's oracle is `immutable` and the factory allowlist gates creation only, so there is no
  rotation lever (residual 12, "curation immobility", in
  [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md)).

This is the second oracle design. Critical finding **C-6** showed the original bespoke
multi-source median aggregator could not be made Byzantine-safe by curation alone, so it was
replaced rather than patched; the retired stack lives under `contracts/test/retired/` as exploit
evidence and must not be deployed
([docs/audit/AI-AUDIT-REPORT.md](docs/audit/AI-AUDIT-REPORT.md),
[docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md)).

`VaultFactory` was once undeployable, and the fix is worth knowing before you read `VaultDeployer`.
Writing `new VaultCore(...)` embeds `VaultCore`'s entire creation code in the caller, which put the
factory over the EIP-170 runtime limit while the suite stayed green; Foundry's test EVM does not
enforce that limit. That blob now lives in `VaultDeployer`'s own creation code, whose constructor
copies it into two immutable, non-executable data contracts; `deploy` reads them back, appends the
caller's ABI-encoded constructor arguments and `CREATE`s, so the bytes reaching `CREATE` are fixed
at compile time. Attestation is unchanged and stays factory-only: `OperatorRegistry.attestVault`
is callable only by the wired factory, so calling the deployer directly yields an unattested
vault ([docs/audit/walkthroughs/VaultDeployer.md](docs/audit/walkthroughs/VaultDeployer.md),
[#10](https://github.com/SlumperSan/agent-governed-vaults/issues/10)).

`VaultCore` is the contract closest to the cap, at **20,650 B runtime / 3,926 B of margin** against
the 24,576-byte limit, measured with `cd contracts && forge build --sizes` at `16050be0` on
2026-09-02. Re-measure rather than quote this line; `contracts/test/Eip170.t.sol` floors the margin
so it cannot silently regress.

Internal security-review rounds plus an AI pre-audit and two adversarial re-review passes; every
finding fixed, replaced or dispositioned ([docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md),
[docs/audit/AI-AUDIT-REPORT.md](docs/audit/AI-AUDIT-REPORT.md)). **"Dispositioned" is not
"closed", and the difference is load-bearing:** one High (**H-8**, the stake-blind `<5`-member
quorum regime) is partially fixed in code with its regime-flip mitigated only by configuration;
it remains open at the launch configuration. A further class (**H-5/H-6/H-7**) is dormant
solely because `allowSubVaults = false`: not repaired in code, and live again if sub-vaults are
ever enabled. **H-9 was in that class and is no longer**: it was fixed in code on 2026-09-01
(`require(!v.locked(), Reentrancy())` in `VaultCore._fullNavWad`), and that guard is
unconditional; it does not depend on `allowSubVaults`, so enabling sub-vaults does not bring H-9
back. Hardened with invariant/fuzz
suites for share conservation, NAVps-non-decreasing, solvency, the cross-vault carry HWM, the
Chainlink oracle's fail-closed guards, and governance rounds.

## Layout

| Path | What |
| --- | --- |
| `contracts/` | Foundry project: the protocol (immutable, no proxies). |
| `packages/indexer/` | Chain-agnostic event projections + persistence + a runnable daemon. |
| `packages/agent-sdk/` | Env-agnostic client: the x402 402→authorize→retry loop + typed methods. |
| `packages/canary/` | Read-only post-launch watcher for the DEPLOYMENT §6 signals ([docs/CANARY.md](docs/CANARY.md)). |
| `packages/reference-agent/` | Reference operator loop: read, decide, propose, act within a budget. |
| `packages/oplog/` | Shared operational plumbing: structured logging, durability, shutdown, ops checks. |
| `apps/api/` | x402-metered read API (challenge → EIP-3009 authorize → facilitator settle). |
| `apps/web/` | Vault Atlas, consumer app: discover, inspect governance/fees, deposit/exit. |
| `apps/site/` | The public static site: what this is, how it works, and what can go wrong. |
| `scripts/` | Operational runners: `smoke-test.mjs` drives the full on-chain lifecycle via `cast`. |
| `docs/` | Architecture, threat model, security reviews, design specs, deploy + audit handoff. |

## Build & test

```bash
npm install && npm run gate
```

`npm run gate` mirrors [.github/workflows/ci.yml](.github/workflows/ci.yml) step for step:
`forge fmt --check`, entrypoint syntax, `forge build`, the ops check, the backend suite,
`forge test`, the gas snapshot, the EIP-170 runtime size check, and advisory slither, in about
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
| Deploy the contracts to Base Sepolia | [docs/TESTNET-CHECKLIST.md](docs/TESTNET-CHECKLIST.md); one deploy command, one lifecycle smoke-test command |
| Full deploy semantics and wiring order | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Run the live stack (indexer, API, web) | [docs/RUNTIME.md](docs/RUNTIME.md) |
| Review the contracts | [docs/audit/README.md](docs/audit/README.md) |

## Agent integration

Agents integrate against the contracts. Read the chain configuration, build the ABIs with
`forge build`, and call the vault directly; there is no key to request and no gateway in between.
See [docs/AGENT-QUICKSTART.md](docs/AGENT-QUICKSTART.md),
[`contracts/config/robinhood-mainnet.json`](contracts/config/robinhood-mainnet.json),
and [`/llms.txt`](llms.txt).

License: MIT; see [LICENSE](LICENSE). The repository was source-available under BUSL-1.1 until
2026-09-05; see [LICENSE-HISTORY.md](LICENSE-HISTORY.md).
