# Sprint 6: Adversarial Pass on Deliberately-Accepted Governance Rows

Scope: the four governance areas whose "Accepted" tradeoffs never got an adversarial pass against
the stated design intent, because the prior governance review (`SPRINT6-GOVERNANCE-REVIEW.md`, Agent A)
ran **without** `docs/ARCHITECTURE.md` / `docs/THREAT-MODEL.md` (they were at a path it could not see).
This pass closes exactly that gap: for each accepted row, does the code actually hold *as the design
docs claim*, or does it diverge / carry an unstated worse consequence?

This does **not** re-litigate Agent A's five findings (F1–F5 / G1–G5); those fixes are present in the
code and are treated here only where they interact with an accepted row. Every claim below is verified
against the current source.

Files verified:
- `contracts/src/Governance.sol`
- `contracts/src/VaultCore.sol`
- `contracts/src/lib/Checkpoints.sol`

Verdict legend: **(a) holds as designed** · **(b) diverges: code ≠ doc claim** · **(c) accepted
tradeoff has an unstated worse consequence.**

---

## Area 1: K-2 / CM-8: "Rules immutable after funding except full consensus + timelock"

**Verdict: (c) DIVERGES: the accepted tradeoff carries an unstated worse consequence for any
allocated sub-vault. Severity: Medium (permanent loss of a documented capability; no funds at risk).**
The full-consensus *mechanism* is exactly as the doc claims (below), but the "one offline member freezes
rules" acceptance understates reality: **an allocated child vault's config is structurally, permanently
unamendable, not contingent on any agent going offline.**

Doc claim (ARCHITECTURE §6, THREAT-MODEL CM-8): RuleChange config setters are reachable only by
100% of voting-eligible stake revealed FOR + timelock; near-immutability is the intent; one permanently
offline member freezes rules forever (accepted).

### The unstated worse consequence: a parent-allocated child can never pass a RuleChange

K-2 accepts a *contingent social event*: an agent goes offline, so 100% consensus becomes unreachable
until it returns. The sub-vault feature turns that into a *structural guarantee* the moment a parent
allocates capital, and there is no recovery path the child controls:

1. `allocateToChild` (`VaultCore.sol:603-626`) calls `child.skipWindow()` then `child.deposit(amount)`
   with the parent contract as `msg.sender`, so `child._mintShares(parent, …)` → `child._snapshot(parent)`
   permanently records the parent's shares in the child's `_eligibleHist` **and** `_totalEligibleHist`.
   Every subsequent child RuleChange therefore has a `snapshotTotal` that *includes the parent's weight*.
2. `revealedWeight == p.snapshotTotal` (`Governance.sol:399`) can then never be reached, because a
   `VaultCore` parent **cannot vote**: grep of the entire `contracts/src/` tree shows the five governance
   entry points (`commitVote`, `revealVote`, `revealDelegated`, `setDelegate`, `setStandingDefault`) have
   **no contract caller at all**: they are EOA-only, and VaultCore contains no code that calls any of
   them. The "self-commit directly" escape I relied on for the over-cap-delegator case does not exist for a
   contract holder.
3. The parent's shares cannot be parked in an excluded state either. The only way `_snapshot` excludes
   shares is `queuedExitShares` (Mode-F) or a burn. But `_redeemChildMeasured`
   (`VaultCore.sol:654-655`) **reverts `ChildSettlementPending`** if the child queues the exit, and a
   partial `redeemFromChild` leaves a nonzero, still-eligible remainder. Only a *full* redemption while the
   child has no pending proposal removes the parent from `snapshotTotal`, and the child cannot compel its
   parent to do that; it depends entirely on the parent's own governance choosing to unwind the allocation.

So while any parent allocation exists (the normal steady state of a sub-vault, ARCHITECTURE §10), the
child's config is frozen with no child-side recovery. This directly contradicts ARCHITECTURE §12 ("the
only mutable surface is vault config behind full-consensus + timelock"): for an allocated child there is
**no** mutable surface at all. It is distinct from Agent A's F2 (which used the "parent can't vote" fact
only as a reachability caveat to route a *pre-allocation* exploit; it never claimed CM-8 itself was
structurally dead post-allocation).

A confirming detail that this is live, not theoretical: the G2/F2 fix at `Governance.sol:433`
re-applies `_requireParentQuorumFloor` on the RuleChange **update** path specifically to protect allocated
children, but that branch is unreachable for exactly those allocated children, since they can never pass
a RuleChange to reach line 433 in the first place.

