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
> The pattern is now anchored — see "Running it" below for the exact form, confirmed against a
> real CI run rather than chosen by inspection (`^lib/` had to match Foundry's `contracts/lib/`
> while sparing `src/lib/`, and that is what it does: **zero** forge-std results leaked in).
>
> **Outcome of the widened run: 245 → 254 results, and _no new detector class_.** All nine
> additional results are further instances of classes already dispositioned below — nothing above
> informational was hiding in `src/lib/`. The affected rows are updated to name the instances:
> `assembly` (+3), `low-level-calls` (+3), `incorrect-equality` (+1), `timestamp` (+1),
> `too-many-digits` (+1). Rows dated before Sprint 10 that mention `src/lib/` reflected **human**
> review rather than analyser output; that is now true of the analyser too.

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
| `incorrect-equality` | **Safe.** All flagged `==` are on share counts / status enums / `totalShares == 0` first-deposit and sole-holder checks — exact-value comparisons, not balance-of equality that a donation could grief (NAV never reads `balanceOf`, EE-1). **+1 in Sprint 10** (newly visible, `src/lib/Checkpoints.sol#23`): `h.arr[len-1].ts == uint64(block.timestamp)` in `push`. The strict equality is the point of the line — it detects "a checkpoint already exists for this exact second" and overwrites it instead of appending a duplicate (the standard OZ `Checkpoints` idiom). A range or `>=` comparison here would corrupt history, not harden it. |
| `uninitialized-local` | **Safe.** `k`, `perfFee`, `childValTotalWad` are accumulators intentionally relying on Solidity's zero-default before being summed. |
| `timestamp` | **Accepted (K-4 / by design).** The protocol uses `block.timestamp` as its only clock (commitment C-2, no block numbers). Governance windows and oracle staleness are minutes-to-days scale, far outside miner timestamp tolerance (~±15s). **+1 in Sprint 10** (newly visible): `Checkpoints.push` — same clock commitment, and the comparison is the same-second overwrite described in the `incorrect-equality` row. |
| `calls-loop`, `costly-loop`, `cache-array-length`, `cyclomatic-complexity` | **Accepted.** Loops over the basket (capped at 10, Finding 8) and children (capped at 8, depth 3) are bounded; `navWad` worst-case is ~237k gas (`NavGas.t.sol`). Gas is snapshotted in CI. |
| `low-level-calls` | **By design.** `AggregationRouterAdapter.executeSwap` — the pinned-router call behind the selector allowlist + measured-delta minOut (EX-3). **+3 in Sprint 10** (newly visible): `SafeTransferLib.safeTransfer` / `safeTransferFrom` / `safeApprove`, each a `token.call(abi.encodeWithSelector(...))`. The low-level form is the whole point — it tolerates non-standard ERC-20s that return nothing or malformed data instead of reverting on them (H-2), which a high-level call cannot do. Every one checks `ok` and validates the return payload. Reviewed in SPRINT1; before Sprint 10 the analyser had never actually seen them (banner above), and now that it has, it reports exactly these three by-design sites and nothing more. |
| `missing-inheritance` | **Cosmetic.** Interface-shaped contracts that don't formally `is` the interface; ABIs match. Sprint 7 added one instance: `VaultDeployer` vs `IVaultDeployer` (declared inside `VaultFactory.sol`). Same disposition — the single `deploy(bytes) returns (address)` selector matches, and `Eip170::test_factoryPinsItsDeployerImmutably` plus every factory-path test exercise the call across the interface. |
| `assembly` | **By design.** Six sites. **Three newly visible in Sprint 10** and predating it by far — `BoundedCall.boundedCall`, `BoundedCall.boundedStaticCall` (gas-bounded, returndata-capped module calls, the H-1 fix) and `SafeTransferLib.tryTransfer` (non-reverting transfer, the H-2 fix); all three were reviewed by hand in SPRINT1-SECURITY-REVIEW, which is where those fixes were designed. **Three from Sprint 7**, all in `VaultDeployer`: the SSTORE2 `_writeChunk` header, the `CREATE` in `deploy`, and `_readChunk`'s `extcodecopy`. This contract exists *because* the work cannot be expressed in Solidity — `type(VaultCore).creationCode` has to be relocated out of the factory's runtime (#10). All three blocks were reviewed opcode by opcode in [SPRINT10-DEPLOYMENT-REVIEW §3.5](SPRINT10-DEPLOYMENT-REVIEW.md), including the `memory-safe` annotations and the revert-path memory clobber. |
| `too-many-digits` | **False positive.** **+1 newly visible in Sprint 10:** `SafeTransferLib.tryTransfer#40` — the left-aligned `0xa9059cbb00…00` ERC-20 `transfer` selector written into assembly memory. That is a 4-byte selector padded to a word, not a magic number. The Sprint-7 instance fires on `code = type(VaultCore).creationCode` in `VaultDeployer`'s constructor — Slither renders the ~24.7 KB blob as a numeric literal and objects to its length. It is not a literal anyone typed; it is the compiler-embedded creation code, and its correctness is asserted byte-for-byte by `Eip170::test_deployerCreationCodeIsTheCompiledVaultCore`. |

## Running it

```bash
cd contracts
slither . --filter-paths "^lib/|^test/|^script/"
```

**Anchor the patterns.** Dropping the `^` re-introduces the Sprint-10 F-3 blind spot over
`src/lib/` — `SafeTransferLib`, `BoundedCall` and `Checkpoints` vanish from the output. Confirmed
working in CI run
[32405635945](https://github.com/SlumperSan/agent-governed-vaults/actions/runs/32405635945):
254 results, `src/lib/` present, no `lib/forge-std/` noise.

CI runs this as an advisory (`continue-on-error: true`, non-blocking) step, so a new
high-severity finding here does **not** turn CI red. This document is the triage of record.
