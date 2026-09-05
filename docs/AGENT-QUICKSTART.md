# Agent Quickstart

Integrate an AI agent with the index-vault protocol in minutes. This page is written for machines
and the humans wiring them: everything an agent needs to **act on-chain** — deposit, propose, vote,
exit — is here or one link away. The contracts are the whole integration surface; there is no key
to request and no gateway between an agent and a vault.

- **On-chain ABIs:** `contracts/out/*/*.json` after `forge build`
- **Chain configuration:** [`contracts/config/robinhood-mainnet.json`](../contracts/config/robinhood-mainnet.json)
  — assets, feeds, sane-price bands and the settlement token
- **SDK:** [`packages/agent-sdk`](../packages/agent-sdk) (env-agnostic JS client)
- **Machine index:** [`/llms.txt`](../llms.txt)

## 1. Act on-chain

Every state change goes directly to the contracts (ABIs in `contracts/out/` after `forge build`).
The agent-relevant entrypoints:

| Goal | Call | Notes |
| --- | --- | --- |
| Join a vault | `VaultCore.deposit(amountUsdc)` | First deposit enters a **4-hour observation window** (no shares/votes yet). Call `activate(self)` after the window, or `skipWindow()` to opt in immediately (irreversible, once per vault). |
| Propose | `Governance.propose(vault, ptype, actionHash)` | Needs ≥ `proposalThresholdBps` of eligible stake. `ptype`: 0 Rebalance, 1 RuleChange, 2 ChildAllocation. |
| Vote | `Governance.commitVote(pid, hash)` then `revealVote(pid, support, salt)` | **Commit-reveal** — two txns. `hash = keccak256(abi.encode(pid, voter, support, salt))`. Missing the reveal window forfeits your vote. |
| Delegate | `Governance.setDelegate(vault, delegate)` | Concentration-capped on the delegate's *received* weight. |
| Exit | `VaultCore.requestExit(shares)` | Instant pro-rata **in-kind** (Mode I). While `Governance.hasPendingExecution(vault)` is true — from the moment a live proposal reaches its **reveal phase**, not from the moment one passes, and on through a passed proposal's execution window — it queues and settles at **post-rebalance NAV** (Mode F). Call `settleQueuedExit(self)` once the proposal executes, is defeated, or its window lapses. |

**Read NAV/eligibility before acting:** `VaultCore.navPerShareWad()`,
`pastVotingEligibleShares(member, ts)`, `exitFeeBpsOf(member)`.

**Spend control (recommended):** wrap the signer with a per-task budget and a per-tx cap so a
compromised prompt can't drain the agent wallet. Use a dedicated hot wallet funded per session —
never the treasury. (See the `llm-trading-agent-security` patterns.)

## 2. Things an integrating agent must know (protocol semantics)

- **Observation window:** a first deposit is sequestered 4h with no shares and no vote. Budget for
  it; use `skipWindow()` only if you accept immediate entry.
- **Forward pricing:** the queueing window opens when a live proposal reaches its **reveal phase**
  (`Governance.hasPendingExecution` returns true from `commitDeadline` onward), **not** when a
  proposal passes, and it stays open while a passed proposal is inside its execution window. An
  exit requested in that window settles at the *post*-rebalance price — you carry the rebalance
  outcome, and a proposal that is ultimately *defeated* still queued your exit while it was live.
  Check `Governance.hasPendingExecution(vault)` before every `requestExit`.
- **Oracle breaker:** the vault prices its basket from **one genuine Chainlink Data Feed per
  asset** (`ChainlinkOracle`; WETH via ETH/USD, cbBTC via BTC/USD, USDC pinned). If that feed
  breaches its heartbeat or the sane-price band, or the Base sequencer is down or inside its
  post-recovery grace period, `priceWad` reverts and **everything freezes, including exits** — by
  design, and with **no fallback source**. The oracle is immutable per vault, so check
  `VaultCore.oracle()` against the blessed set before you deposit and don't strand funds in a vault
  whose feeds you don't trust. Un-activated (observation-window) deposits stay reclaimable during a
  freeze via `cancelPending`, which reads no oracle.
- **Fees:** 10% of realized profit (per-member high-water mark that follows *operator identity*
  across vaults) + an exit fee ≤1% decaying with tenure, paid to remaining members. Sub-vaults
  stack fees — read `SubVaultRegistry.stackedPerfFeeBps(vault)` / `stackedExitFeeCapBps(vault)`.
- **Reputation is portable:** your realized losses under an operator shelter future gains under
  that *same operator* from fees. Operator identity is the registry key, not display metadata —
  verify via `OperatorRegistry.operatorOf(vault)` before trusting a vault's branding.

## 3. Index the chain yourself (optional)

`packages/indexer` folds normalized events into vault/operator state with deterministic replay.
Point `src/chain.mjs` at your RPC + the factory/registry addresses to run your own projection of
vault and operator state.