**Minimal remediations (design choice, not prescribed here):** exempt a `VaultCore`-held (parent) position
from a child RuleChange's `snapshotTotal`; or give the parent a governance-reachable relay so its child
stake can reveal under parent consensus; or define RuleChange consensus over *EOA-reachable* eligible
stake. Any of these restores the §12 invariant for allocated children. At minimum, ARCHITECTURE §10/§12
and THREAT-MODEL CM-8/SV-1 should document that allocation makes a child's config permanently immutable.

### The full-consensus mechanism itself is sound (verified)

**Full-consensus test is exactly as stated.** `finalize` for `ProposalType.RuleChange`
(`Governance.sol:396-399`):

```solidity
quorumOk = p.revealedWeight == p.snapshotTotal && p.forWeight >= p.snapshotTotal;
```

combined with the shared pass gate `quorumOk && p.forWeight > p.againstWeight` (408). Because standing
defaults are structurally Rebalance-only (`applyStandingDefault` reverts `NotRebalance` for any other
type, `352`), `forWeight` on a RuleChange is fed **only** by real reveals (`282`, `310`). So passing a
RuleChange requires literally every eligible share to have revealed FOR. Matches intent.

**snapshotTotal cannot be inflated/deflated between snapshot and reveal.** It is captured once at
`propose` (`237`, `p.snapshotTotal = total` where `total = pastTotalVotingEligibleShares(nowTs-1)`) and
is never written again anywhere in the contract (struct field, no setter). Confirmed by inspection of all
`snapshotTotal` references (`237`, `399`, `405`, `322`). "Full consensus with less than everyone" would
require `revealedWeight` to reach `snapshotTotal` while some eligible share never revealed:
impossible, because:
- `revealedWeight` is incremented only in `revealVote` (`284`) and `revealDelegated` (`312`), each by a
  weight read from the same historical checkpoint (`createdAt-1`), and each member is counted at most
  once (`commitOf`/`defaultApplied` mutual-exclusion, verified by Agent A and unchanged);
- the total checkpoint equals the sum of per-member checkpoints by construction: `_snapshot`
  (`VaultCore.sol:380-384`) pushes `_totalEligibleHist = totalShares - totalQueuedShares` and
  `_eligibleHist[m] = sharesOf[m] - queuedExitShares[m]` in the same call, and
  `totalShares = Σ sharesOf`, `totalQueuedShares = Σ queuedExitShares` are maintained together on every
  mutation. So `revealedWeight ≤ snapshotTotal`, with equality iff all eligible weight revealed.

**A Mode-F-queued / exited member does not deadlock the consensus.** Queuing an exit
(`requestExit`, `VaultCore.sol:401-403`) writes `queuedExitShares[m]` and immediately calls `_snapshot`,
so the member's *eligible* weight drops at queue time and their burned shares vanish from `snapshotTotal`
at settlement. A member who fully exits before a later RuleChange's snapshot is therefore **not** part of
`snapshotTotal` and is not required to reveal. A partially-queued member keeps only their residual
eligible weight and can still reveal it (they still hold the shares; `pastVotingEligibleShares(createdAt-1)`
reads the historical value). No new deadlock beyond the *accepted* "offline member freezes rules."

**Interaction with the concentration-cap fix (F1/G1) is clean.** `revealVote` now adds the member's own
weight directly with **no** `_accrueDelegate` call (`280-285`; the cap applies only to *received*
delegated weight in `revealDelegated`→`_accrueDelegate`, `308`/`319-326`). This is what makes RuleChange
full-consensus *reachable* for a sole/dominant holder: the pre-fix code bricked it. I checked the dual
question: does the cap create a **new** RuleChange freeze via the delegation path? A delegator whose
weight cannot be cranked because the delegate is over-cap can always instead `commitVote`+`revealVote`
directly (uncapped own vote; `revealDelegated` yields to a self-commit at `300`). The only residual freeze
is a delegator who neither self-votes nor can be cranked (i.e. an effectively-offline member) which is
precisely the already-accepted K-2 consequence, not a new one.

Same-second minting cannot inflate consensus: a deposit checkpointed at `createdAt` is excluded from both
`snapshotTotal` and the minter's own weight (see Area 4).

---

## Area 2: K-3 / VO-2 / VO-3: standing defaults count in tally, never quorum; 72 h TTL; must predate proposal

**Verdict: (a) HOLDS as designed.**

**A vault of pure standing defaults genuinely cannot pass anything**: verified across all three
finalize regimes (`Governance.sol:396-406`). Standing defaults touch **only** `forWeight`/`againstWeight`
(`368-369`) and explicitly *not* `revealedWeight` / `revealedVoterCount` (comment `370`, and neither is
assigned in `applyStandingDefault`):

- **RuleChange:** needs `revealedWeight == snapshotTotal`; defaults contribute 0 → fails (and defaults are
  Rebalance-only anyway).
