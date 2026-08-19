# Walkthrough — VaultCore.sol

**Risk: Critical (holds all funds).** ~850 LoC. `contracts/src/VaultCore.sol`.

## Purpose

The vault itself: share accounting, NAV, deposits with a 4-hour observation window, two-mode
redemption settlement, in-kind payout with per-asset escrow isolation, tenure-decaying exit
fee, creator 5% withdrawal gate, capacity cap, governance-driven rebalance execution,
sub-vault allocation/redemption with recursive look-through pricing, and the voting-stake
checkpoints Governance reads. Everything else in the system exists to authorize, price, or
account for what this contract does.

Not ERC-4626 (C-1): in-kind redemption and forward pricing break preview round-trips. The
4626-shaped views (`totalAssets`, `convertToShares`, `convertToAssets`) are indicative only.

## Construction and immutables

Everything trust-relevant is fixed at the constructor and visible before anyone deposits:
`usdc` (+ `usdcScalar` from a runtime decimals read, ≤18 enforced), `creator`, the four module
references (`operatorRegistry`, `governance`, `feeEngine`, `oracle`), `capacityCapUsdc`
(0 = uncapped, SF-3 is opt-in), `minDepositUsdc` (>0), `exitFeeMaxBps` (≤100 = 1% protocol
cap), `exitFeeDecayPeriod`, the adapter allowlist (EX-1), the basket (≤ `MAX_BASKET_ASSETS`
= 10, no zero/duplicate/USDC entries, per-asset decimals ≤18), and `subVaultRegistry`
(0 disables child flows). There are no setters for any of these.

## State (grouped)

| Group | Variables | Notes |
| --- | --- | --- |
| Accounting | `idleUsdc`, `assetBalance[asset]`, `basketAssets`, `assetUnit[asset]` | **Internal accounting only — NAV never reads `balanceOf`** (EE-1 donation defense). `assetUnit != 0 ⇔ in basket` |
| Shares | `totalShares`, `sharesOf`, `costBasisUsdc`, `lastDepositTime`, `nonCreatorMemberCount`, `holderCount` | WAD-scaled shares; cost basis feeds realized-P&L; `lastDepositTime` is the tenure clock (resets on every deposit) |
| Observation window | `pendingDeposit[member]`, `totalPendingUsdc`, `windowCleared`, `skipOptIn` | Pending capital is escrowed: excluded from NAV **and** `idleUsdc`, zero shares, zero voting rights |
| Mode-F queue | `queuedExitShares[member]`, `totalQueuedShares` | Queued shares stay outstanding (earn/lose with the vault) but are locked: non-votable, irrevocable |
| Snapshots | `_eligibleHist`, `_totalEligibleHist`, `_holderCountHist` (Checkpoints) | Written by `_snapshot` after **every** share/queue mutation; Governance reads them at `createdAt − 1` (VO-9) |
| Sub-vaults | `childVaults` (≤ `MAX_CHILDREN` = 8), `isChildVault`, `_cachedParentVault` | Children added only on first governance allocation along a registry edge |
| Escrow | `claimable[member][asset]` | EE-6: failed in-kind transfers park here; `claimEscrowed` pays out later |
| Reentrancy | `_lock` | Single mutex shared by every state-mutating external function |

## External entry points

**Member / permissionless:**

| Function | Guard | What it does |
| --- | --- | --- |
| `deposit(amount)` | nonReentrant | First-ever deposit → pending escrow (4h window); repeat/window-cleared → immediate mint at current NAV. Receipt measured by balance delta, capacity checked against NAV + pending + amount |
| `activate(member)` | nonReentrant, anyone | Mints a matured pending deposit at **activation-time** NAV (forward pricing on entry) |
| `cancelPending()` | nonReentrant | Refunds an un-activated pending deposit. **Reads no oracle** — always works during a breaker freeze |
| `skipWindow()` | nonReentrant | Irrevocable per-agent opt-out of the window; activates any pending immediately |
| `requestExit(shares)` | nonReentrant | Mode I (no pending execution): settles instantly. Mode F: checks creator gate, queues, de-eligibles the shares |
| `settleQueuedExit(member)` | nonReentrant, anyone | Settles a queued exit once no execution is pending, at then-current NAV |
| `claimEscrowed(asset)` | nonReentrant | Pays out an EE-6-escrowed slice |
| `pullChildEscrow(child, asset)` | nonReentrant, anyone | Crank: claims a slice a child escrowed for this vault and credits internal accounting |

