# Sprint 1 Security Review — VaultCore

Adversarial review by the Security department. Scope: `contracts/src/VaultCore.sol`,
`contracts/src/lib/SafeTransferLib.sol`, `contracts/src/lib/Checkpoints.sol`,
`contracts/src/interfaces/*.sol`, against `docs/ARCHITECTURE.md` and `docs/THREAT-MODEL.md`.

Method: every candidate was traced against the actual code before being written up. Accepted
threat-model rows (K-1..K-4, EE-8/9, CM-8, VO-3, PX-1, SF-2) are **not** reported unless a new
consequence beyond the documented one was found. Findings that turned out sound on inspection are
listed in §"Verified sound" so the coverage is auditable.

---

## Findings

### H-1 — A reverting creator-chosen module (`governance` / `feeEngine` / `operatorRegistry`) permanently bricks ALL exits

**Severity: H (permanent capital lockup). Confidence: high on the mechanism; the trust-model
judgement is argued below.**

**Code path.** `_settleExit` and the two request entrypoints make *un-guarded* external calls to
three immutable, constructor-supplied modules on the exit path:

- `VaultCore.sol:308` `requestExit` → `governance.hasPendingExecution(address(this))`
- `VaultCore.sol:324` `settleQueuedExit` → `governance.hasPendingExecution(address(this))`
- `VaultCore.sol:387` `_settleExit` → `feeEngine.onRealize(member, gain, 0)`
- `VaultCore.sol:392` `_settleExit` → `operatorRegistry.recordRealization(member, gain, 0)`
- `VaultCore.sol:395-396` `_settleExit` (loss branch) → `feeEngine.onRealize(...)`, `operatorRegistry.recordRealization(...)`

If **any** of these three modules reverts (or returns a returndata bomb that OOGs the caller, or
consumes all forwarded gas), the enclosing call reverts. Consequences:

- `governance.hasPendingExecution` reverting ⇒ **both** `requestExit` (line 308) and
  `settleQueuedExit` (line 324) revert. No member can start an exit in either mode, and no queued
  Mode-F exit can ever settle.
- `feeEngine.onRealize` **or** `operatorRegistry.recordRealization` reverting ⇒ every call to
  `_settleExit` reverts, killing Mode-I instant exits (`requestExit`→`_settleExit`, line 314) and
  Mode-F settlement (`settleQueuedExit`→`_settleExit`, line 327) alike.