- **Signer regime (`memberCount < 5`):** needs `revealedVoterCount*2 > memberCount`; defaults contribute 0
  to `revealedVoterCount` (only `revealVote` increments it, `285`) → 0 > memberCount is false → fails.
- **Stake quorum (`memberCount ≥ 5`):** needs `revealedWeight*BPS ≥ quorumBps*snapshotTotal`;
  `quorumBps ≥ 2500` and defaults contribute 0 to `revealedWeight` → 0 ≥ (positive) is false → fails.

So zero live participation ⇒ defeated in every regime. The intended liveness floor holds. (The
*documented* VO-2 behaviour that defaults can dominate *direction* once ≥25% real stake clears quorum is
intact and is the accepted routine-rebalance semantics, not a defect.)

**The new `d.setAt < p.createdAt` lower bound (F4/G4) has no off-by-one that reopens tally-aware
defaults.** `applyStandingDefault` freshness check (`360-362`):

```solidity
require(d.set && d.setAt < p.createdAt && block.timestamp <= d.setAt + DEFAULT_TTL, DefaultUnavailable());
```

`setAt = uint64(block.timestamp)` at `setStandingDefault` (`332`); `createdAt = nowTs` at `propose`
(`232`). The inequality is **strict** (`<`), so:
- a default set in the *same second* as proposal creation (`setAt == createdAt`) is **excluded**: the
  conservative direction;
- any default set *during* the reveal phase has `setAt ≥ commitDeadline > createdAt`, so `setAt < createdAt`
  is false → rejected. Tally-aware post-hoc defaulting (the F4 exploit) is closed.

A default that legitimately predates the proposal (`setAt < createdAt`) was necessarily chosen before any
reveal existed (the tally is empty until `commitDeadline > createdAt`), so its direction is blind to the
proposal: exactly the "pre-declared absentee ballot" intent. Re-setting a default to refresh the TTL does
not help an attacker: the refreshed `setAt` must still precede the target proposal, so it remains
tally-blind. No reopening.

---

## Area 3: VO-6 / VO-7: commit-reveal, non-revealers forfeit (self-grief only); reveal-phase last-mover

**Verdict: VO-6 (a) HOLDS. VO-7 (b) DIVERGES from the stated "tally view gated" mechanism: Low
severity, no worse consequence than the already-accepted residual.**

**VO-6. A non-revealer cannot starve quorum for others: holds.** A commit is just a stored hash
(`commitVote`, `248-256`); it does not touch `snapshotTotal`, `revealedWeight`, or any other member's
weight. A committer who withholds their reveal is arithmetically identical to a member who never
committed: they add nothing to the numerator and subtract nothing from anyone else's reveal. The
denominator (`snapshotTotal`) is fixed at propose. So a large holder abstaining can deny quorum *with
their own absent weight* (the inherent participation requirement, mitigated by defaults/delegation), but a
non-revealer has **no** primitive to cancel or waste *another* member's revealed weight. Self-grief only,
as VO-6 states.

**VO-7. Divergence: the tally is NOT gated on-chain during the reveal phase.** THREAT-MODEL VO-7's
mitigation text claims "all-or-nothing tally publication — reveals accumulate in contract state but tally
view gated until reveal deadline." The code implements no such gating:
- `proposals` is a `public` mapping (`Governance.sol:109`); its auto-generated getter returns the full
  `Proposal` struct (including `forWeight`, `againstWeight`, `revealedWeight`) **at any time**, including
  mid-reveal. Each `revealVote` updates these immediately (`282-284`).
- `revealVote` also emits `Revealed(pid, voter, support, weight)` in cleartext per reveal (`286`, event
  `132`), so the running tally is fully reconstructable in real time even without the getter.

So a late revealer *can* read the partial tally before the reveal deadline. **Why this is only Low and not
a worse consequence:** commit-reveal binds *direction*: `revealVote` requires
`c == keccak256(abi.encode(pid, msg.sender, support, salt))` (`273`), so a late revealer can only reveal
the exact `support` they committed. They cannot flip direction on seeing the tally. The residual edge is
purely selective-reveal (reveal-or-abstain timing) and coordinated withholding to deny quorum. Note the
realized gap is actually *wider* than the residual VO-7 anticipated: VO-7 accepts specifically that
"mempool observation defeats this," but the public `proposals` getter (`109`) plus the indexed cleartext
`Revealed` event (`132`) make the running tally a free, permanent, post-hoc **contract-state** read:
available to a party doing no mempool observation at all, and readable even after the fact. It remains Low
only because commit-binding on `support` (`273`) still forbids any direction change; the property VO-7
cares about (no direction-changing last-mover advantage) is preserved by commit-binding, not by the
never-built "tally view gated" mechanism. Worth a doc correction (VO-7 should describe the actual
commit-binding defense and drop the unimplemented gate claim); not a new exploit.

