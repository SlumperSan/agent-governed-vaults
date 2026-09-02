# Walkthrough — Governance.sol

**Risk: Critical (authorizes every fund movement).** ~490 LoC. `contracts/src/Governance.sol`.

## Purpose

The Sprint 2 module: proposal lifecycle with commit-reveal voting, three quorum regimes,
standing defaults, delegation with a concentration cap, post-vote timelock, and typed
execution against the vault. One protocol singleton serves all vaults; per-vault behavior
comes from `configOf[vault]` (a `GovConfig`), registered once by the creator and thereafter
mutable only via full-consensus RuleChange.

It is also the source of the one signal VaultCore's exit path depends on:
`hasPendingExecution(vault)` — the Mode-I/Mode-F switch (VO-8/K-1 coupling).

## Lifecycle

```
propose ──► commit phase ──► reveal phase ──► finalize ──► [timelock] ──► execute
                                                 │                          │
                                                 └─► Defeated               └─► (window lapses) markExpired
```

- **One active proposal per vault** (`activeProposalOf`) — serialization is the CM-6 spam
  defense and keeps the Mode-F coupling unambiguous.
- `hasPendingExecution` is true from **reveal start** (outcome starts leaking on-chain) until
  Executed / Defeated / expiry — so exits requested after reveals begin are forward-priced,
  and queued exits always release eventually (EE-10).

## Proposal types (structurally distinct on-chain, VO-4)

| Type | Quorum | Standing defaults? | Execution payload |
| --- | --- | --- | --- |
| `Rebalance` | normal (regime below) | **Yes — only type** | `(adapter, SwapOrder[])` → `vault.executeRebalance` |
| `RuleChange` | **full consensus**: `revealedWeight == snapshotTotal && forWeight >= snapshotTotal` | No | `GovConfig` → validate + parent-floor check + store |
| `ChildAllocation` | normal | No | `(child, allocateUsdc, redeemShares)` → `allocateToChild` / `redeemFromChild` |

The payload is bound at propose time by `actionHash = keccak256(payload)`; `execute` requires
the exact bytes and decodes keyed on the stored `ptype` — voters approve the
`(ptype, actionHash)` pair, so payload type-confusion was examined and judged sound (S6
governance review, Coverage).

## Quorum regimes (finalize)

1. **RuleChange:** every unit of snapshot-eligible stake revealed FOR (CM-8/K-2).
2. **Signer regime** (`memberCount < 5` at creation): `revealedVoterCount * 2 > memberCount`
   — absolute head-count majority (CM-7). The regime is **fixed per proposal at creation**
   from `pastHolderCount(createdAt − 1)`; membership changes never flip an in-flight proposal.
3. **Stake quorum** (≥5 members): `revealedWeight * BPS >= quorumBps * snapshotTotal`, with
   `quorumBps >= 2500` (25% protocol floor). **Only revealed (live) weight counts** — standing
   defaults never touch the quorum numerator (VO-2/K-3).

Pass additionally requires `forWeight > againstWeight` in every regime.

## Voting paths (mutually exclusive per member per proposal)

| Path | Who | Counts in quorum? | Notes |
| --- | --- | --- | --- |
| `commitVote` → `revealVote` | member with weight at snapshot | Yes | Commitment binds `(pid, voter, support, salt)` — no cross-proposal replay, no direction change at reveal. **Own weight is never concentration-capped** (G1 fix) |
| `revealDelegated(pid, delegator)` | anyone (crank) | Yes | Requires the delegate to have revealed; routes the delegator's weight onto the delegate's direction; `_accrueDelegate` enforces the concentration cap on **received** weight; self-commit takes precedence |
| `applyStandingDefault(pid, member)` | anyone (crank) | **Never** | Rebalance-only (on-chain type check); default must **predate the proposal** (`setAt < createdAt`, G4 fix) and be within its 72h TTL; tally direction only |

Mutual exclusion: `revealVote` needs a commit; the two cranks require `commitOf == 0` and
share the `defaultApplied` consumed-flag. So `revealedWeight ≤ snapshotTotal` with each member
counted at most once (verified in the S6 review and by `invariant_revealedNeverExceedsSnapshot`).

## Snapshot discipline (VO-9)

All weight reads — proposer eligibility, commit gate, reveal weight, delegated weight, default
weight — use `pastVotingEligibleShares(…, createdAt − 1)`: strictly before creation, so stake
minted in the proposal's own second (flash deposits included) carries zero weight. First-ever
deposits mint no shares at all (observation window), doubly defeating atomic flash-stake.
`snapshotTotal` and `memberCount` are captured once at propose and never rewritten.

