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
| `missing-zero-check` | `OperatorRegistry.wire`, `SubVaultRegistry.wire`, `Governance.wireSubVaultRegistry` | Added `ZeroAddress`/`ZeroSubRegistry` guards — a fat-finger deploy can no longer wire the trust anchor to `address(0)`. (VaultCore/VaultFactory `subVaultRegistry == 0` is a VALID config — root-only vaults, now the launch default per C-1 — so those are intentionally *not* guarded.) **AI-audit note (§4.5):** benign scope gap — `VaultCore`'s constructor also zero-checks none of `operatorRegistry_`, `governance_`, `feeEngine_`, `oracle_`. Specific silent failure to record: a zero `governance` makes `boundedStaticCall` succeed with `retSize == 0`, so `_pendingExecution` returns `false` permanently and the H-1 fallback silently masks a mis-wired vault as "always Mode I". The canonical factory always wires real modules, so this bites only a hand-rolled deployment; recorded, not a code change. |
| `unindexed-event-address` | `OperatorRegistry.FactorySet/FeeEngineSet` | Made the address params `indexed` for off-chain filtering. |
| `redundant-statements` | `FeeEngine.onRealize` | Removed the `lossUsdc;` no-op; the param is now unnamed (`uint256 /*lossUsdc*/`). |

## Accepted (false positive or by-design — verified against the code and prior reviews)