---

## Area 4: Snapshot soundness: `createdAt - 1` strictly-before, for proposer eligibility AND vote weight

**Verdict: (a) HOLDS as designed.**

**All snapshot reads use `createdAt - 1` consistently.** `propose` reads `pastTotal…(nowTs-1)` and
`pastVotingEligible(proposer, nowTs-1)` with `p.createdAt = nowTs` (`217-238`); `commitVote` (`253`),
`revealVote` (`280`), `revealDelegated` (`305`), and `applyStandingDefault` (`364`) all read at
`createdAt - 1`. `Checkpoints.getAt(ts)` returns the last checkpoint with `ts_cp ≤ ts`
(`Checkpoints.sol:36-45`), and `push` overwrites any same-second checkpoint in place (`23-27`), so at most
one checkpoint exists per timestamp.

**Same-block flash-stake is excluded for both proposer eligibility and vote weight.** A deposit minted in
the same second as the proposal is checkpointed at `ts_cp = createdAt`; `getAt(createdAt-1)` skips it
(`createdAt > createdAt-1`) → weight 0. A same-block flash-staker who tries to `propose` reads `own = 0`
→ `NoWeight` revert (`223`); one who tries to vote reads weight 0 → `NoWeight` in `commit`/`reveal`. And
first-ever deposits mint **no shares at all** (escrowed in the 4 h window, `VaultCore.sol:312-318`), so
atomic flash-loan stake acquisition is doubly defeated.

**Adjacent-block (`createdAt-1`) inclusion is correct, not a vector.** Stake checkpointed at exactly
`createdAt-1` *is* counted, but that is genuine capital deposited at least one second before the proposal
existed, held at risk in the basket, not an atomic flash position. It cannot be atomically withdrawn
(redemption burns at settlement, and once the proposal enters reveal, Mode-F locks the exit). The design
intent (VO-9) is "stake minted *after* `createdAt` carries zero weight"; `createdAt-1` is before
`createdAt`, so counting it is correct. `nowTs - 1` / `createdAt - 1` cannot underflow (`block.timestamp`
is far above 1). No off-by-one.

**No share-mutation path skips `_snapshot`.** Exhaustive check of every writer of the snapshotted
quantities:
- `sharesOf`: written only in `_mintShares` (`371`, `+=`) → `_snapshot` at `376`; and `_settleExit`
  (`474`, `=`) → `_snapshot` at `480`. (grep confirms `sharesOf[...]=` appears only at 371/474.)
- `queuedExitShares`: `requestExit` (`401`) → `_snapshot` at `403`; `settleQueuedExit` (`429`, →0) →
  `_settleExit` → `_snapshot` at `480`.
- `totalShares` / `totalQueuedShares` / `holderCount`: every write sits inside `_mintShares`,
  `_settleExit`, `requestExit`, or `settleQueuedExit`, each of which snapshots after the mutation.
- Shares are **non-transferable**: no `transfer`/`transferFrom` exists on VaultCore (grep confirms none),
  so there is no side-channel that moves stake without a snapshot.

Ordering is post-mutation: in `_settleExit` the snapshot at `480` runs after `sharesOf`/`totalShares`/
`holderCount` are updated (`474-479`), and `settleQueuedExit` zeroes `queuedExitShares` and decrements
`totalQueuedShares` (`429-430`) before that snapshot, so the recorded eligible values are internally
consistent (burning already-queued, already-excluded shares leaves the eligible total unchanged, as it
should).

---

## Summary

| Area | Row(s) | Verdict |
| --- | --- | --- |
| 1 | K-2 / CM-8 full-consensus RuleChange | **Diverges (c), Medium**: mechanism is exact (snapshotTotal immutable; EOA cases hold), but an **allocated child vault's config is structurally, permanently unamendable**: the parent contract is a required member of the child's `snapshotTotal` yet has no code path to vote, and cannot be forced to redeem out. Contradicts ARCHITECTURE §12; not the contingent "offline member" K-2 accepts |
| 2 | K-3 / VO-2 / VO-3 standing defaults | **Holds**: all-defaults vault cannot pass in any regime; `setAt < createdAt` strict bound closes tally-aware defaults with no off-by-one |
| 3 | VO-6 / VO-7 commit-reveal | VO-6 **holds**; VO-7 **diverges (Low)**: tally is publicly readable mid-reveal (public `proposals` getter + cleartext `Revealed` event); no worse than accepted residual because direction is commit-bound |
| 4 | Snapshot soundness | **Holds**: `createdAt-1` excludes same-block mints for proposer + voters; adjacent-block inclusion is real capital; every share mutation routes through `_snapshot`; shares non-transferable |