**Governance-only** (`msg.sender == address(governance)`):

| Function | What it does |
| --- | --- |
| `executeRebalance(adapter, orders)` | Allowlisted adapter; per-leg: debit input accounting → approve → swap → measure output delta ≥ minOut → revoke approval → credit output → refund unspent input from **this swap's own delta** (S6 E3 fix) |
| `allocateToChild(child, amount)` | Only along registered registry edges (SV-3); first allocation registers the child locally and calls `child.skipWindow()` |
| `redeemFromChild(child, shares)` | Redeems child shares, credits measured deltas to internal accounting; reverts `ChildSettlementPending` if the child queues (Mode F) |

**Views** worth knowing: `navWad`, `navPerShareWad`, `parentVault`,
`votingEligibleShares` / `totalVotingEligibleShares` (+ `past*` checkpoint reads,
`pastHolderCount`), `exitFeeBpsOf`, `isCapped`, and the indicative 4626-shaped trio.

## Invariants (all fuzz/invariant-tested — see TEST-CROSS-REFERENCE)

1. **Share conservation:** Σ `sharesOf` == `totalShares` (single-vault and system-level).
2. **§4.6 NAVps non-decreasing for remaining members across any redemption.** Every payout
   component rounds *down* with `keepBps ≤ BPS`, so the exiter never takes more than exact
   pro-rata; the fee fraction stays in the vault. Proven with and without children.
3. **Solvency:** physical USDC ≥ `idleUsdc` + `totalPendingUsdc`, under adversarial donation.
4. **Queue consistency:** Σ `queuedExitShares` == `totalQueuedShares`; eligible = supply −
   queued (− parent position).
5. **Pending escrow excluded from NAV**; a pending deposit and live shares never coexist
   (`shares > 0 ⇒ windowCleared`).
6. **Creator floor:** while non-creator members remain, creator redemptions cannot take the
   creator below 5% of post-burn supply.
7. **Rounding is always against the actor:** mint rounds shares down, payouts round down, the
   fee fraction rounds down in the member's favor only where under-collection is the safe
   direction (dust accrues to the vault).

## The trickiest paths (where to spend review time)

### 1. `_settleExit` — two-mode exit / forward pricing (C-4, VO-8 × K-1)

Shares burn at settlement, never at request. Mode selection is `_pendingExecution()`: a
**bounded, non-reverting** staticcall to `governance.hasPendingExecution` — on any failure the
fallback is Mode I (a broken governance forfeits forward pricing, never member liveness; H-1).
`hasPendingExecution` turns true at *reveal start* (outcome starts leaking on-chain), false on
Defeated/Executed/expiry, so queued exits always settle eventually (EE-10).

`_settleExit` structure (CEI: two passes):

- **Pass 1 — internal accounting only.** Exit fee bps (tenure decay; waived for sole holder);
  cash target = exiter's share of (idle + total child value) × keepBps; `usdcPay` capped at
  idle; shortfall computed. Shares burned, member counts updated, `_snapshot`, cost basis
  removed pro-rata (rounds down, residual stays with member), per-asset slices deducted from
  `assetBalance` **before** any external call.
- **SV-5 shortfall loop.** Children unwound by value only for the cash shortfall: skip a child
  mid-rebalance (`_childPendingExecution`, S6 E4 — calling in would queue Mode-F and revert
  deep); redeem measured (`credit=false`); decrement shortfall by what **actually arrived**,
  never the intended take (S6 E5 — child escrow must not silently underpay the exiter). If the
  shortfall survives the loop beyond dust: revert `ExitNeedsChildSettlement` (clean rollback,
  bounded retry — the E4/E5 accepted residuals live here).
