> **Status: ALL FINDINGS FIXED (Sprint 3 hardening commit).** H-1 → bounded module calls
> (`lib/BoundedCall.sol`, `MODULE_CALL_GAS`), Mode-I fallback on governance failure. H-2 →
> assembly `tryTransfer`, gas-capped, returndata-bounded. M-1 → creator gate at queue time,
> not re-checked for queued settlements. M-2 → fee withheld uniformly across cash + in-kind
> legs (`onFeeCollectedAsset` + `FeeEngine.pullEscrowed`). Regression suite:
> `contracts/test/ModuleHardening.t.sol`. Threat model rows MO-1..MO-4 added.

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

### H-2 — `tryTransfer` does not deliver EE-6 escrow isolation: a malformed-returndata or returndata-bomb basket token reverts the WHOLE redemption

**Severity: H (permanent capital lockup; directly falsifies a claimed Mitigated(S1) H row).
Confidence: high — verified against the code.**

**Code path.** `SafeTransferLib.sol:24-27`:

```solidity
function tryTransfer(address token, address to, uint256 amount) internal returns (bool ok) {
    (bool callOk, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
    ok = callOk && (ret.length == 0 || abi.decode(ret, (bool)));
}
```

Called mid-loop at `VaultCore.sol:377`. The function is meant to *never revert* so the caller can
escrow a failing slice (EE-6). It has two holes that make it revert anyway, taking the entire
`_settleExit` down with it:

1. **Malformed returndata.** `abi.decode(ret, (bool))` reverts whenever `0 < ret.length < 32`
   (fewer than 32 bytes cannot decode a `bool`). The `ret.length == 0` guard only covers the
   zero-length case, so a token that returns 1–31 bytes with `callOk == true` triggers a revert
   *inside* `tryTransfer`. There is no `try/catch` around it — it propagates and reverts the whole
   redemption.
2. **Returndata bomb.** `bytes memory ret` copies unbounded returndata into the caller's memory,
   with the memory-expansion cost charged to `_settleExit`. A token that returns multi-MB
   returndata OOGs the caller (the 63/64 gas rule does not help — the copy happens in the caller's
   frame after the sub-call returns), reverting the whole redemption.