| Detector | Disposition |
| --- | --- |
| `reentrancy-balance` (High ×8) | **Triaged row by row on 2026-09-01 — see "reentrancy-balance, eight rows, four sites" below.** The blanket "false positive" in the row beneath is what this replaces: it was right about same-contract reentrancy and wrong to stop there. One row is a real, reproduced defect (`AggregationRouterAdapter`, 600e6 USDC extracted in test); four are the cross-contract read-only window already registered as **H-9**, unfixed on `protocol/main`. |
| `reentrancy-no-eth`, `reentrancy-events`, `reentrancy-benign` | **False positive, but NOT for one reason — check the site before reusing this row.** The `VaultCore` functions flagged (`deposit`, `executeRebalance`, `_settleExit`, child flows) carry the `nonReentrant` mutex (shared lock, `_lock`), which Slither does not model. **This row has twice been read as "everything flagged carries the mutex", and twice that was false** — see the Sprint 10 and Sprint 14 corrections below. `FeeEngine.onFeeCollected` has no mutex, and **`Governance` has none anywhere**; both are benign by CEI, which is a different argument that has to be made separately. A blanket dismissal is how a real finding gets filed as noise. CEI + the single lock were proven sound in SPRINT1-SECURITY-REVIEW §"Reentrancy / CEI" and re-verified in the SPRINT6 execution review. The H-1 fix additionally makes every external module call on the exit path gas-bounded and non-blocking. **Sprint 10 correction:** `VaultFactory.createVault` / `createChildVault` are also flagged (a hostile settlement or basket token can reenter from `decimals()` during `VaultCore`'s constructor) and they carry **no** mutex — so the mutex reasoning above does not cover them. They are still benign, for a different reason: the factory's only state is the append-only `allVaults`, so nesting interleaves push order and nothing else; `VaultCreated` is emitted innermost-first and the indexer sorts by `(block, logIndex)`, matching emission order; and a nested attempt to register the still-constructing outer vault as a sub-vault parent fails, because `registerChild` calls `IVaultFees(parent).exitFeeMaxBps()` on a contract that has no code yet. Pre-existing — `new VaultCore(...)` made the same constructor calls — but Sprint 7's extra hop puts these rows in the output more prominently, so the reasoning is recorded rather than assumed. **AI-audit correction (§4.5):** the mutex reasoning is sound for SAME-contract reentrancy but does not cover **cross-contract read-only reentrancy** — a `VaultCore`'s public views are read as an oracle by its PARENT while the child is mid-mutation, and a per-contract mutex is definitionally not a defence against a different contract reading it (**H-9**). Slither does not model this either, so the row's blind spot and the analyser's coincide. H-9 requires a parent/child pair and is therefore **dormant at launch** (root vaults only, C-1 gate), deferred with the sub-vault feature. |
| `divide-before-multiply` | **By design for the payout legs.** The `a * b / ts * c / BPS` pattern in `_settleExit` loses precision **downward on purpose** — rounding favors the vault/remaining members, the algebraic condition for the §4.6 NAVps-non-decreasing invariant (SPRINT1 §4.6, fuzzed). **AI-audit correction (§4.5):** "rounds in the vault's favour" is not the same as "safe" — the same pattern at `:557` is what makes `:576`'s shortfall dust check unsatisfiable and reverts a member's child-backed exit (**H-6**). H-6 is a sub-vault-only path and is **dormant at launch** (root vaults only, C-1 gate; sub-vaults disabled), deferred with the sub-vault feature. Not a disposition change for the payout-leg rounding, but the "safe" generalization was too broad. |
| `unused-return` | **By design.** (a) The `boundedCall` results are intentionally best-effort (H-1): the `ok` flag is checked where liveness needs it and the rest ignored — a failing bookkeeping module must not block an exit. (b) `IExecutionAdapter.executeSwap`'s return is ignored because output is measured from the vault's OWN balance delta (EX-3), never the adapter's word. (c) `getReserves`/`latestRoundData` ignore fields the caller doesn't need (timestamp / round metadata). |
| `incorrect-equality` | **Safe.** All flagged `==` are on share counts / status enums / `totalShares == 0` first-deposit and sole-holder checks — exact-value comparisons, not balance-of equality that a donation could grief (NAV never reads `balanceOf`, EE-1). **+1 in Sprint 10** (newly visible, `src/lib/Checkpoints.sol#23`): `h.arr[len-1].ts == uint64(block.timestamp)` in `push`. The strict equality is the point of the line — it detects "a checkpoint already exists for this exact second" and overwrites it instead of appending a duplicate (the standard OZ `Checkpoints` idiom). A range or `>=` comparison here would corrupt history, not harden it. |
| `uninitialized-local` | **Safe.** `k`, `perfFee`, `childValTotalWad` are accumulators intentionally relying on Solidity's zero-default before being summed. |
| `timestamp` (×30) | **Superseded — triaged row by row on 2026-09-01; see "[`timestamp`, thirty rows](#timestamp-thirty-rows-triaged-2026-09-01)" below.** The blanket K-4 acceptance beneath was right that the protocol uses `block.timestamp` as its only clock (C-2) and that governance windows sit far outside miner tolerance, and wrong to stop there: it never checked whether the two comparisons on either side of a deadline agree about the boundary second, and it never separated the rows that contain a `block.timestamp` comparison from the 13 that contain no `block.timestamp` at all. The per-row triage finds **1 REAL (Low), 16 by-design, 13 analyser taint**. Prior text, retained: **Accepted (K-4 / by design)** for `Governance` and `Checkpoints`. The protocol uses `block.timestamp` as its only clock (commitment C-2, no block numbers); governance/staleness windows are minutes-to-days, far outside miner tolerance (~±15s). **+1 in Sprint 10:** `Checkpoints.push` same-second overwrite. **AI-audit correction (§4.5):** this row predated Sprint 11 and omitted `UniswapV3TwapSource.sol:255`, the one timestamp use with a security consequence (**H-2**). H-2 has since been **FIXED** (the constructor now requires `maxObservationAge <= window/20`; regression `AuditTwapRealCostModel.t.sol`), so the omission is closed.
| `calls-loop`, `costly-loop`, `cache-array-length`, `cyclomatic-complexity` | **Accepted for the basket loop** (capped at 10). **AI-audit correction (§4.5):** the "~237k gas" bound was measured on a 1-child/1-grandchild fixture (6 `priceWad` calls); the caps actually permit ~730 calls at the `MAX_CHILDREN` fan-out, so `navWad` is bounded in *shape* but unbounded in *cost* (**M-5**, ~12M gas at 8×8 vaults). M-5's fan-out requires sub-vaults, which are **disabled at launch** (root vaults only, C-1 gate), so at launch `navWad` loops only over the basket (≤10) and the original bound holds; M-5 is deferred with the sub-vault feature. The `NavGas.t.sol` sub-vault assertion is a fixture bound, not a proof of the worst case. |
| `low-level-calls` | **By design.** `AggregationRouterAdapter.executeSwap` — the pinned-router call behind the selector allowlist + measured-delta minOut (EX-3). **+3 in Sprint 10** (newly visible): `SafeTransferLib.safeTransfer` / `safeTransferFrom` / `safeApprove`, each a `token.call(abi.encodeWithSelector(...))`. The low-level form is the whole point — it tolerates non-standard ERC-20s that return nothing or malformed data instead of reverting on them (H-2), which a high-level call cannot do. Every one checks `ok` and validates the return payload. Reviewed in SPRINT1; before Sprint 10 the analyser had never actually seen them (banner above), and now that it has, it reports exactly these three by-design sites and nothing more. |
| `missing-inheritance` | **Cosmetic.** Interface-shaped contracts that don't formally `is` the interface; ABIs match. Sprint 7 added one instance: `VaultDeployer` vs `IVaultDeployer` (declared inside `VaultFactory.sol`). Same disposition — the single `deploy(bytes) returns (address)` selector matches, and `Eip170::test_factoryPinsItsDeployerImmutably` plus every factory-path test exercise the call across the interface. |
| `assembly` | **By design.** Six sites. **Three newly visible in Sprint 10** and predating it by far — `BoundedCall.boundedCall`, `BoundedCall.boundedStaticCall` (gas-bounded, returndata-capped module calls, the H-1 fix) and `SafeTransferLib.tryTransfer` (non-reverting transfer, the H-2 fix); all three were reviewed by hand in SPRINT1-SECURITY-REVIEW, which is where those fixes were designed. **Three from Sprint 7**, all in `VaultDeployer`: the SSTORE2 `_writeChunk` header, the `CREATE` in `deploy`, and `_readChunk`'s `extcodecopy`. This contract exists *because* the work cannot be expressed in Solidity — `type(VaultCore).creationCode` has to be relocated out of the factory's runtime (#10). All three blocks were reviewed opcode by opcode in [SPRINT10-DEPLOYMENT-REVIEW §3.5](SPRINT10-DEPLOYMENT-REVIEW.md), including the `memory-safe` annotations and the revert-path memory clobber. |
| `too-many-digits` | **False positive.** **+1 newly visible in Sprint 10:** `SafeTransferLib.tryTransfer#40` — the left-aligned `0xa9059cbb00…00` ERC-20 `transfer` selector written into assembly memory. That is a 4-byte selector padded to a word, not a magic number. The Sprint-7 instance fires on `code = type(VaultCore).creationCode` in `VaultDeployer`'s constructor — Slither renders the ~24.7 KB blob as a numeric literal and objects to its length. It is not a literal anyone typed; it is the compiler-embedded creation code, and its correctness is asserted byte-for-byte by `Eip170::test_deployerCreationCodeIsTheCompiledVaultCore`. |

## `reentrancy-balance`, eight rows, four sites (triaged 2026-09-01)

Slither's `reentrancy-balance` is "reentrancy leading to outdated balance checks": a balance read
before an external call, feeding a condition after it. Every one of our eight rows is fired by the
**measured-delta** pattern (EX-3) — `before = balanceOf(x)` … external call … `require(balanceOf(x)
- before >= floor)`. Reading the balance *before* the call is not incidental to that pattern; it is
the pattern. So the detector cannot distinguish it from the bug it looks for, and each row has to be
argued on its own.

Eight rows are **four sites**. Two of the four carry a real problem, and neither is the one the
detector describes.

| Site | Rows | Verdict |
| --- | --- | --- |
| `VaultCore.executeRebalance` (`executeSwap` at :870) | 4 | **Not real as flagged; real in a dimension the detector does not model.** |
| `VaultCore._settleExit` → `_redeemChildMeasured(…, false)` (:635) | 1 | **Not real.** |
| `DirectPoolAdapter.executeSwap` (both `pair.swap` branches) | 2 | **Not real as an exploit; guarded anyway.** |
| `AggregationRouterAdapter.executeSwap` (`router.call`) | 1 | **REAL — fixed.** |

### `VaultCore.executeRebalance` — 4 rows, 1 site

Four rows because Slither pairs each of the four balance reads in the loop body (`outBefore`,
`inBefore`, `inAfter`, and the derived `received`) against the two post-call conditions.

**As flagged — not real.** The vault holds its own `nonReentrant` mutex (`_lock`, `VaultCore.sol`
:137-143) across the whole loop, so the adapter cannot re-enter any mutating entry point. The
`idleUsdc` two of the rows call "stale" is a *storage* read that is re-executed from storage on
every loop iteration; the staleness is an artefact of Slither following the loop back-edge. And
`received` is computed strictly after the call, so it is stale only in the sense that its
`outBefore` operand predates it — which measured-delta accounting requires.

**In the dimension the detector does not model — real, and already registered as H-9.** The debit
lands before the swap and the credit after, so the vault's *internal accounting* is genuinely
understated for the duration of the external call. A same-contract mutex is definitionally no
defence against a **different** `VaultCore` instance reading that state through unguarded views:
an ancestor's `_fullNavWad` walks `idleUsdc()` / `assetBalance()` on the descendant and feeds a
*mutating* path (share minting). That is [`AI-AUDIT-REPORT.md` H-9](../audit/AI-AUDIT-REPORT.md)
and it is **unfixed on `protocol/main`**. It is dormant at launch — `Deploy.s.sol` hardcodes
`allowSubVaults = false` (C-1, root vaults only), so `_fullNavWad` is unreachable on the launch
configuration — and the fix is written and in review as **PR #98** (a `locked()` view plus
`require(!v.locked(), Reentrancy())` in `_fullNavWad`, +170 B, with a reproduction that mints
2,000e18 shares for 1,000 USDC).

Deliberately **not** changed here: hoisting the debit, or reordering anything in
`executeRebalance`. The ordering is not the defect — the understatement window cannot be closed at
all, because the output amount is not knowable until the swap returns and taking the adapter's word
for it is exactly EX-3. Making the window *unobservable* is the only available fix, and #98 owns
that file.

### `VaultCore._settleExit` → `_redeemChildMeasured(child, cs, false)` — 1 row

**Not real.** `_settleExit` has exactly two call sites, `requestExit` (:520) and
`settleQueuedExit` (:551); both are `nonReentrant`. Every internal decrement — `sharesOf`,
`totalShares`, `costBasisUsdc`, `idleUsdc`, each basket `slice` — completes *before* the first
external call, so the flagged `shortfallWad` condition is evaluated against accounting that is
already final. The child proceeds are deliberately left un-credited (`credit = false`): they belong
to the exiter, not to the vault, so excluding them from NAV is correct rather than an
understatement. Worst case on this path is a clean revert (`ExitNeedsChildSettlement`). H-9 reaches
the same conclusion for this path independently. #98's guard covers it belt-and-braces, since the
vault is locked throughout.

### `DirectPoolAdapter.executeSwap` — 2 rows, 1 site

Two rows for the two `pair.swap` argument orders (`inIs0` true/false); one code path.

**Not real as an exploit.** The adapter transfers the full `amountIn` to the pair and moves only its
own measured `amountOut`, so no pre-existing balance is reachable and there is no sweep. Re-entry
can only *shrink* the outer call's measured delta, which fails closed on `Slippage()`. No value
extraction was constructed.

**Guarded anyway**, because non-reentrancy is a property of the `IExecutionAdapter` contract, not of
any one caller — see the next row for what the same shape costs when the adapter *does* sweep.
`test_directPoolAdapterRefusesNestedSwap` pins it.

### `AggregationRouterAdapter.executeSwap` — 1 row — REAL, fixed

The trailing "sweep unspent input back to the caller" returns `balanceOf(tokenIn)` — the adapter's
**whole** balance, including another order's in-flight input — to that call's `msg.sender`, and
`safeApprove(router, 0)` revokes the outer call's approval. Both were written assuming the adapter
only ever handles one order at a time; nothing enforced it.

**The attacker is not the router.** The router stays honest: pinned immutable (EX-2), selector
allowlisted (EX-1). The attacker is a **counterparty reached through the route** — the maker side of
a fill — which is precisely the position an aggregation router hands to arbitrary contracts. It
re-enters `executeSwap` with a 1-unit order; the nested call's sweep pays it the outer order's
unspent input.

Reproduced in `test/AdapterReentrancy.t.sol::test_nestedSwapCannotSweepTheOuterOrdersInput`: on a
1,000 USDC order that the route only partially fills, **600e6 USDC** goes to the counterparty
instead of back to the caller. Verified by mutation — remove `nonReentrant` and the test fails
`refund survives: 0 != 600000000`.

Loss to a `VaultCore` caller specifically is bounded, because `executeRebalance` still enforces
`received >= o.minAmountOut` and `MinOutTooLow` floors that at `MAX_REBALANCE_SLIPPAGE_BPS` (2%) of
order value — so the vault's exposure is "the attacker can force the full slippage budget to be
realised", not an open drain. It is **not** bounded for the published `IExecutionAdapter`
abstraction, which promises no such thing to any other integrator. Fixed with a `nonReentrant`
mutex of the same shape as `VaultCore._lock`.

**The `reentrancy-balance` count does not move.** Slither does not model the mutex for this
detector, so it still reports **8** after the fix. Expect that; it is not a failed fix. The total
went **227 → 225** on 2026-09-01: the two rows that cleared are `reentrancy-events` on the two
adapters, which Slither *does* suppress once a guard is present. Adapter runtime cost of the two
guards: `AggregationRouterAdapter` 1,806 → 1,839 B, `DirectPoolAdapter` 2,165 → 2,210 B.
`VaultCore` is untouched at 20,481 B (4,095 B of EIP-170 margin).

## `timestamp`, thirty rows (triaged 2026-09-01)

Slither's `timestamp` detector is "dangerous comparisons using `block.timestamp`". It fires per
FUNCTION and then lists every comparison in that function, so a row's "Dangerous comparisons" list
is not the same thing as a list of timestamp comparisons. The count above (`timestamp` ×30) is
reproduced exactly by `slither . --filter-paths "^lib/|^test/|^script/" --detect timestamp` at
`protocol/main` @ `29b1b470`.

**Thirteen of the thirty rows contain no `block.timestamp` at all.** That is not an assertion — it
was measured, by ablation on a throwaway copy of `contracts/` outside the working tree:

| tree | rows |
| --- | --- |
| `protocol/main` as-is | **30** |
| `VaultCore._exitFeeBps`'s `block.timestamp - lastDepositTime[member]` (`:956`) replaced by a constant | **20** |
| …and the three `block.timestamp` WRITES into `proposals` / `standingDefaultOf` (`Governance.sol:283, 438, 553`) also replaced | **17** |

Slither's `is_dependent` taint is per STATE VARIABLE, not per struct field or per expression. The
tenure-decayed exit fee flows into `idleUsdc`/`assetBalance` in `_settleExit` and thence into
`totalShares`/`sharesOf` via `_mintShares`, which is why ten `VaultCore` rows about share and
balance arithmetic are reported as timestamp rows. The `proposals` struct is written from
`block.timestamp`, so every comparison that reads *anything* out of it inherits the taint — which
is how `_isSettled`, a `pure` function comparing a `Status` enum, ends up in a timestamp report.

### What the boundary analysis found

Every deadline in the protocol that has two or more comparisons against it **partitions the
timeline exactly**: there is no second in which both adjacent phases are open and none in which
neither is. Nowhere is a `<=` on one side of a deadline matched by a `<` on the other.

| deadline | opens / stays open | closes / next phase | at exactly `t == D` |
| --- | --- | --- | --- |
| `p.commitDeadline` | `commitVote` `<` (`:348`) | `revealVote`/`revealDelegated`/`applyStandingDefault` `>=` (`:365, :395, :457`); `hasPendingExecution` `>=` (`:627`) | commit closed, reveal open, Mode F on |
| `p.revealDeadline` | reveal family `<` (`:366, :396, :458`) | `finalize` `>=` (`:508`) | reveal closed, finalize open |
| `p.expiresAt` | `execute` `<=` (`:571`); `hasPendingExecution` `<=` (`:630`) | `markExpired` `>` (`:599`); `_refreshStatus` `>` (`:606`) | execute open, Mode F on, expiry closed |
| `p.createdAt` | `d.setAt < createdAt` strict (`:470`) | snapshots read `createdAt - 1` (`:287, :288, :304, :338`) | same-second default rejected, same-second stake weightless — same strictness on both sides |
| `order.deadline` | `<=` in `AggregationRouterAdapter:67` | `<=` in `DirectPoolAdapter:88` | both adapters agree; the deadline second is inside the window |

The **Mode I / Mode F seam** is the one that matters financially, and it is clean on both sides:
`hasPendingExecution` at `<= p.expiresAt` is the same comparison `execute` uses, so at
`t == expiresAt` execution is open and `settleQueuedExit` reverts `ExecutionStillPending`, and at
`t == expiresAt + 1` execution reverts `ExecutionWindowOver` and the queued exit settles. That
complementarity is what makes EE-10's no-indefinite-lock claim true, and it now has a test.

Staleness math cannot underflow or wrap. `ChainlinkOracle:280` rejects a future `updatedAt` before
`:283` subtracts, and `:283` saturates anyway; `:316` rejects a future `startedAt` before `:318`
subtracts; `VaultCore.lastDepositTime` has exactly one writer (`:456`, `= block.timestamp`) so
`:956` can never go negative. Every governance deadline addend is a `uint32` bounded by
`_validateConfig`, so no `uint64` sum overflows.

Sequencer/miner skew of 1–2 seconds changes no financial outcome: the smallest window in any
shipped config is one hour, and the only per-second-continuous quantity is the exit fee, which
moves by `exitFeeMaxBps / exitFeeDecayPeriod` per second — 0.00004 bps/s at the shipped 100 bps
over 30 days, i.e. it floors to zero for any skew under half a day.

### One row is real

**Row 6 — `Governance.applyStandingDefault`, `Governance.sol:469-471`.** See T-1 below. Slither
pointed at the right line.

### The rows

Legend: **REAL** = a defect. **DESIGN** = a genuine `block.timestamp` comparison, correct by a
named invariant, with the pinning test. **TAINT** = the function contains no `block.timestamp`;
the row is Slither's state-variable taint and the listed comparisons are ordinary arithmetic.

| # | Site | What the comparison decides | Grade | Invariant / pinning test |
| --- | --- | --- | --- | --- |
| 1 | `Governance.propose` `:281` | `block.timestamp >= lastAt + cfg.proposalCooldown` — whether this proposer may open another proposal | **DESIGN** | M-7 rate limit, bounded to `[1h, 30d]` by `_validateConfig`. Boundary now pinned by `AuditGovernanceDeadlineBoundaries::test_proposalCooldown_boundary`. Honest residual already recorded at `Governance.sol:255-257`: `lastProposalAt` is per-PROPOSER, so a second address sidesteps it. That is not a timestamp defect. |
| 2 | `ChainlinkOracle.priceWad` `:280, :283, :284` | whether a feed round is fresh: reject future stamps, then `updatedAt >= block.timestamp - heartbeat` | **DESIGN** | Fail-closed staleness (C-6). Exactly-at-heartbeat is fresh; `:283` saturates so a heartbeat above the clock cannot underflow-panic out of `StaleOracle`. `AuditTimestampBoundaries::test_heartbeat_partitionsExactly`, plus existing `ChainlinkOracle::test_freshAtHeartbeatBoundary` / `::test_failClosed_stale`. |
| 3 | `ChainlinkOracle._requireSequencerUp` `:316, :318` | whether the L2 sequencer has been up longer than `GRACE_PERIOD` | **DESIGN** | Conservative direction: exactly-at-grace reads DOWN, so the window must fully elapse. `:316` guards `:318` against underflow. Already the best-covered family in the suite — `ChainlinkOracleSequencerFork` exercises grace−1, grace and grace+1. |
| 4 | `Governance.revealVote` `:365-366` | reveal-phase membership `[commitDeadline, revealDeadline)` | **DESIGN** | Exact complement of `commitVote` `:348` and `finalize` `:508`. `AuditGovernanceDeadlineBoundaries::test_commitDeadline_partitionsExactly` and `::test_revealDeadline_partitionsExactly`. |
| 5 | `Governance.markExpired` `:599` | `block.timestamp > p.expiresAt` — whether a passed proposal may be marked Expired | **DESIGN** | The strict `>` is the exact complement of `execute`'s `<=` (`:571`). `AuditGovernanceDeadlineBoundaries::test_expiresAt_partitionsExactly_executeVsMarkExpired`. |
| 6 | `Governance.applyStandingDefault` `:457-458` (phase) and **`:470` (TTL)** | the phase guard is fine; **the TTL guard `block.timestamp <= d.setAt + DEFAULT_TTL` is evaluated during the REVEAL phase, so a standing default's usable life is `DEFAULT_TTL - cfg.commitDuration`, not `DEFAULT_TTL`** | **REAL (Low)** | See T-1 below. Failing tests exist and are deliberately NOT committed. |
| 7 | `Governance._accrueDelegate` `:422-425` | concentration cap, `accrued * BPS <= capBps * p.snapshotTotal` | **TAINT** | No `block.timestamp` in the function; it reads `p.snapshotTotal` out of the tainted `proposals`. Dropped in ablation 2. VO-5. |
| 8 | `VaultCore._mintShares` `:445, :446, :448` | `ts == 0` first-deposit, `minted > 0`, `sharesOf[member] == 0` new-holder | **TAINT** | The function's only `block.timestamp` (`:456`) is a WRITE to `lastDepositTime`, not a comparison. Dropped in ablation 1. |
| 9 | `Governance.commitVote` `:348` | `block.timestamp < p.commitDeadline` — commit-phase membership | **DESIGN** | The strict `<` is the exact complement of the reveal family's `>=`. `::test_commitDeadline_partitionsExactly`. |
| 10 | `VaultCore._settleExit` (16 comparisons, `:566`–`:727`) | pro-rata exit arithmetic, shortfall dust, performance fee | **TAINT** | Reaches the clock only through `_exitFeeBps`. Dropped in ablation 1. The exit-fee *value* is a function of time; none of the sixteen listed comparisons is. |
| 11 | `Governance.setDelegate` `:494` | `_isSettled(proposals[activePid].status)` — no delegation changes mid-proposal | **TAINT** | Reaches the clock only through `_refreshStatus` (`:606`). Dropped in ablation 2. |
| 12 | `VaultCore._exitFeeBps` `:958` | `tenure >= period` — whether the tenure-decayed exit fee has fully decayed | **DESIGN** | **The only guard in the protocol with no boundary semantics at all — measured.** Flipping `>=` to `>` is observationally equivalent: at `tenure == period` the `>` branch falls through to `maxBps * (period - period) / period`, which is also 0, and at `tenure == period + 1` the `>` branch returns 0 before the subtraction can underflow. The mutation SURVIVES the whole suite. The `>=` is an underflow guard on `period - tenure`, not a deadline. The decay is likewise continuous into the boundary — the linear term floors to 0 long before `period` (measured: 3 bps at `period - 1 day`, 0 at `period - 1`) — so no 1-second skew has a discontinuity to straddle. `AuditTimestampBoundaries::test_exitFeeDecay_boundaryIsContinuous` pins the decay curve (it catches a mutation of the formula) rather than an operator choice, and is labelled as such. |
| 13 | `AggregationRouterAdapter.executeSwap` `:67` | `block.timestamp <= order.deadline` — order freshness | **DESIGN** | The deadline second is inside the valid window, identical to `DirectPoolAdapter:88`. `AuditTimestampBoundaries::test_adapterOrderDeadline_partitionsExactly`. |
| 14 | `Governance.revealDelegated` `:395-396` | reveal-phase membership for the delegation crank | **DESIGN** | The same guard as row 4, character for character. Same tests. |
| 15 | `VaultCore.convertToAssets` `:1035` | `ts == 0` | **TAINT** | Indicative-only preview (C-1, not ERC-4626). Dropped in ablation 1. |
| 16 | `VaultCore.navPerShareWad` `:342` | `ts == 0` | **TAINT** | Dropped in ablation 1. |
| 17 | `Governance._isSettled` `:613` | `s == Defeated \|\| s == Executed \|\| s == Expired` | **TAINT** | A `pure` function over an enum — the clearest single proof that the detector is reporting argument taint rather than logic. Dropped in ablation 2. |
| 18 | `VaultCore.executeRebalance` `:851-855, :859, :863` | slippage floor and balance sufficiency | **TAINT** | Dropped in ablation 1 (`idleUsdc`/`assetBalance` carry the fee taint). The EX-3 measured-delta reasoning is unrelated to the clock. |
| 19 | `VaultCore._checkCreatorGate` `:557-560` | creator 5% minimum stake (CM-1/CM-2) | **TAINT** | Dropped in ablation 1. |
| 20 | `Checkpoints.push` `:23` | `h.arr[len-1].ts == uint64(block.timestamp)` — overwrite a same-second checkpoint instead of appending | **DESIGN** | The standard OZ idiom; the strict equality is the point of the line. It pairs with `getAt`'s inclusive `<=` to make the `createdAt - 1` snapshot convention (VO-9) exact. `AuditTimestampBoundaries::test_checkpointsSameSecondOverwriteIsLastWriteWins`. |
| 21 | `VaultCore.requestExit` `:509` | `sharesOf[msg.sender] >= shares` | **TAINT** | Reaches the clock only via `_snapshot` → `Checkpoints.push`. Dropped in ablation 1. The Mode I / Mode F choice at `:511` is a `hasPendingExecution` call, not a comparison. |
| 22 | `VaultCore.convertToShares` `:1028` | `ts == 0` | **TAINT** | Dropped in ablation 1. |
| 23 | `VaultCore._deposit` `:375, :386, :389` | capacity cap, deposit slippage, one-pending-deposit-at-a-time | **TAINT** | The function's `block.timestamp` (`:390`) is a WRITE computing `availableAt`; none of the three listed comparisons touches it. Survives both ablations because it carries its own seed. |
| 24 | `DirectPoolAdapter.executeSwap` `:88` | `block.timestamp <= order.deadline` | **DESIGN** | Identical to row 13; the two adapters agreeing on the boundary is itself the property worth pinning. Same test. |
| 25 | `VaultCore.allocateToChild` `:746` | `idleUsdc >= amountUsdc` | **TAINT** | Dropped in ablation 1. |
| 26 | `Governance._refreshStatus` `:606` | `block.timestamp > p.expiresAt` — lazy transition Passed → Expired | **DESIGN** | The same strict `>` as `markExpired`. Crucially `hasPendingExecution` does NOT depend on this crank having run — it re-derives expiry from the clock — so a stale `Passed` status never traps an exit. Same test as row 5. |
| 27 | `Governance.finalize` `:508` | `block.timestamp >= p.revealDeadline` — the tally may begin | **DESIGN** | Exact complement of the reveal family's `<`. `::test_revealDeadline_partitionsExactly`. |
| 28 | `Governance.hasPendingExecution` `:627, :630` | **the Mode I / Mode F exit seam** — `>= commitDeadline` while Active, `<= expiresAt` while Passed | **DESIGN** | The `<=` matches `execute`'s `<=` exactly, which is what makes EE-10 true. The `>= commitDeadline` start is VO-8: the outcome begins leaking on-chain at reveal, so exits after that must be forward-priced, and Mode F is deliberately OFF for the whole commit phase — the C-5 note at `Governance.sol:312-330` documents that seam. `::test_expiresAt_partitionsExactly_executeVsMarkExpired` and `::test_commitDeadline_partitionsExactly`. |
| 29 | `Governance.execute` `:570, :571` | timelock elapsed, and execution window not yet over | **DESIGN** | `>= executableAt` and `<= expiresAt`. `::test_executableAt_boundary` and `::test_expiresAt_partitionsExactly_executeVsMarkExpired`. |
| 30 | `VaultCore.activate` `:403` | `block.timestamp >= p.availableAt` — the 4h observation window has elapsed | **DESIGN** | One-sided by design; there is no upper deadline (see the residual below). `AuditTimestampBoundaries::test_observationWindow_partitionsExactly` adds the missing `availableAt + 1` case to the existing −1 / exact pair. |

Tally: **1 REAL, 16 DESIGN, 13 TAINT.**

### T-1 — `applyStandingDefault`'s TTL is measured at apply time (REAL, Low)

```solidity
// Governance.sol:469-471
require(
    d.set && d.setAt < p.createdAt && block.timestamp <= d.setAt + DEFAULT_TTL, DefaultUnavailable()
);
```

`applyStandingDefault` is callable only during the reveal phase (`:457-458`), i.e. no earlier than
`p.createdAt + cfg.commitDuration`. The TTL is therefore never evaluated at proposal creation, and
the **usable** life of a standing default is `DEFAULT_TTL - cfg.commitDuration`, not `DEFAULT_TTL`.

`_validateConfig` bounds `cfg.commitDuration` to `[1 hours, COMMIT_HARD_CAP]` with
`COMMIT_HARD_CAP = 30 days`, and **never relates it to `DEFAULT_TTL = 72 hours`**. So a vault
registered with `commitDuration >= 72 hours` — legal, silent, no event, chosen by the creator at
`registerVault` and changeable later by RuleChange (`configOf[p.vault] = newCfg`, `:577-580`) — has
every standing default provably expired before its reveal window opens. VO-3 is dead for that
vault, and the validator whose stated purpose is to stop a config disabling its own defences (its
own M-6 comment, `:238-247`) does not object.

Demonstrated by a three-test pair, RUN and deliberately NOT committed — a red test never lands, so
the file is carried in the PR body and in the Ops2 findings file instead:

```
[PASS] test_T1_control_shortCommitPhase_defaultApplies()                                      commitDuration 6h
[FAIL: DefaultUnavailable()] test_T1_exploit_commitPhaseLongerThanTtlKillsStandingDefaults()   commitDuration 4 days
[FAIL: DefaultUnavailable()] test_T1b_effectiveTtlIsShortenedByTheCommitPhase()                commitDuration 1h (shipped)
```

The control is the discriminator: the identical sequence succeeds at 6 hours and reverts at 4 days.

**Severity Low, argued rather than asserted.** Standing defaults count toward the tally and never
toward quorum (VO-2/K-3) and are Rebalance-only (VO-4), so suppressing them can only move
`forWeight > againstWeight` — no funds are at risk directly. The consequence is that pre-declared
AGAINST weight can silently fail to reach the tally, letting a proposal pass on a smaller live FOR
vote. It is bounded by the member's own diligence, since VO-3's design is that defaults expire and
are refreshed. What is nowhere stated — docs, NatSpec or test — is that the window is
`72h - commitDuration`, and that it is zero at `commitDuration >= 72h`. **Not reachable at launch:**
`base-mainnet.json` and `base-sepolia.json` both ship `commitDuration: 3600`, so only the shortened
window (T-1b) applies today, not the total kill.

**Fix shape (deliberately not applied on the audit branch).** Either is sufficient:

1. `_validateConfig`: `require(cfg.commitDuration < DEFAULT_TTL, BadGovConfig());` — makes the dead
   configuration unrepresentable. It narrows an existing legal range; no registered vault is above
   72h, so nothing in flight breaks.
2. `:470`: compare against the proposal rather than against the clock —
   `p.createdAt <= d.setAt + DEFAULT_TTL`. This states the semantics the surrounding comment already
   claims ("the default must be genuinely STANDING — set before the proposal existed"), keeps the
   `d.setAt < p.createdAt` lower bound intact, and additionally removes a crank-order dependence:
   today, whether a default counts can depend on how promptly a permissionless cranker calls
   `applyStandingDefault` within the reveal window.

### Residual found but not changed (SWARM §4)

**`activate` has no upper deadline, and `cancelPending` has none at all.** From `availableAt`
onward both are open indefinitely, so a pending depositor chooses the second at which they mint —
the entry-side sibling of **M-9** (settlement timing as a free option, `AI-AUDIT-REPORT.md`), which
is recorded only for the exit side. Its value is bounded by oracle accuracy rather than by the
clock, since minting at a correct NAV never dilutes, so it is worth something only while the feed
lags; and `activate` being permissionless means a keeper can end the option at any time. The
unbounded `cancelPending` is a deliberate, documented liveness guarantee (`ARCHITECTURE.md:255`,
"pending capital is never frozen"), so this is a note on an accepted design rather than a proposed
change. Recorded because `ARCHITECTURE.md:98-99` states the forward-pricing rationale in one
direction only.

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