- **Realized P&L.** `gain/loss = payoutValue − basisRemoved`; `feeEngine.onRealize` and
  `registry.recordRealization` are bounded + non-blocking (failures event-logged); the fee is
  **clamped to 10% of gain** regardless of what the module returns (hostile-module value bound).
- **Pass 2 — transfers.** The fee is withheld *uniformly* across cash and in-kind legs via
  `feeFracWad` (M-2 fix). Every in-kind transfer is assembly `tryTransfer` (gas-capped,
  returndata-bounded, H-2): failure → `claimable` escrow, never a revert. Fee slices that fail
  to reach the FeeEngine escrow to the FeeEngine's own claimable entry.

Review pressure points: rounding direction at each `* burnShares / ts * keepBps / BPS` step
(the `divide-before-multiply` Slither hits are deliberate — see SLITHER-TRIAGE); whether any
path lets `payoutValueWad` exceed exact pro-rata; the interplay when a queued exit settles
after supply changed (gate deliberately NOT re-checked, M-1/MO-3).

### 2. Recursive look-through pricing — `navWad` / `_childValueWad` / `_fullNavWad` (SV-7, S6 E1)

A child position is valued as `fullNav(child) × myShares / child.totalShares`, where
`_fullNavWad` recurses into the child's own children, **depth-bounded by
`MAX_LOOKTHROUGH_DEPTH = 3`** (the registry caps real nesting at 3; the bound here is the
backstop). Every level is priced from *internal* accounting through **this vault's own
oracle** — never child-reported NAVps, never the child's oracle. Child baskets are
factory-enforced subsets of the parent's, so every descendant asset resolves in the parent's
`assetUnit`/oracle; an unpriceable asset fails safe via `StaleOracle`. Gas is bounded:
basket ≤ 10, children ≤ 8, depth ≤ 3, empirically ~237k worst-case (`NavGas.t.sol`).

Review pressure points: can a descendant *misprice* (not just DoS) an ancestor — e.g. via
`totalShares` manipulation in a child (fair-mint preserves the ratio; dust attacks were
examined and judged sound in the S6 review) — and whether depth-bound truncation at level 3
can ever hide real value (registry prevents deeper nesting from existing).

### 3. Creator gate × Mode-F queue (CM-1/CM-2, M-1/MO-3)

The 5% gate is evaluated on creator *action*: at instant settlement, and at **queue time** for
Mode-F requests. It is deliberately not re-checked when a queued exit settles — re-checking
would let third-party deposits permanently strand a once-valid queued exit (the original M-1).
New joiners had on-chain notice of the queue. Passive dilution below 5% only freezes future
creator withdrawals (CM-2), it is never a solvency condition.

### 4. Snapshots — `_snapshot` and the parent-vault exclusion (VO-9, GA-1)

After every mutation of `sharesOf`/`queuedExitShares`/`holderCount`, `_snapshot` pushes:
member eligible (0 for the parent vault), total eligible (minus queued minus parent), and
holder count (minus parent). The parent vault is a contract with no vote path; counting it
would make child full-consensus RuleChange unreachable and distort quorums (GA-1 fix). The
parent edge is one-shot, so it is lazily cached (`_cachedParentVault`). Shares are
non-transferable, so no mutation path can bypass `_snapshot` (exhaustively verified in the
accepted-rows review, Area 4).

## Accepted risks that live in this contract (do not re-report)

- **K-4/SF-2:** oracle breaker freezes deposits *and* exits. Softening: `cancelPending` reads
  no oracle, so window capital is never trapped.
- **E4/E5 residuals:** `ExitNeedsChildSettlement` when the only covering child is
  mid-rebalance (bounded retry) or persistently escrows to the parent (permanent for that
  configuration — known EE-6 asymmetry for child-held slices).
- **E7/EE-5:** repeat-deposit latency arb against stale-but-fresh-enough NAV; threshold is gas
  within the oracle drift band.
- **EE-8/EE-9:** last-two-members fee endgame; operator-as-member receives fee pro-rata via
  shares (routing prohibition is on routing, not identity).
- **PX-1:** USDC blacklist of the vault freezes the USDC leg.
- **CM-2:** passive creator dilution freezes creator withdrawals until restored.