`deposit`/`activate`/`skipWindow` do **not** touch these modules, so capital keeps flowing *in*
while every path *out* is dead. Combined with §12 of ARCHITECTURE.md ("No proxies, no upgradeable
contracts… Implementations are immutable") there is **no recovery**: the funds are trapped forever.

**Concrete failure sequence (honeypot variant).**
1. A permissionless vault creator deploys `VaultCore` with a benign-looking `operatorRegistry`
   whose `recordRealization` reverts once `block.timestamp > T` (or once cumulative recorded gain
   crosses a threshold, or for one targeted member). Nothing in the constructor
   (`VaultCore.sol:138-180`) can detect this — the registry is just an address.
2. Members deposit; TVL grows past the trigger.
3. Every `requestExit`/`settleQueuedExit` now reverts inside `recordRealization`. All member USDC
   and basket assets are permanently locked. The creator's own stake is locked too, but a griefer
   or a creator who has already extracted value off-chain does not care.

**Non-malicious variant (why this is not merely "PX-3 scam vaults").** `governance` is the real
Sprint-2 module that VaultCore is designed to pair with. A *bug* in the eventual
`hasPendingExecution` (e.g. it reverts when a proposal is in an unexpected state, or reads a
mapping that underflows) would brick exits on **honest** vaults, protocol-wide — not just on
attacker-crafted ones.

**Why this is a NEW consequence, not a documented Accepted risk.**
- K-4 / SF-2 accept an *oracle*-induced freeze only; the reasoning ("any exit hatch during
  staleness is the stale-price exit the breaker exists to prevent") is specific to price staleness
  and does **not** transfer to bookkeeping modules that have nothing to do with valuation.
- PX-3 covers scam vaults that *imitate reputable operators via metadata*; it does not cover a
  vault that accepts deposits and then traps them via a reverting module.
- EX-1 covers malicious *adapters*, a different call surface.
- The code itself already declares these modules untrusted: the "Defensive clamp: never trust the
  module beyond its contract" at `VaultCore.sol:388-391` bounds how much value a hostile
  `feeEngine` can *take*. That same distrust is not applied to *liveness* — a hostile or buggy
  module cannot steal via the clamp, but it can still brick every exit. That asymmetry is the bug.

**Proposed minimal fix.** Make the exit path robust to module failure. `feeEngine` and
`operatorRegistry` are pure post-facto bookkeeping and must never gate a member's withdrawal:

```solidity
// fee engine — default to zero fee on any failure, still clamped
try feeEngine.onRealize(member, gain, 0) returns (uint256 f) { perfFee = f; }
catch { perfFee = 0; }
// … existing clamp (cap = gain/10, cap to usdcPay) stays …

// registry — never let a mark block the exit; record best-effort, emit on failure
try operatorRegistry.recordRealization(member, gain, 0) {}
catch { emit RealizationRecordFailed(member, gain, 0); }
```

Use a bounded-gas low-level call (or the 63/64 return-bomb guard) so a returndata bomb cannot OOG
the `try`. For `governance.hasPendingExecution`, a revert is trickier because the *correct* mode is
what the reverting call was supposed to tell us; at minimum wrap it and pick a documented,
liveness-preserving fallback (e.g. on revert, allow instant Mode-I settlement and emit an event),
accepting that a genuinely mid-rebalance-but-reverting governance would permit a pre-execution
exit — strictly better than permanent lockup. Whichever fallback is chosen, it must be a
deliberate, documented decision rather than the current implicit "revert everything."

---

### L-1 — Creator can permanently self-lock shares (and their voting weight) via an un-cancellable, gate-violating Mode-F queue

**Severity: L (self-inflicted lockup of own shares; no third-party fund loss). Confidence: high.**

**Code path.** `requestExit` (`VaultCore.sol:303-316`) does **not** evaluate the creator 5%
withdrawal gate — the gate lives only in `_settleExit` (`VaultCore.sol:336-341`). In Mode F
(`governance.hasPendingExecution() == true`) the request is *queued* without any gate check
(lines 308-312). Queued exits are irrevocable (there is no cancel for a queued exit, and
`requestExit` reverts with `ExitAlreadyQueued` on any second attempt, line 305).

**Failure sequence.**
1. Non-creator members exist (`nonCreatorMemberCount > 0`) and a rebalance is pending.
2. Creator calls `requestExit(fullStake)` (or any amount that would drop them below 5%
   post-burn). It queues successfully — no gate check at queue time.
3. Execution finishes. Anyone calls `settleQueuedExit(creator)`. Inside `_settleExit`, the gate at
   line 337-338 fails: `(memberShares - burnShares) * BPS >= CREATOR_MIN_STAKE_BPS * (ts - burnShares)`
   is false, so it reverts `CreatorStakeGate()`.
4. `queuedExitShares[creator]` stays non-zero forever. The creator cannot re-queue a smaller,
   gate-compliant amount (`ExitAlreadyQueued`), cannot cancel, and cannot settle. Those shares are
   frozen out of voting eligibility (`votingEligibleShares` subtracts `queuedExitShares`,
   line 431) with no way back — until enough non-creator members leave that
   `nonCreatorMemberCount` reaches 0, at which point the gate no longer applies.

No funds are lost (shares still owned, NAV still accrues to them) and it is self-inflicted, but it
is a real irreversible state hole: the creator's governance weight can be accidentally and
permanently zeroed, which in a small vault can shift control.

**Proposed minimal fix.** Evaluate the creator gate at queue time too, so a gate-violating Mode-F
exit reverts on `requestExit` instead of getting stuck at settlement:

```solidity
if (msg.sender == creator && nonCreatorMemberCount > 0) {
    require(
        (sharesOf[msg.sender] - shares) * BPS >= CREATOR_MIN_STAKE_BPS * (totalShares - shares),
        CreatorStakeGate()
    );
}
```

(Alternatively, allow a queued exit to be cancelled or amended — but that reopens EE-10's
"exit-then-veto" surface, so the front-gate is the cleaner fix.)

---

## Verified sound (examined, no vector found)

These were adversarially checked because the brief called them out; each held up.

- **First-deposit inflation / donation attack (EE-1).** `navWad` (`VaultCore.sol:186-194`) reads
  only internal `idleUsdc`/`assetBalance`, never `balanceOf`. A direct token donation cannot move
  NAV or share price, so the classic ERC-4626 first-depositor inflation griefing does not apply.
  `_mintShares` rounds `minted` down and requires `minted > 0` (lines 275-276); `minDepositUsdc`
  is enforced twice (lines 208, 218). Confirmed against `test_donationDoesNotMoveNav`.
- **§4.6 NAVps-non-decreasing invariant.** Proved generally: on exit, NAV falls by exactly the
  transferred value `payoutValueWad`, and every component of the payout (`usdcPay` line 351, each
  `slice` line 372) rounds **down** with `keepBps ≤ BPS`, so `payoutValueWad ≤ nav·burnShares/ts`
  (the exact pro-rata). That is precisely the algebraic condition for NAVps to be non-decreasing.
  The `perfFee` leaves only from the exiter's own cash slice (already removed from `idleUsdc` at
  line 368), so it does not touch remainers. Holds for mixed decimals since every rounding is down.
- **Mixed-decimals precision (6-dec USDC / 8-dec assets).** `navWad` and `_settleExit` multiply
  before dividing (`bal * priceWad / assetUnit`, lines 192/375); intermediate products
  (~1e8 · 1e23 = 1e31) are far below uint256 range. `payoutValueUsdc = payoutValueWad / usdcScalar`
  truncation only ever *understates* the exiter's reported gain (→ lower fee), never overstates it.
- **Reentrancy / CEI across the exit loop.** All state-mutating externals are `nonReentrant`
  sharing one lock (lines 97-102), so a malicious basket token invoked by `tryTransfer`
  (line 377) cannot re-enter `deposit`/`requestExit`/`claimEscrowed`/etc. Within `_settleExit`,
  shares/`totalShares`/`nonCreatorMemberCount`/`holderCount`/`idleUsdc` are all updated
  (lines 355-368) *before* any external call, and each `assetBalance[a]` is decremented (line 374)
  before its own `tryTransfer`. Escrow-on-failure keeps `assetBalance`/`claimable` consistent with
  the physical (un-transferred) tokens. CEI is sound.
- **Perf-fee clamp (hostile fee engine).** `cap = gain/10` then `perfFee ≤ usdcPay`
  (lines 389-391) bounds a hostile `feeEngine` to at most 10% of gain and never more than the
  exiter's own cash leg; the in-kind leg is untouchable. Confirmed against
  `test_perfFeeClampedTo10PctOfGain`. (This clamp is exactly why H-1's *liveness* gap stands out —
  value is guarded, availability is not.)
- **Cost-basis rounding (`basisRemoved`).** `basisRemoved = costBasis · burnShares / memberShares`
  divides by the member's own shares, not `ts` (line 365), and rounds down, leaving residual basis
  with the member. That *understates* future gains (lower fee) — favorable to the member, never a
  vault leak, and not profitably gameable. The exit-fee-as-realized-loss effect (a break-even exit
  paying the 1% fee registers a small loss carryforward) is real but unprofitable (you pay $X in
  exit fee to build $X of carry that saves ≤$0.1X later) and already sits under CM-5's
  Sprint-6 self-dealing analysis — no new consequence.
- **Capacity cap + pending escrow (SF-3).** `deposit` counts `navUsdc + totalPendingUsdc + amount`
  against the cap (line 212); pending never double-counts (moves from `totalPendingUsdc` to
  `idleUsdc` on activation, decremented on cancel). No cap bypass via pending found.
- **Observation-window state machine.** `shares > 0 ⇒ windowCleared == true` for every path into
  `_mintShares` (immediate-mint branch requires it; `_activatePending`/`skipWindow` set it), so a
  pending deposit and live shares can never coexist; the `PendingExists` guard (line 224) blocks
  stacked pendings. Cancel/activate/skip transitions are consistent.
- **VO-9 stake snapshots (`Checkpoints.sol` + `_snapshot`).** A member's `_eligibleHist` changes
  only on that member's own actions (`sharesOf` and `queuedExitShares` are only ever mutated by the
  member), and each such action calls `_snapshot` (lines 287, 311, 361). The shared
  `_totalEligibleHist`/`_holderCountHist` are re-pushed on every mutation, so denominator and
  holder-count histories track latest state. Same-timestamp `push` overwrite collapses to the
  block's final state (standard OZ-style semantics, not a masking vector). `uint192` capacity
  (~6.3e57) is unreachable by any realistic `totalShares`. Binary-search `getAt` is correct
  (last checkpoint ≤ ts, 0 if none). No snapshot inconsistency found; whether governance reads
  pre- or post-activation state in the same block is a Sprint-2 concern (EE-2), not a Sprint-1 bug.
- **SafeTransferLib.** `safeTransfer`/`safeTransferFrom` handle missing-return-value tokens;
  `tryTransfer` returns false instead of reverting, correctly feeding the EE-6 escrow path.

---

## Summary table

| # | Sev | Path | Consequence |
| --- | --- | --- | --- |
| H-1 | H | `VaultCore.sol:308,324,387,392,395-396` | Any reverting creator-chosen `governance`/`feeEngine`/`operatorRegistry` permanently bricks all exits; no upgrade path ⇒ permanent lockup. New consequence beyond K-4 (oracle-only) and PX-3 (metadata scams). |
| L-1 | L | `VaultCore.sol:303-316` vs gate at `336-341` | Creator can queue a gate-violating, un-cancellable Mode-F exit that can never settle, permanently freezing their own shares/voting weight. |
