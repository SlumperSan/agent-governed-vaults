# Slither Triage

Static analysis with Slither (version as pinned by `crytic/slither-action@v0.4.0`;
this document was originally written against 0.11.6). Every detector that fired is dispositioned
below — fixed, or accepted with the reason. Auditors and CI run the same command; this is the
reference for what is signal vs. noise.

> **Read this first — the filter was wrong until Sprint 10.** The command was
> `--filter-paths "lib|test|script"`, an **unanchored** regex. It matched `src/lib/` as well as
> Foundry's `contracts/lib/`, so **`SafeTransferLib`, `BoundedCall` and `Checkpoints` were
> excluded from every Slither run this project produced** up to the Sprint-10 freeze
> ([SPRINT10-DEPLOYMENT-REVIEW §F-3](SPRINT10-DEPLOYMENT-REVIEW.md)). Two detectors confirm it
> independently in the CI logs: `assembly` fired **zero** times on `protocol/main` despite
> `SafeTransferLib`'s assembly `tryTransfer`, and `low-level-calls` fired on
> `AggregationRouterAdapter` **only** while `BoundedCall` is built entirely on low-level calls.
> The pattern is now anchored (`"^lib/|^test/|^script/"`). Any row below dated before Sprint 10
> that mentions `src/lib/` reflects **human** review, not analyser output — the `low-level-calls`
> row is re-labelled accordingly.

## Fixed

| Detector | Where | Fix |
| --- | --- | --- |
| `missing-zero-check` | `OperatorRegistry.wire`, `SubVaultRegistry.wire`, `Governance.wireSubVaultRegistry` | Added `ZeroAddress`/`ZeroSubRegistry` guards — a fat-finger deploy can no longer wire the trust anchor to `address(0)`. (VaultCore/VaultFactory `subVaultRegistry == 0` is a VALID config — root-only vaults — so those are intentionally *not* guarded.) |
| `unindexed-event-address` | `OperatorRegistry.FactorySet/FeeEngineSet` | Made the address params `indexed` for off-chain filtering. |
| `redundant-statements` | `FeeEngine.onRealize` | Removed the `lossUsdc;` no-op; the param is now unnamed (`uint256 /*lossUsdc*/`). |

## Accepted (false positive or by-design — verified against the code and prior reviews)

