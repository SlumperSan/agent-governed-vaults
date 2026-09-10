# Governance

The per-vault governance module: commit-reveal proposals, quorum tallying, standing absentee
defaults, delegation, and the timelock + execution window. A singleton shared by every vault, keyed
by vault address. `contracts/src/Governance.sol`.

## Why it matters

Members govern these vaults by voting, and this is where a vote becomes an authorized action
against [[vaultcore]] — `executeRebalance`, `allocateToChild`, `redeemFromChild`, or a `RuleChange`
that rewrites the vault's own `GovConfig`. Getting the vote accounting wrong is not a UX bug; it is
a path to draining the vault. Three of the six criticals and most of the M-tier live in or touch
this contract. It is also the second-largest contract by bytecode but has comfortable EIP-170
headroom, so unlike [[vaultcore]] it was not byte-constrained during remediation.

## Lifecycle

`propose → commit phase → reveal phase → finalize → [timelock] → execute | expire`

One active proposal per vault (`activeProposalOf`) — serialization is the CM-6 spam defense and
keeps the Mode-F coupling in [[vaultcore]] unambiguous. Voting power is read from VaultCore
checkpoints at `createdAt - 1` (VO-9), so stake minted in the proposal's own block — flash deposits
included — carries zero weight.

## Key state

- `configOf[vault]` — the immutable-until-RuleChange `GovConfig` (phase durations, `quorumBps`,
  `proposalThresholdBps`, `concentrationCapBps`, `proposalCooldown`).
- `proposals[pid]` — `Proposal` with `createdAt`, phase deadlines, `snapshotTotal`, `memberCount`,
  `forWeight` / `againstWeight` (tally, includes defaults), `revealedWeight` /
  `revealedVoterCount` (the **quorum numerator** — defaults never count).
- `commitOf`, `revealedOf`, `revealedSupportOf`, `defaultApplied`, `delegateAccrued`.
- `standingDefaultOf`, `delegateOf`, `lastProposalAt` (per-proposer).
- `subVaultRegistry` — one-shot `wireSubVaultRegistry`, for SV-6 quorum-floor inheritance.

## Entry points

- `registerVault(vault, cfg)` — once, by the vault creator; validates config and enforces the
  parent quorum floor (SV-6).
- `propose(vault, ptype, actionHash)` — `ProposalType` is `Rebalance | RuleChange | ChildAllocation`.
- `commitVote(pid, commitment)` / `revealVote(pid, support, salt)`.
- `revealDelegated(pid, delegator)` / `applyStandingDefault(pid, member)` — permissionless cranks.
- `setStandingDefault` / `clearStandingDefault` / `setDelegate`.
- `finalize(pid)` / `execute(pid, payload)` / `markExpired(pid)`.
- `hasPendingExecution(vault)` / `isExecutor(vault, account)` — the `IGovernance` coupling read by
  VaultCore.

## Invariants and deliberate mechanics

- **`hasPendingExecution` turns true at REVEAL START, not finalize** (VO-8 / K-1). Once reveals
  begin the outcome leaks on-chain, so an exit taken after that point must be forward-priced (Mode
  F). It turns false on Defeated / Executed / expiry (EE-10 — a queued exit can always eventually
  settle). This is the single most load-bearing fact linking Governance to [[two-mode-exits]].
- **Quorum regimes** (in `finalize`): `RuleChange` = full consensus (every unit of snapshot stake
  revealed FOR, CM-8 / K-2); `<5` members at creation = the H-8 signer regime (below); otherwise
  revealed stake >= `quorumBps` of `snapshotTotal` (VO-2).
- **Defaults count toward the tally, never toward quorum** (VO-2 / K-3), expire `DEFAULT_TTL` (72h)
  after being set (VO-3), and are structurally limited to `Rebalance` on-chain (VO-4 — not
  proposer-asserted text). The TTL is measured when the default is APPLIED, and `applyStandingDefault`
  is reveal-phase-only, so the commit phase consumes part of it: the **usable** window is
  `DEFAULT_TTL - cfg.commitDuration` (T-1). `COMMIT_HARD_CAP = DEFAULT_TTL - 1` is what guarantees
  that window is never empty.
- **Payload type is never inferred from shape** — `execute` decodes strictly per the stored
  `ProposalType`; `keccak256(payload) == actionHash` binds voters to the exact orders.

## Phase durations — the floor is the shipped value

**`commitDuration` and `revealDuration` are already at the contract minimum, so "shorten the
governance windows" is not a configuration change.** `_validateConfig` requires each to be
`>= 1 hours` (`contracts/src/Governance.sol:242-243`), and both shipped configs set both to 3600
with `timelockDuration` 0 — `smoke.gov` in `contracts/config/base-mainnet.json` and
`contracts/config/base-sepolia.json`. So the fastest round this contract can run is
**1 h commit + 1 h reveal + 0 timelock = 2 h from `propose` to the earliest `execute`**, and that is
what is deployed. Going lower needs a contract change, not a config edit, and `Governance.sol` is a
**singleton shared by every vault** — so that change is not scoped to one vault either.