**Consequence.** For *every* exit, the loop at `VaultCore.sol:370-381` iterates all basket assets
with a non-zero slice. If *one* basket asset is (or becomes) a malformed-returndata or
returndata-bomb token, **every** `requestExit`/`settleQueuedExit` reverts — all member funds are
trapped. This is exactly the scenario EE-6 marks **Mitigated(S1), severity H** ("in-kind transfer
of a token that reverts, blocking all exits… per-asset transfer failure isolates"). The mitigation
handles a plain `require`-revert (`callOk == false` short-circuits `ok` to false → escrow) and a
`return false`, but **not** these two cases — so the claimed mitigation does not hold.

**Reachability is stronger than H-1's.** This needs no malicious *module*, only a basket token that
misbehaves. Basket tokens are routinely upgradeable proxies (USDC itself is one; many wrapped
assets are), so "the creator picked a benign token at construction" does not bound it — an asset
can be upgraded post-listing to return malformed data or a bomb, and `assetUnit`/basket membership
is immutable, so it cannot be removed.

**Proposed minimal fix.** Make `tryTransfer` truly non-reverting with an assembly `call` that:
caps forwarded gas, checks `returndatasize()`, and `returndatacopy`s at most 32 bytes (treating any
`returndatasize() != 0 && returndatasize() < 32` as failure rather than decoding it). Sketch:

```solidity
function tryTransfer(address token, address to, uint256 amount) internal returns (bool ok) {
    bytes memory data = abi.encodeWithSelector(0xa9059cbb, to, amount);
    assembly {
        let success := call(gas(), token, 0, add(data, 32), mload(data), 0, 32)
        // treat 0-length as OK (no-return token); 32-length must decode to true; else fail
        switch returndatasize()
        case 0  { ok := success }
        case 32 { ok := and(success, gt(mload(0), 0)) }
        default { ok := 0 }
    }
}
```

The same unbounded-`ret` pattern in `safeTransfer`/`safeTransferFrom` (lines 12-13, 17-18) should
get the same treatment at the Sprint-6 audit-prep pass; those only ever see USDC today, so the
exposure is lower, but a USDC proxy upgrade is not impossible.

---

### M-1 — A queued Mode-F exit that was gate-compliant at request time can be stranded permanently by third-party deposits, forcing costly capital injection

**Severity: M (third-party-triggerable lockup of the creator's shares + voting weight; forced
capital injection to escape). Confidence: high.**

**Code path.** The creator 5% withdrawal gate is evaluated **only at settlement**, against
`totalShares` *at settlement* (`VaultCore.sol:336-341`). `requestExit` performs **no** gate check
before queuing a Mode-F exit (`VaultCore.sol:303-316`), and queued exits are irrevocable — there is
no cancel path and a second `requestExit` reverts `ExitAlreadyQueued` (line 305).

**Failure sequence (third-party triggered — not self-inflicted).**
1. Creator holds `c = 100` of `T = 1000` (10%). A rebalance is pending, so the creator queues a
   gate-compliant partial exit `b = 52`: at queue time `(100-52)·10000 = 480000 ≥ 500·(1000-52) =
   474000` — compliant, and it queues with no check.
2. Other agents deposit ~500 shares' worth. `T` rises to ~1500.
3. Execution finishes; `settleQueuedExit(creator)` now evaluates the gate against `T = 1500`:
   `480000 ≥ 500·(1500-52) = 724000` is **false** → reverts `CreatorStakeGate()`.
4. The queued 52 shares can never settle (revert), never be cancelled, never be re-queued. They are
   frozen out of voting eligibility (`votingEligibleShares` subtracts `queuedExitShares`, line 431)
   with no way back.

**Escape is costly, which is the attack.** The creator can restore the gate only by depositing more
(solving `(48+d)·10000 ≥ 500·(1448+d)` gives `d ≈ 26` shares), and that deposit resets
`lastDepositTime` at `VaultCore.sol:286`, snapping their exit fee back to the full 1%. So a griefer
who deposits into the vault can force the creator to inject fresh capital and eat a re-maxed exit
fee, or else leave the creator's stake and vote permanently stranded.

**Interaction with the threat model (new consequence).** CM-2 promises passive dilution "only
freezes creator withdrawals until restored." Here passive dilution does more than freeze a future
withdrawal: it *strands an already-queued, previously-valid exit* and *zeroes the creator's voting
weight* with no cancel path — a consequence CM-2 does not describe.

**Proposed minimal fix.** Two changes, both needed:
- Gate at `requestExit` queue time (prevents the self-inflicted variant):
  ```solidity
  if (msg.sender == creator && nonCreatorMemberCount > 0) {
      require((sharesOf[msg.sender]-shares)*BPS >= CREATOR_MIN_STAKE_BPS*(totalShares-shares), CreatorStakeGate());
  }
  ```
- Because the front-gate cannot prevent the third-party-deposit variant, ALSO give a stranded
  queued exit a way out: allow the creator to cancel/amend a queued exit, **or** have
  `settleQueuedExit` settle down to the largest gate-compliant amount and leave the remainder as
  live shares, rather than reverting. (A cancel path lightly reopens EE-10's "exit-then-veto"
  surface, so settle-to-boundary is the safer choice.)

---

### M-2 — Performance fee is collectable only from the cash leg, so an in-kind-heavy exit dodges the §6/§7 "10% of realized profit" commitment

**Severity: M (systematic under-collection of the performance fee vs. the stated commitment).
Confidence: medium — may be an intentional Sprint-1 bound; flagged as a spec/΄code tension for
Sprint 3 to resolve.**

**Code path.** `VaultCore.sol:389-391`:

```solidity
uint256 cap = gain / 10;
if (perfFee > cap) perfFee = cap;
if (perfFee > usdcPay) perfFee = usdcPay;   // ← fee can only come from the cash leg
```

`gain` (line 386) is computed on the **total** payout value, cash + in-kind. But the fee is then
clamped to `usdcPay`, the USDC cash leg only. After any rebalance moves idle USDC into basket
assets, `idleUsdc` (and thus `usdcPay`) is small, while most of a redeemer's payout — and most of
their realized gain — is delivered in-kind. The fee collectable is therefore capped far below
`10% × gain`.

**Failure sequence.** A vault rebalances nearly all idle USDC into an appreciating basket. A member
exits in kind (the default path, §4.5). `gain` is large and mostly unrealized-in-cash; `usdcPay` is
tiny; `perfFee` is clamped to ~0. The member receives the appreciated basket tokens, sells them
off-chain, and has paid essentially none of the "10% of realized profit" the protocol commits to in
ARCHITECTURE §6/§7. This is structural, not a corner case — it is the *normal* state of a fully
invested index vault.

**Counter-argument (why confidence is medium).** The clamp's stated purpose (comment at
`VaultCore.sol:388`, and `test_perfFeeClampedTo10PctOfGain`: "The clamp may consume the whole cash
leg… but never the in-kind leg") is defensive — bounding a *hostile* fee engine, not describing an
intended fee waiver. The real `FeeEngine` lands in Sprint 3, and `IFeeEngine` documents the fee as
"performance fee to withhold from the payout, in USDC units," which inherently cannot exceed the
cash leg. So this may be an accepted limitation of a USDC-denominated fee on an in-kind payout. It
is reported because it is a concrete gap between the §6/§7 commitment and what the code can enforce;
Sprint 3 should resolve it explicitly (e.g. force a minimum cash conversion to cover the fee, or
accrue an on-chain fee debt against the member's remaining shares) rather than leave it implicit.

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
- **SafeTransferLib `safeTransfer`/`safeTransferFrom`.** Correctly handle missing-return-value
  (USDT-style) tokens for the USDC legs. (`tryTransfer` is **not** sound — see H-2; the
  return-bomb/short-returndata pattern noted there also applies to these two, lower-exposure
  because they only see USDC today.)

---

## Summary table

| # | Sev | Path | Consequence |
| --- | --- | --- | --- |
| H-1 | H | `VaultCore.sol:308,324,387,392,395-396` | Any reverting creator-chosen `governance`/`feeEngine`/`operatorRegistry` permanently bricks all exits; no upgrade path ⇒ permanent lockup. New consequence beyond K-4 (oracle-only) and PX-3 (metadata scams). |
| H-2 | H | `SafeTransferLib.sol:24-27` via `VaultCore.sol:377` | A basket token returning 1–31 bytes or a returndata bomb reverts `tryTransfer` and the whole `_settleExit`, so one bad asset bricks all exits — falsifying EE-6's Mitigated(S1) H claim. Reachable via upgradeable-proxy basket tokens. |
| M-1 | M | `VaultCore.sol:303-316` vs settlement gate at `336-341` | A queued Mode-F exit that was gate-compliant at request time is stranded permanently by third-party deposits; escape forces the creator to inject capital and re-max their exit fee. Voting weight zeroed with no cancel path. New consequence vs CM-2. |
| M-2 | M | `VaultCore.sol:389-391` | Performance fee clamped to the USDC cash leg; in-kind-heavy exits (the normal state of an invested vault) dodge most of the §6/§7 "10% of realized profit" commitment. Medium confidence — may be an intended bound Sprint 3 must resolve. |
