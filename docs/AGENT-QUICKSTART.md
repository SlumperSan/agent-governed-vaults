# Agent Quickstart

Integrate an AI agent with the index-vault protocol in minutes. This page is written for machines
and the humans wiring them: everything an agent needs to **act on-chain** (deposit, propose, vote,
exit) is here or one link away. The contracts are the whole integration surface; there is no key
to request and no gateway between an agent and a vault.

- **On-chain ABIs:** `contracts/out/*/*.json` after `forge build`
- **Chain configuration:** Arc mainnet, chain id 5042. USDC
  (`0x3600000000000000000000000000000000000000`) is both the settlement token and the gas asset.
  Every deployed address (factory, governance, registries, oracle, the first vault) and the RPC
  endpoints are in [`contracts/config/deployments/arc-mainnet.json`](../contracts/config/deployments/arc-mainnet.json);
  the launch parameters and the reason for each are in
  [`contracts/config/arc-mainnet.json`](../contracts/config/arc-mainnet.json). Read addresses from
  the deployment record, not from this page.
- **Machine index:** [`/llms.txt`](../llms.txt)

## 1. Act on-chain

Every state change goes directly to the contracts (ABIs in `contracts/out/` after `forge build`).
The agent-relevant entrypoints:

| Goal | Call | Notes |
| --- | --- | --- |
| Join a vault | `VaultCore.deposit(amountUsdc)` | First deposit enters a **4-hour observation window** (no shares/votes yet). Call `activate(self)` after the window, or `skipWindow()` to opt in immediately (irreversible, once per vault). |
| Propose | `Governance.propose(vault, ptype, actionHash)` | Needs ≥ `proposalThresholdBps` of eligible stake. `ptype`: 0 Rebalance, 1 RuleChange, 2 ChildAllocation (moves capital to a child vault; Arc's factory has sub-vaults disabled, see section 2). |
| Vote | `Governance.commitVote(pid, hash)` then `revealVote(pid, support, salt)` | **Commit-reveal**: two txns. `hash = keccak256(abi.encode(pid, voter, support, salt))`. Missing the reveal window forfeits your vote. |
| Delegate | `Governance.setDelegate(vault, delegate)` | Concentration-capped on the delegate's *received* weight. **Delegated weight moves the TALLY and never the QUORUM** (VO-2b) — see the note below. |
| Exit | `VaultCore.requestExit(shares)` | Instant pro-rata **in-kind** (Mode I). While `Governance.hasPendingExecution(vault)` is true (from the moment a live proposal reaches its **reveal phase**, not from the moment one passes, and on through a passed proposal's execution window), it queues and settles at **post-rebalance NAV** (Mode F). Call `settleQueuedExit(self)` once the proposal executes, is defeated, or its window lapses. |

### What delegating does, and the one thing it cannot do

**Appointing a delegate changes which way your weight counts. It cannot make your weight count
toward whether the vote is decidable at all.** Once your delegate reveals, anyone may crank your
weight onto their direction — that moves `forWeight`/`againstWeight`. It is deliberately excluded
from `revealedWeight`, the quorum numerator, exactly as a standing default has always been.

**Three consequences a member should know BEFORE joining, not when they first try to vote:**

1. **A vault where most members delegate can stall.** Quorum is `quorumBps` of stake that
   SELF-revealed. If the members who actually show up hold less than that, a Rebalance is Defeated
   however many delegations were cranked onto it.
2. **A `RuleChange` now needs EVERY member to reveal in person.** Full consensus is
   `revealedWeight == snapshotTotal`, and delegation no longer contributes to it. A vault with one
   permanently absent member can still pass Rebalance and ChildAllocation proposals; it can never
   change its own rules. **If that is unacceptable to you, it is a reason not to join that vault.**
3. **It does not freeze the vault.** A Defeated `RuleChange` settles like any other proposal, so the
   next one is not blocked.

**Why the rule is this way:** while cranked weight counted toward quorum, ONE member revealing plus a
stranger cranking offline delegators reached quorum, passed and executed — at the shipped
`quorumBps` 2500 / `concentrationCapBps` 4000, at membership as small as three. The demonstration is
`contracts/test/audit/AuditDelegatedQuorum.t.sol`.

**Read NAV/eligibility before acting:** `VaultCore.navPerShareWad()`,
`pastVotingEligibleShares(member, ts)`, `exitFeeBpsOf(member)`.

**Spend control (recommended):** wrap the signer with a per-task budget and a per-tx cap so a
compromised prompt can't drain the agent wallet. Use a dedicated hot wallet funded per session,
never the treasury. (See the `llm-trading-agent-security` patterns.)

## 2. Things an integrating agent must know (protocol semantics)

- **Observation window:** a first deposit is sequestered 4h with no shares and no vote. Budget for
  it; use `skipWindow()` only if you accept immediate entry.
- **Forward pricing:** the queueing window opens when a live proposal reaches its **reveal phase**
  (`Governance.hasPendingExecution` returns true from `commitDeadline` onward), **not** when a
  proposal passes, and it stays open while a passed proposal is inside its execution window. An
  exit requested in that window settles at the *post*-rebalance price; you carry the rebalance
  outcome, and a proposal that is ultimately *defeated* still queued your exit while it was live.
  Check `Governance.hasPendingExecution(vault)` before every `requestExit`.
- **Oracle breaker:** the vault prices its basket from **one genuine Chainlink Data Feed per
  asset** (`ChainlinkOracle`). On Arc the basket has one non-stable asset, cirBTC, priced by one
  Chainlink BTC / USD feed; USDC is pinned. If that feed breaches its heartbeat or the sane-price
  band, or (on a chain that has one) the sequencer is down or inside its post-recovery grace
  period, `priceWad` reverts and **every call that reads NAV freezes, including exits**, by design, and with **no
  fallback source**. Chainlink publishes no L2 sequencer uptime feed for Arc, which is an L1, so the
  Arc oracle's `sequencerUptimeFeed` is the zero address, `_requireSequencerUp` returns early, and
  that trigger cannot fire on Arc; the feed heartbeat and the sane-price band remain. The oracle's
  configured heartbeat for the cirBTC feed, which is its staleness bound, is 90,000 seconds, equal
  to the cap `MAX_HEARTBEAT` (`contracts/src/oracle/ChainlinkOracle.sol:132`), and the staleness
  trigger fires only after the feed's latest update is more than 90,000 seconds old. That is the
  oracle's bound, not a statement of how often the feed itself publishes. The oracle is immutable per vault, so check
  `VaultCore.oracle()` against the oracle in the deployment record before you deposit and don't
  strand funds in a vault whose feeds you don't trust. Un-activated (observation-window) deposits
  stay reclaimable during a freeze via `cancelPending`, which reads no oracle.
- **Fees:** 10% of realized profit (per-member high-water mark that follows *operator identity*
  across vaults) + an exit fee ≤1% decaying with tenure, paid to remaining members. Where sub-vaults
  exist they stack fees; read `SubVaultRegistry.stackedPerfFeeBps(vault)` /
  `stackedExitFeeCapBps(vault)`.
- **Sub-vaults on Arc:** the Arc factory's `allowSubVaults()` reads false. It is set once in the
  factory constructor and the factory is immutable, so `createChildVault` reverts, no child vault
  exists or can be created through it, and a `ChildAllocation` proposal has no child to move
  capital to. Every Arc vault is a root vault and there are no stacked fees to read.
- **A new vault has no track record, and a default agent skips it:** an operator's record moves only
  when a member exits with a realized gain or loss above zero (`OperatorRegistry.recordRealization`),
  so a vault created today starts with none. The [reference agent](REFERENCE-AGENT.md) refuses such a
  vault unless it is started with the opt-in `unproven-operator` profile, which deposits the vault
  minimum (and refuses a vault whose minimum is above the configured `depositUsdc`) and keeps the exit
  on a negative operator net. The risk is yours to read first: below five
  holders, whether a Rebalance passes depends on stake and on how many addresses vote, a depositor
  who is alone holds more than half of eligible stake, so whoever joins first holds the deciding vote
  on Rebalance proposals, and a RuleChange needs every unit of eligible stake to reveal in favour
  (`Governance.finalize`). The registry's figure also counts every member's realizations, team-operated
  addresses included, with no mark on chain; the agent can report a second figure that leaves out the
  addresses in [`docs/seeded-addresses.json`](seeded-addresses.json). Details and the measured RPC
  log limits: [REFERENCE-AGENT.md](REFERENCE-AGENT.md#joining-a-vault-with-no-track-record).
- **Reputation is portable:** your realized losses under an operator shelter future gains under
  that *same operator* from fees. Operator identity is the registry key, not display metadata;
  verify via `OperatorRegistry.operatorOf(vault)` before trusting a vault's branding.

## 3. Index the chain yourself (optional)

`packages/indexer` folds normalized events into vault/operator state with deterministic replay.
Point `src/chain.mjs` at your RPC + the factory/registry addresses from
[`contracts/config/deployments/arc-mainnet.json`](../contracts/config/deployments/arc-mainnet.json) to run your
own projection of vault and operator state.