**The consequence for an hourly cadence.** A design that wants one governance decision per hour
cannot get it from this contract: two hours is the floor. An hourly epoch has to either apply a rule
this contract already passed — the vote sets policy, the epoch executes it, and no vote runs per
epoch — or run on a different contract. Recorded here because the arithmetic is the whole answer,
and it is cheaper to read than to rediscover.

**What a shorter window would actually trade away**, stated so the cost is not assumed to be
front-running:

- **Participation, which is the real cost.** Quorum is measured on *revealed* stake —
  `revealedWeight` is the numerator and standing defaults never count toward it (VO-2 / K-3). A
  member who is not online inside the commit window is silent, and a member who commits but misses
  the reveal window is silent *and* has burned their commitment. Halving the phases roughly doubles
  the share of members a round can lose to being asleep. One active proposal per vault
  (`activeProposalOf`) means a round lost to quorum also costs `proposalCooldown` before anything
  can be retried.
- **The withheld-reveal grief gets cheaper to time.** Commits close before reveals open, so an early
  revealer leaks the tally direction to voters who are already committed. Their only remaining move
  is to withhold their own reveal and starve quorum. That is available at any window length; a
  shorter reveal phase compresses the window in which it has to be decided.
- **Mode-F exposure shrinks, which is a benefit, not a cost.** `hasPendingExecution` turns true at
  **reveal start** (VO-8 / K-1), so every exit from that moment until the proposal settles is
  forward-priced. A shorter reveal phase shortens that period. See [[two-mode-exits]].
- **It does not buy back the one leak that matters.** The orders themselves are public in
  `execute`'s calldata whatever the phases are — `keccak256(payload) == actionHash` binds voters to
  the exact orders but does not hide them from the mempool. Phase durations are not the lever on
  that, and shortening them does not move it either way.

## Security findings that live here

- [[c2-unbounded-governance]] — the phase-duration **hard caps** (`COMMIT_HARD_CAP`,
  `REVEAL_HARD_CAP`, `EXECUTION_WINDOW_HARD_CAP`, `TIMELOCK_HARD_CAP`, and the new
  `PROPOSAL_COOLDOWN_CAP`). These fields are `uint32`, settable to ~136 years; unbounded, a vault
  frozen mid-proposal could never legislate its way out (an unresolvable proposal blocks every
  future proposal, and `hasPendingExecution` stays true so every exit freezes). Now bounded on both
  sides.
- [[c5-vote-after-exit]] — **`_boundedWeight` takes `min(snapshot, current)`**. This is C-5's fix
  and it *lives here*, not in VaultCore: VaultCore only supplies the checkpoint reads. Previously an
  attacker could deposit a dominant position, propose, exit completely (Mode I, instant), then
  reveal FOR with full snapshot weight on stake they no longer owned — reducing the skin-in-the-game
  requirement from days (timelock) to seconds. Taking the minimum closes the withdrawal direction
  and finally makes EE-10's claim true (Mode-F-locked shares lose eligibility on the motivating
  proposal).
- **H-8 (CM-7)** — the `<5`-member regime is now an **OR of two branches**: (1) a strict majority
  of members-at-creation revealed AND the FOR side clears the stake quorum; or (2) an outright FOR
  stake majority regardless of head count. Branch 2 is purely additive (never locks anyone out — it
  is *not* the M-6 floor). **Still unfixed by design:** buying the 5th seat to reach the stake
  regime costs exactly `minDepositUsdc`, mitigated at the config layer.
- **M-6** — the CM-6 / VO-5 defences (`proposalThresholdBps`, `concentrationCapBps`,
  `proposalCooldown`) used to ship **disabled** in the reference configs. Now: concentration cap
  ceiling 5000 bps (a delegate may not carry >50%), cooldown floor 1h. Deliberately **no floor on
  `proposalThresholdBps`** — a floor was implemented, measured, and reverted (a flat membership
  would make every member unable to propose, i.e. C-2's self-locking shape).
- **M-7 — OPEN.** `lastProposalAt` is keyed **per-proposer**, so a second address sidesteps the
  cooldown entirely. The bounds raise the cost of serial-proposal cycling but do **not** rate-limit
  it. Stated honestly in the code; the cooldown cap does not close M-7.
- Sprint-6 findings **F1** (a member's own weight is never concentration-capped — only delegated
  weight is; self-accrual bricked dominant-holder vaults), **F2** (SV-6 floor re-checked on
  RuleChange update), **F4** (a standing default must be set *before* the proposal and within TTL).

## Size — EIP-170

Runtime **12,155 B**; EIP-170 margin **12,421 B** (measured 2026-09-02 — re-measure, do not copy). (The task's "~12.1KB" is the
runtime *size*, not the headroom.) Governance net *shrank* during remediation despite gaining M-6's
bounds, because C-5's fix replaced four inline weight reads with one `_boundedWeight` helper.

## Links

- [[contracts-index]] · [[vaultcore]] · [[subvaultregistry]]
- Architecture: [[governance-commit-reveal]] · [[two-mode-exits]]
- Findings: [[c2-unbounded-governance]] · [[c5-vote-after-exit]] · [[highs]] · [[mediums-and-lows]]
- [[threat-model-commitments]]