| Detector | Disposition |
| --- | --- |
| `reentrancy-balance`, `reentrancy-no-eth`, `reentrancy-events`, `reentrancy-benign` | **False positive.** Every flagged function (`deposit`, `executeRebalance`, `_settleExit`, child flows) carries the `nonReentrant` mutex (shared lock, `_lock`), which Slither does not model. CEI + the single lock were proven sound in SPRINT1-SECURITY-REVIEW §"Reentrancy / CEI" and re-verified in the SPRINT6 execution review. The H-1 fix additionally makes every external module call on the exit path gas-bounded and non-blocking. **Sprint 10 correction:** `VaultFactory.createVault` / `createChildVault` are also flagged (a hostile settlement or basket token can reenter from `decimals()` during `VaultCore`'s constructor) and they carry **no** mutex — so the mutex reasoning above does not cover them. They are still benign, for a different reason: the factory's only state is the append-only `allVaults`, so nesting interleaves push order and nothing else; `VaultCreated` is emitted innermost-first and the indexer sorts by `(block, logIndex)`, matching emission order; and a nested attempt to register the still-constructing outer vault as a sub-vault parent fails, because `registerChild` calls `IVaultFees(parent).exitFeeMaxBps()` on a contract that has no code yet. Pre-existing — `new VaultCore(...)` made the same constructor calls — but Sprint 7's extra hop puts these rows in the output more prominently, so the reasoning is recorded rather than assumed. |
| `divide-before-multiply` | **By design.** The `a * b / ts * c / BPS` pattern in `_settleExit` (payout slices, `cashTargetWad`, `feeFracWad`) loses precision **downward on purpose** — every rounding favors the vault/remaining members and understates the exiter's gain (lower fee). This is exactly the algebraic condition for the §4.6 NAVps-non-decreasing invariant, proven in SPRINT1 §4.6 and fuzzed in the invariant suites. "Fixing" the order could break the invariant. |
| `unused-return` | **By design.** (a) The `boundedCall` results are intentionally best-effort (H-1): the `ok` flag is checked where liveness needs it and the rest ignored — a failing bookkeeping module must not block an exit. (b) `IExecutionAdapter.executeSwap`'s return is ignored because output is measured from the vault's OWN balance delta (EX-3), never the adapter's word. (c) `getReserves`/`latestRoundData` ignore fields the caller doesn't need (timestamp / round metadata). |
| `incorrect-equality` | **Safe.** All flagged `==` are on share counts / status enums / `totalShares == 0` first-deposit and sole-holder checks — exact-value comparisons, not balance-of equality that a donation could grief (NAV never reads `balanceOf`, EE-1). |
| `uninitialized-local` | **Safe.** `k`, `perfFee`, `childValTotalWad` are accumulators intentionally relying on Solidity's zero-default before being summed. |
| `timestamp` | **Accepted (K-4 / by design).** The protocol uses `block.timestamp` as its only clock (commitment C-2, no block numbers). Governance windows and oracle staleness are minutes-to-days scale, far outside miner timestamp tolerance (~±15s). |
| `calls-loop`, `costly-loop`, `cache-array-length`, `cyclomatic-complexity` | **Accepted.** Loops over the basket (capped at 10, Finding 8) and children (capped at 8, depth 3) are bounded; `navWad` worst-case is ~237k gas (`NavGas.t.sol`). Gas is snapshotted in CI. |
| `low-level-calls` | **By design.** Fired on `AggregationRouterAdapter.executeSwap` — the pinned-router call behind the selector allowlist + measured-delta minOut (EX-3). `BoundedCall` and `SafeTransferLib` also use assembly/low-level calls deliberately (gas-bounding, returndata-bomb defense — the H-1/H-2 fixes), reviewed in SPRINT1; **note that the analyser did not actually flag them before Sprint 10** — see the banner above. |
| `missing-inheritance` | **Cosmetic.** Interface-shaped contracts that don't formally `is` the interface; ABIs match. Sprint 7 added one instance: `VaultDeployer` vs `IVaultDeployer` (declared inside `VaultFactory.sol`). Same disposition — the single `deploy(bytes) returns (address)` selector matches, and `Eip170::test_factoryPinsItsDeployerImmutably` plus every factory-path test exercise the call across the interface. |
| `assembly` | **By design (new in Sprint 7).** Three sites, all in `VaultDeployer`: the SSTORE2 `_writeChunk` header, the `CREATE` in `deploy`, and `_readChunk`'s `extcodecopy`. This contract exists *because* the work cannot be expressed in Solidity — `type(VaultCore).creationCode` has to be relocated out of the factory's runtime (#10). All three blocks were reviewed opcode by opcode in [SPRINT10-DEPLOYMENT-REVIEW §3.5](SPRINT10-DEPLOYMENT-REVIEW.md), including the `memory-safe` annotations and the revert-path memory clobber. |
| `too-many-digits` | **False positive (new in Sprint 7).** Fires on `code = type(VaultCore).creationCode` in `VaultDeployer`'s constructor — Slither renders the ~24.7 KB blob as a numeric literal and objects to its length. It is not a literal anyone typed; it is the compiler-embedded creation code, and its correctness is asserted byte-for-byte by `Eip170::test_deployerCreationCodeIsTheCompiledVaultCore`. |

## Running it

```bash
cd contracts
slither . --filter-paths "^lib/|^test/|^script/"
```

Anchor the patterns. Dropping the `^` re-introduces the Sprint-10 F-3 blind spot over `src/lib/`.

CI runs this as an advisory (`continue-on-error: true`, non-blocking) step, so a new
high-severity finding here does **not** turn CI red. This document is the triage of record.
