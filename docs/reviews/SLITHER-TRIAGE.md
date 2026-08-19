# Slither Triage

Static analysis with Slither 0.11.6 (`slither . --filter-paths "lib|test|script"`). Every
detector that fired is dispositioned below — fixed, or accepted with the reason. Auditors and CI
run the same command; this is the reference for what is signal vs. noise.

## Fixed

| Detector | Where | Fix |
| --- | --- | --- |
| `missing-zero-check` | `OperatorRegistry.wire`, `SubVaultRegistry.wire`, `Governance.wireSubVaultRegistry` | Added `ZeroAddress`/`ZeroSubRegistry` guards — a fat-finger deploy can no longer wire the trust anchor to `address(0)`. (VaultCore/VaultFactory `subVaultRegistry == 0` is a VALID config — root-only vaults — so those are intentionally *not* guarded.) |
| `unindexed-event-address` | `OperatorRegistry.FactorySet/FeeEngineSet` | Made the address params `indexed` for off-chain filtering. |
| `redundant-statements` | `FeeEngine.onRealize` | Removed the `lossUsdc;` no-op; the param is now unnamed (`uint256 /*lossUsdc*/`). |

## Accepted (false positive or by-design — verified against the code and prior reviews)

| Detector | Disposition |
| --- | --- |
| `reentrancy-balance`, `reentrancy-no-eth`, `reentrancy-events`, `reentrancy-benign` | **False positive.** Every flagged function (`deposit`, `executeRebalance`, `_settleExit`, child flows) carries the `nonReentrant` mutex (shared lock, `_lock`), which Slither does not model. CEI + the single lock were proven sound in SPRINT1-SECURITY-REVIEW §"Reentrancy / CEI" and re-verified in the SPRINT6 execution review. The H-1 fix additionally makes every external module call on the exit path gas-bounded and non-blocking. |
| `divide-before-multiply` | **By design.** The `a * b / ts * c / BPS` pattern in `_settleExit` (payout slices, `cashTargetWad`, `feeFracWad`) loses precision **downward on purpose** — every rounding favors the vault/remaining members and understates the exiter's gain (lower fee). This is exactly the algebraic condition for the §4.6 NAVps-non-decreasing invariant, proven in SPRINT1 §4.6 and fuzzed in the invariant suites. "Fixing" the order could break the invariant. |
| `unused-return` | **By design.** (a) The `boundedCall` results are intentionally best-effort (H-1): the `ok` flag is checked where liveness needs it and the rest ignored — a failing bookkeeping module must not block an exit. (b) `IExecutionAdapter.executeSwap`'s return is ignored because output is measured from the vault's OWN balance delta (EX-3), never the adapter's word. (c) `getReserves`/`latestRoundData` ignore fields the caller doesn't need (timestamp / round metadata). |
| `incorrect-equality` | **Safe.** All flagged `==` are on share counts / status enums / `totalShares == 0` first-deposit and sole-holder checks — exact-value comparisons, not balance-of equality that a donation could grief (NAV never reads `balanceOf`, EE-1). |
| `uninitialized-local` | **Safe.** `k`, `perfFee`, `childValTotalWad` are accumulators intentionally relying on Solidity's zero-default before being summed. |
| `timestamp` | **Accepted (K-4 / by design).** The protocol uses `block.timestamp` as its only clock (commitment C-2, no block numbers). Governance windows and oracle staleness are minutes-to-days scale, far outside miner timestamp tolerance (~±15s). |
| `calls-loop`, `costly-loop`, `cache-array-length`, `cyclomatic-complexity` | **Accepted.** Loops over the basket (capped at 10, Finding 8) and children (capped at 8, depth 3) are bounded; `navWad` worst-case is ~237k gas (`NavGas.t.sol`). Gas is snapshotted in CI. |
| `low-level-calls` | **By design.** `BoundedCall` and `SafeTransferLib` use assembly/low-level calls deliberately (gas-bounding, returndata-bomb defense — the H-1/H-2 fixes). |
| `missing-inheritance` | **Cosmetic.** Interface-shaped contracts that don't formally `is` the interface; ABIs match. |

## Running it

```bash
cd contracts
slither . --filter-paths "lib|test|script"
```

CI runs this as an advisory (non-blocking) step; this document is the triage of record.