## Config (`GovConfig`) validation

`commitDuration ≥ 1h`, `revealDuration ≥ 1h`, `executionWindow ≥ 1h`,
`commitDuration < DEFAULT_TTL` (i.e. `≤ COMMIT_HARD_CAP = DEFAULT_TTL - 1`, the **T-1** bound —
a commit phase at or beyond the 72h standing-default TTL outlives every default, so VO-3 would be
dead before the reveal window opened), `timelockDuration ≤ 30 days` (hard cap),
`2500 ≤ quorumBps ≤ 10000`,
`proposalThresholdBps ≤ 10000`, `0 < concentrationCapBps ≤ 10000`. Plus SV-6 parent-floor
inheritance — `quorumBps >= parent's quorumBps` — enforced at **both** `registerVault` and the
RuleChange update path (G2 fix; the check is shared, `_requireParentQuorumFloor`).

The `commitDuration ≥ 1h` floor is load-bearing beyond UX: it guarantees exiters at least one
hour of Mode-I notice between `Proposed` and the Mode-F lock engaging at reveal start
("propose → instantly trap exiters" is impossible).

## External entry points

`wireSubVaultRegistry` (one-shot, deployer-only), `registerVault` (creator, once),
`propose`, `commitVote`, `revealVote`, `revealDelegated`, `setStandingDefault` /
`clearStandingDefault`, `applyStandingDefault`, `setDelegate` (blocked mid-proposal),
`finalize`, `execute`, `markExpired`, and the views `hasPendingExecution` / `isExecutor`.

Note the **trust direction**: Governance calls into VaultCore (`executeRebalance`,
`allocateToChild`, `redeemFromChild`) as the authorized caller; VaultCore calls back only
through the bounded, non-blocking `hasPendingExecution` read. A bricked Governance therefore
degrades vaults to Mode-I-only exits — never a lockup (H-1 design).

## Invariants

- One live (Active/Passed-unexpired) proposal per vault (`invariant_atMostOneLiveProposal`).
- `revealedWeight ≤ snapshotTotal`; `forWeight + againstWeight` consistent with reveals +
  cranked defaults/delegations (`invariant_roundAccountingConsistent`).
- `snapshotTotal` immutable per proposal.
- Standing defaults contribute to tally only — a vault of pure defaults is defeated in every
  regime (accepted-rows review, Area 2).

## Trickiest paths (review focus)

1. **`execute` payload decoding across the three types.** Keyed on stored `ptype` + exact
   `actionHash` bytes. Adversarial question: can any payload decode validly under two types,
   or can a vault-side callee (`allocateToChild` etc.) be reached with arguments voters did
   not approve? (Vault re-validates child edges independently.)
2. **Quorum regime boundary at exactly 5 members (CM-7).** Regime snapshots at creation;
   `holderCount` includes fully-queued members (weight 0 but still holders), which errs
   toward harder-to-pass. Check the boundary arithmetic both sides.
3. **Concentration cap after the G1 fix.** Own weight uncapped; only cranked delegation
   accrues via `_accrueDelegate` (re-checked per accrual, order-independent). Residual freeze
   case = delegator who neither self-votes nor can be cranked ≡ offline member (accepted K-2).
4. **The Mode-F coupling.** `hasPendingExecution` truth table vs. VaultCore's queue/settle
   paths: Active+reveal-phase → true; Passed within window → true; everything else false.
   EE-10: a passed-but-never-executed proposal expires → queued exits settle at then-current
   NAV. Check `markExpired`/`_refreshStatus` cannot be used to flip state mid-settlement.
5. **RuleChange full consensus + the parent exclusion.** Reachable for allocated children
   only because VaultCore excludes the parent position from `snapshotTotal` (GA-1); regression
   `test_childRuleChangePassesAfterParentAllocates`.

## Accepted risks that live here (do not re-report)

- **K-2/CM-8:** one permanently-offline member freezes RuleChange forever — intended.
- **K-3/VO-2/VO-3:** standing defaults can dominate *direction* once ≥25% live stake clears
  quorum; 72h expiry can leave a vault voiceless — intended liveness floor.
- **GA-2/VO-7:** the running tally is publicly readable mid-reveal (public `proposals` getter
  + cleartext `Revealed` events). Commit-binding on `support` prevents direction change; the
  originally-specified "tally view gating" was deliberately not built.
- **VO-6:** a large holder abstaining can deny stake quorum with their own absent weight —
  the inherent participation requirement, not a griefing primitive.
- Proposer holding the payload preimage can let a passed proposal expire unexecuted
  (releasing Mode-F exits at then-current NAV) — execution-layer optionality bounded by EE-10.
