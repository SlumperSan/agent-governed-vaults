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
| `reentrancy-no-eth`, `reentrancy-events`, `reentrancy-benign` | **False positive, but NOT for one reason — check the site before reusing this row.** The `VaultCore` functions flagged (`deposit`, `executeRebalance`, `_settleExit`, child flows) carry the `nonReentrant` mutex (shared lock, `_lock`), which Slither does not model. **This row has twice been read as "everything flagged carries the mutex", and twice that was false** — see the Sprint 10 and Sprint 14 corrections below. `FeeEngine.onFeeCollected` has no mutex, and **`Governance` has none anywhere**; both are benign by CEI, which is a different argument that has to be made separately. A blanket dismissal is how a real finding gets filed as noise. CEI + the single lock were proven sound in SPRINT1-SECURITY-REVIEW §"Reentrancy / CEI" and re-verified in the SPRINT6 execution review. The H-1 fix additionally makes every external module call on the exit path gas-bounded and non-blocking. **Sprint 10 correction:** `VaultFactory.createVault` / `createChildVault` are also flagged (a hostile settlement or basket token can reenter from `decimals()` during `VaultCore`'s constructor) and they carry **no** mutex — so the mutex reasoning above does not cover them. They are still benign, for a different reason: the factory's only state is the append-only `allVaults`, so nesting interleaves push order and nothing else; `VaultCreated` is emitted innermost-first and the indexer sorts by `(block, logIndex)`, matching emission order; and a nested attempt to register the still-constructing outer vault as a sub-vault parent fails, because `registerChild` calls `IVaultFees(parent).exitFeeMaxBps()` on a contract that has no code yet. Pre-existing — `new VaultCore(...)` made the same constructor calls — but Sprint 7's extra hop puts these rows in the output more prominently, so the reasoning is recorded rather than assumed. **AI-audit correction (§4.5):** the mutex reasoning is sound for SAME-contract reentrancy but does not cover **cross-contract read-only reentrancy** — a `VaultCore`'s public views are read as an oracle by its PARENT while the child is mid-mutation, and a per-contract mutex is definitionally not a defence against a different contract reading it (**H-9**). Slither does not model this either, so the row's blind spot and the analyser's coincide. **2026-09-01 correction — "false positive" is now disproved for this class, twice, and the dormancy argument is a configuration property rather than a code one.** (a) H-9 was filed PLAUSIBLE with *no executing test*; **#98 wrote one** — a parent pricing a mid-swap child reads an understated `_fullNavWad` and mints against it, **2,000e18 shares for 1,000 USDC** — so H-9 is a CONFIRMED, reproduced defect, not an analyser artefact. Slither never flagged H-9 itself — it cannot, the read is in a DIFFERENT contract — but the rows this line covers are the mutation windows H-9 reads through: `VaultCore._settleExit` and `_redeemChildMeasured` (`reentrancy-benign`), `executeRebalance` and `allocateToChild` (`reentrancy-no-eth`). (b) The sibling detector `reentrancy-balance` produced an outright **theft** at `AggregationRouterAdapter.executeSwap` (600e6 USDC extracted in test) — see the per-row section below; the class dismissal had held there too. **Status on `protocol/main` @ `29b1b470`, stated because this document has twice been read as describing code that had not landed:** #101 IS merged (`cf42c58a`) and both adapters carry a `nonReentrant` mutex. **As recorded on 2026-09-01, at `29b1b470`: #98 was then an open PR and H-9 was UNFIXED**; there was no `locked()` anywhere in `contracts/src` and no `test/audit/AuditReentrancyGuardCoverage.t.sol` at that commit, and the paragraph above was reasoned against that. **Correction 2026-09-02 (FixSlitherTriage) — branch state only:** #98 merged 2026-09-01T22:30:54Z as `8336677f`, which `git merge-base --is-ancestor 8336677f 52d10aee` confirms is an ancestor of `protocol/main`; `VaultCore.locked()` and `test/audit/AuditReentrancyGuardCoverage.t.sol` are both present there. **Whether H-9's disposition changes now that the guard has landed is deliberately NOT decided here** — that is a re-derivation against the merged code and belongs to whoever owns the H-9 row. The original claim is restated above rather than deleted, in the past tense it should have been written in: a present-tense claim about branch state, written from intent rather than from `git`, has no expiry on its face and reads as current forever — which is how three documents went on asserting this one after #98 had merged. What remains true is the *launch* mitigation: H-9 needs a parent/child pair and sub-vaults are disabled at launch (`allowSubVaults = false`, C-1 gate) — but that is a property of the deployment CONFIG, undone by the first sub-vault, not a reason the detector was wrong. **Triaged row by row on 2026-09-01 — see “The small detector groups, 49 rows” below.** All 12 rows in the three `reentrancy-*` detectors are argued individually there; one `reentrancy-events` row (`Governance.execute`) is **REAL (Low, off-chain)**, and the `FeeEngine.pullEscrowed` row this cell would cover is stale — that function has been `nonReentrant` since M-3. |
| `divide-before-multiply` | **By design for the payout legs.** The `a * b / ts * c / BPS` pattern in `_settleExit` loses precision **downward on purpose** — rounding favors the vault/remaining members, the algebraic condition for the §4.6 NAVps-non-decreasing invariant (SPRINT1 §4.6, fuzzed). **AI-audit correction (§4.5):** "rounds in the vault's favour" is not the same as "safe" — the same pattern at `:557` is what makes `:576`'s shortfall dust check unsatisfiable and reverts a member's child-backed exit (**H-6**). H-6 is a sub-vault-only path and is **dormant at launch** (root vaults only, C-1 gate; sub-vaults disabled), deferred with the sub-vault feature. Not a disposition change for the payout-leg rounding, but the "safe" generalization was too broad. |
| `unused-return` | **By design.** (a) The `boundedCall` results are intentionally best-effort (H-1): the `ok` flag is checked where liveness needs it and the rest ignored — a failing bookkeeping module must not block an exit. (b) `IExecutionAdapter.executeSwap`'s return is ignored because output is measured from the vault's OWN balance delta (EX-3), never the adapter's word. (c) `getReserves`/`latestRoundData` ignore fields the caller doesn't need (timestamp / round metadata). **Triaged row by row on 2026-09-01 — see “The small detector groups, 49 rows” below.** All 11 rows are enumerated there, the `SafeTransferLib` wrappers are **verified** to revert on false rather than assumed to, and the discarded `retSize` on the fee-engine call in `VaultCore._settleExit` is now pinned by two tests. |
| `incorrect-equality` (x13) | **Triaged row by row on 2026-09-01 - see "`incorrect-equality`, thirteen rows" below.** The blanket "Safe" this replaces reached the right verdict on the wrong evidence: it cited "NAV never reads `balanceOf`, EE-1" as if that covered all thirteen rows, when only four of them are about NAV at all. No row is REAL; three now have executing tests.
| `uninitialized-local` | **Safe.** `k`, `perfFee`, `childValTotalWad` are accumulators intentionally relying on Solidity's zero-default before being summed. **Triaged row by row on 2026-09-01 — see “The small detector groups, 49 rows” below.** Correction: `k` no longer fires — 2 rows, not 3 — and `perfFee` is *conditionally* assigned rather than accumulated. |
| `timestamp` | **Accepted (K-4 / by design)** for `Governance` and `Checkpoints`. The protocol uses `block.timestamp` as its only clock (commitment C-2, no block numbers); governance/staleness windows are minutes-to-days, far outside miner tolerance (~±15s). **+1 in Sprint 10:** `Checkpoints.push` same-second overwrite. **AI-audit correction (§4.5):** this row predated Sprint 11 and omitted `latestPrice` (`UniswapV3TwapSource.sol:282-292`), the one timestamp use with a security consequence (**H-2**). H-2 has since been **FIXED** (the constructor now requires `maxObservationAge <= window/20`; regression `AuditTwapRealCostModel.t.sol`), so the omission is closed. |
| `calls-loop`, `costly-loop`, `cache-array-length`, `cyclomatic-complexity` | **Accepted for the basket loop** (capped at 10). **AI-audit correction (§4.5):** the "~237k gas" bound was measured on a 1-child/1-grandchild fixture (6 `priceWad` calls); the caps actually permit ~730 calls at the `MAX_CHILDREN` fan-out, so `navWad` is bounded in *shape* but unbounded in *cost* (**M-5**, ~12M gas at 8×8 vaults). M-5's fan-out requires sub-vaults, which are **disabled at launch** (root vaults only, C-1 gate), so at launch `navWad` loops only over the basket (≤10) and the original bound holds; M-5 is deferred with the sub-vault feature. The `NavGas.t.sol` sub-vault assertion is a fixture bound, not a proof of the worst case.  **`costly-loop`, `cache-array-length` and `cyclomatic-complexity` triaged row by row on 2026-09-01 — see “The small detector groups, 49 rows” below; `calls-loop` is NOT covered by that pass.** All three `costly-loop` rows are in `executeRebalance`'s **orders** loop, which this cell's “basket loop (capped at 10)” does not describe and which nothing in the contract caps. |
| `low-level-calls` | **By design.** `AggregationRouterAdapter.executeSwap` — the pinned-router call behind the selector allowlist + measured-delta minOut (EX-3). **+3 in Sprint 10** (newly visible): `SafeTransferLib.safeTransfer` / `safeTransferFrom` / `safeApprove`, each a `token.call(abi.encodeWithSelector(...))`. The low-level form is the whole point — it tolerates non-standard ERC-20s that return nothing or malformed data instead of reverting on them (H-2), which a high-level call cannot do. Every one checks `ok` and validates the return payload. Reviewed in SPRINT1; before Sprint 10 the analyser had never actually seen them (banner above), and now that it has, it reports exactly these three by-design sites and nothing more. **Triaged row by row on 2026-09-01 — see “The small detector groups, 49 rows” below.** **That last sentence is now false:** M-11 moved the three `SafeTransferLib` calls into assembly, so the detector no longer sees them; the two live rows are the adapter's `router.call` and `ChainlinkOracle._requireUsdQuote`'s `description()` probe, which this cell never mentioned. |
| `missing-inheritance` | **Cosmetic.** Interface-shaped contracts that don't formally `is` the interface; ABIs match. Sprint 7 added one instance: `VaultDeployer` vs `IVaultDeployer` (declared inside `VaultFactory.sol`). Same disposition — the single `deploy(bytes) returns (address)` selector matches, and `Eip170::test_factoryPinsItsDeployerImmutably` plus every factory-path test exercise the call across the interface. **Triaged row by row on 2026-09-01 — see “The small detector groups, 49 rows” below.** Still cosmetic, but no longer unpinned: `test/InterfaceSelectorDrift.t.sol` asserts every selector on all four pairs. |
| `assembly` | **By design.** Six sites. **Three newly visible in Sprint 10** and predating it by far — `BoundedCall.boundedCall`, `BoundedCall.boundedStaticCall` (gas-bounded, returndata-capped module calls, the H-1 fix) and `SafeTransferLib.tryTransfer` (non-reverting transfer, the H-2 fix); all three were reviewed by hand in SPRINT1-SECURITY-REVIEW, which is where those fixes were designed. **Three from Sprint 7**, all in `VaultDeployer`: the SSTORE2 `_writeChunk` header, the `CREATE` in `deploy`, and `_readChunk`'s `extcodecopy`. This contract exists *because* the work cannot be expressed in Solidity — `type(VaultCore).creationCode` has to be relocated out of the factory's runtime (#10). All three blocks were reviewed opcode by opcode in [SPRINT10-DEPLOYMENT-REVIEW §3.5](SPRINT10-DEPLOYMENT-REVIEW.md), including the `memory-safe` annotations and the revert-path memory clobber. **Triaged row by row on 2026-09-01 — see “The small detector groups, 49 rows” below.** Correction: there are now **eight** blocks, not six — M-11 added `SafeTransferLib._call2` and `_call3`. |
| `too-many-digits` | **False positive.** **+1 newly visible in Sprint 10:** `SafeTransferLib.tryTransfer#40` — the left-aligned `0xa9059cbb00…00` ERC-20 `transfer` selector written into assembly memory. That is a 4-byte selector padded to a word, not a magic number. The Sprint-7 instance fires on `code = type(VaultCore).creationCode` in `VaultDeployer`'s constructor — Slither renders the ~24.7 KB blob as a numeric literal and objects to its length. It is not a literal anyone typed; it is the compiler-embedded creation code, and its correctness is asserted byte-for-byte by `Eip170::test_deployerCreationCodeIsTheCompiledVaultCore`. **Triaged row by row on 2026-09-01 — see “The small detector groups, 49 rows” below.** |

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
configuration — and the fix was written and reviewed as **PR #98**, merged 2026-09-01 as `8336677f` (a `locked()` view plus
`require(!v.locked(), Reentrancy())` in `_fullNavWad`, +170 B, with a reproduction that mints
2,000e18 shares for 1,000 USDC).

Deliberately **not** changed here: hoisting the debit, or reordering anything in
`executeRebalance`. The ordering is not the defect — the understatement window cannot be closed at
all, because the output amount is not knowable until the swap returns and taking the adapter's word
for it is exactly EX-3. Making the window *unobservable* is the only available fix, and #98 owns
that file.

**Correction 2026-09-02 (FixSlitherTriage) — branch state only.** The two paragraphs above were
written while #98 was an open PR, and the sentence "it is **unfixed on `protocol/main`**" is
stale as branch state. #98 merged 2026-09-01T22:30:54Z as `8336677f`, which `git merge-base --is-ancestor 8336677f 52d10aee` confirms is an ancestor of `protocol/main`; `VaultCore.locked()` and `test/audit/AuditReentrancyGuardCoverage.t.sol` are both present there. Whether that makes H-9 FIXED rather
than unfixed is a re-derivation against the merged code and is **not decided here** — the H-9
row owns it. Only the branch-state claim is corrected.

### `VaultCore._settleExit` → `_redeemChildMeasured(child, cs, false)` — 1 row

**Not real.** `_settleExit` has exactly two call sites, `requestExit` (:520) and
`settleQueuedExit` (:551); both are `nonReentrant`. Every internal decrement — `sharesOf`,
`totalShares`, `costBasisUsdc`, `idleUsdc`, each basket `slice` — completes *before* the first
external call, so the flagged `shortfallWad` condition is evaluated against accounting that is
already final. The child proceeds are deliberately left un-credited (`credit = false`): they belong
to the exiter, not to the vault, so excluding them from NAV is correct rather than an
understatement. Worst case on this path is a clean revert (`ExitNeedsChildSettlement`). H-9 reaches
the same conclusion for this path independently. #98's guard covers it belt-and-braces, since
the vault is locked throughout. **As recorded on 2026-09-01 that guard was not yet on
`protocol/main`** and this row's safety was argued on CEI alone; #98 merged 2026-09-01T22:30:54Z as `8336677f`, which `git merge-base --is-ancestor 8336677f 52d10aee` confirms is an ancestor of `protocol/main`; `VaultCore.locked()` and `test/audit/AuditReentrancyGuardCoverage.t.sol` are both present there.
The CEI argument is what the disposition rests on either way, which is why nothing here
changes.

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

## `incorrect-equality`, thirteen rows (triaged 2026-09-01)

The row above used to be one line reading "**Safe.**" It reached the right verdict, but by a
class argument nobody had checked per row — the same shape as the `reentrancy-balance` line that
PR #101 disproved. Every row is now argued on its own, against `protocol/main` @ `29b1b470`
(`225` results total; `slither 0.11.6`) — the commit the Slither run was made at. `main` is
`52d10aee` as of 2026-09-02, and every `file:line` citation below has been re-resolved against
that tree (`scripts/test/slither-triage-citations.test.mjs` keeps them there).

**Tally: REAL 0 · BENIGN-BY-DESIGN 10 · STYLE 3.** Nothing here needs a fix.

| # | Site (`contracts/src/…`) | Expression | Grade | Reason | Pinned by |
| --- | --- | --- | --- | --- | --- |
| 1 | `VaultCore.sol:377` `navPerShareWad` | `ts == 0` | BENIGN | `totalShares == 0` implies `navWad() == 0` — see "the `ts == 0` group" below. | `test_soleHolderExitDrainsExactlyAndTheTsZeroBranchReopensClean` |
| 2 | `Governance.sol:613` `_isSettled` | `s == Status.Defeated \|\| s == Status.Executed \|\| s == Status.Expired` | BENIGN | Not "is the enum exhaustive" (it is) but "can a proposal hang non-settled and freeze `propose`". Every non-settled status has a permissionless, external-call-free exit. | `test_abandonedProposalIsAlwaysSettleableByAStrangerAndUnblocksPropose`, `test_passedButUnexecutedProposalExpiresAndUnblocksPropose` |
| 3 | `VaultCore.sol:650` `_settleExit` | `slice == 0` | STYLE | `continue`-guard on a zero in-kind leg. Floors **down**, against the exiter — the algebraic condition for the §4.6 NAVps invariant; a `< 1` would behave identically. | — |
| 4 | `VaultCore.sol:1086` `convertToAssets` | `ts == 0` | BENIGN | Same invariant as row 1, on an explicitly indicative-only 4626-shaped view (C-1). | as row 1 |
| 5 | `VaultCore.sol:719` `_settleExit` | `payoutValueWad == 0` | STYLE | Divide-by-zero guard, and the branch is unreachable with a nonzero numerator: `payoutValueWad == 0` forces the `else` branch, so `perfFee == 0` and `0` is the correct substitute. | — |
| 6 | `VaultCore.sol:669` `_settleExit` | `cs == 0` | BENIGN | Needs `parentShares × takeWad < cv` while `takeWad > SHORTFALL_DUST_WAD` — at an 18-decimal share scale, a child worth > $1e12. If it ever fired, the consequence is a **clean revert** (`require(shortfallWad <= SHORTFALL_DUST_WAD, ExitNeedsChildSettlement())`), not a silent underpayment (the H-6 shape; sub-vaults are off at launch, C-1). | — |
| 7 | `lib/Checkpoints.sol:23` `push` | `len > 0 && h.arr[len-1].ts == uint64(block.timestamp)` | BENIGN | Still the OZ idiom. Overwrite ≡ append for every reader (`getAt` returns the last entry with `ts' <= ts` either way), and it cannot backfill a vote because governance reads `createdAt - 1`, strictly before any push in that second. | `test_sameSecondCheckpointCannotBackfillProposalWeight` |
| 8 | `VaultCore.sol:674` `_settleExit` | `childDeltas[j] == 0` | STYLE | `continue`-guard on a leg the child did not deliver; skipping it also skips `_assetValueWad`, so `receivedWad` is not credited for value that never arrived (S6 Finding 5). | — |
| 9 | `VaultCore.sol:480` `_mintShares` | `ts == 0` | BENIGN | The ERC-4626 inflation-attack site. The attack needs a NAV a donor can move; `navWad()` reads only `idleUsdc` / `assetBalance` / child look-through (EE-1, **verified for this row**, not cited). | `test_donationCannotMoveNavOrDiluteTheNextMint` |
| 10 | `VaultCore.sol:636` `_settleExit` | `sharesOf[member] == 0 && memberShares > 0` | BENIGN | Holder-count decrement, exact mirror of the increment in `_mintShares`; `creator` is `immutable` so `nonCreatorMemberCount` cannot drift. The `memberShares > 0` conjunct is defensive only — the `costBasisUsdc[member] * burnShares / memberShares` division a few lines below would `Panic(0x12)` on a zero-share member first. | — |
| 11 | `VaultCore.sol:1079` `convertToShares` | `ts == 0` | BENIGN | Same invariant as row 1; indicative-only view (C-1). | as row 1 |
| 12 | `VaultCore.sol:483` `_mintShares` | `sharesOf[member] == 0` | BENIGN | "First shares for this address ⇒ new holder." The only other writer zeroes it and decrements symmetrically, so re-entry after a full exit re-counts correctly. | — |
| 13 | `VaultCore.sol:611` `_settleExit` | `memberShares == ts` | BENIGN | Sole-holder exit-fee waiver. Cannot be a false positive: `sharesOf` and `totalShares` are written only in matched pairs (`sharesOf[member] += minted` / `totalShares = ts + minted` in `_mintShares`; `sharesOf[member] = memberShares - burnShares` / `totalShares = ts - burnShares` in `_settleExit`) and **there is no share-transfer function**, so `sum(sharesOf) == totalShares` exactly. | `test_soleHolderExitDrainsExactlyAndTheTsZeroBranchReopensClean` |

### The `ts == 0` group (rows 1, 4, 9, 11) — the one question that decides all four

*Can `totalShares == 0` while `navWad() > 0`?* If yes, the 1:1 re-open in `_mintShares` gives
away residue and `navPerShareWad`'s `WAD` is a lie. It cannot:

- **Donation is inert.** `navWad()` sums `idleUsdc * usdcScalar`, `assetBalance[a]`
  and `_childValueWad(...)` — all internal. The only `balanceOf` in `VaultCore` is `_tokenBalance`
  in `_bal`, on the measured-delta rebalance path (EX-3), never in NAV. Checked for these rows
  rather than cited from EE-1.
- **The last exiter is always the sole holder**, so `memberShares == ts` (row 13) sets `feeBps = 0`,
  `keepBps = BPS`, `burnKeep == tsBps`, and both pro-rata legs collapse to identities:
  `slice = assetBalance[a] * tsBps / tsBps` and `cashTargetWad / usdcScalar = idleUsdc`,
  both in `_settleExit`. Nothing is floored away.
- **The sub-vault leg is exact-or-revert.** On a full sole-holder exit `shortfallWad ==
  childValTotalWad`, so `takeWad == cv` for each child and `cs = parentShares * cv / cv` is the
  whole position. Any child that is skipped or under-delivers leaves `shortfallWad` above
  `SHORTFALL_DUST_WAD` and the exit **reverts** with `ExitNeedsChildSettlement` rather than settling with residue.
  Residual is bounded at `1e12` WAD (1e-6 USD), and the constructor pins
  `usdcScalar <= SHORTFALL_DUST_WAD` in the constructor.
- **Observed on-chain:** the 2026-09-01 Base Sepolia gate-2 lifecycle exited for exactly
  `5,000,000` USDC units and left `totalShares() == 0`.

### Row 13's adversarial direction, and where it is already registered

The interesting attack on `memberShares == ts` is not a false positive but the reverse: a squatter
who deposits `minDepositUsdc`, clears the observation window, and thereby **destroys** the waiver,
so the incumbent's exit pays up to `exitFeeMaxBps` — which stays in the vault and
accrues almost entirely to the squatter. That is **THREAT-MODEL EE-8** (last-two-members endgame),
Accepted at **L**. Bounded twice over in code: `EXIT_FEE_CAP_BPS = 100` and `_exitFeeBps`
decays linearly to zero at `exitFeeDecayPeriod`. Removing the waiver makes the row
strictly worse — the `==` narrows a fee, it does not create one.

Worth one line in the launch-parameter set (alongside the band re-parameterisation): EE-8's "bounded
at 1%" is true per-exit, but the *ratio* is not — the squatter's cost is `minDepositUsdc` plus the
window, and the prize is up to 1% of a recently-topped-up whale's whole exit, because
`lastDepositTime[member] = block.timestamp` resets the tenure clock on **every** top-up.

### The three tests, and the mutations that make them red

`contracts/test/audit/AuditIncorrectEqualityRows.t.sol` (5 tests, all green). Each was verified to
fail under the mutation that would make its row real:

| Mutation | Test that turns red | Observed |
| --- | --- | --- |
| `Governance._boundedWeight:338` `p.createdAt - 1` → `p.createdAt` | `test_sameSecondCheckpointCannotBackfillProposalWeight` | `9000e18 != 1000e18` — 8,000 USDC deposited in the proposal's own second buys 9× weight |
| `VaultCore.navWad:301` `idleUsdc` → `IERC20Metadata(usdc).balanceOf(address(this))` | `test_donationCannotMoveNavOrDiluteTheNextMint` | `6000e18 != 1000e18` — a donation moves NAV |
| `VaultCore._settleExit:611` delete `if (memberShares == ts) feeBps = 0;` | `test_soleHolderExitDrainsExactlyAndTheTsZeroBranchReopensClean` | `999900000 != 1010000000` — the sole holder's fee is stranded in a zero-share vault |

Row 7's test is deliberately a **Governance-level composition test rather than a `Checkpoints` unit
test**: three writes land in one second `T` (a deposit that appends at `T`, the `propose` call, and
a second deposit that *overwrites* the checkpoint at `T`), and the assertions are that the
proposal's `T - 1` read is unmoved and that `getAt(T)` still returns the end-of-second value. A unit
test on `push` would die only to a `Checkpoints` mutation and would miss the one above, which is the
mutation that actually matters.


## The small detector groups, 49 rows, triaged row by row (2026-09-01)

Everything below is one triage pass over **every detector except the five that were given their own
pass**: `calls-loop` (121), `timestamp` (30), `incorrect-equality` (13), `reentrancy-balance` (8,
above) and `divide-before-multiply` (4). That leaves **49 rows across 13 detectors**, which is the
whole rest of the output.

Inventory is from a fresh run at `protocol/main` `29b1b470`, not from the counts in the vault's
`Project State`: `slither . --filter-paths "^lib/|^test/|^script/"` → **225 results, 36 contracts,
102 detectors**.

| detector | rows | verdict |
| --- | --- | --- |
| `unused-return` | 11 | 11 benign-by-design |
| `assembly` | 8 | 8 by-design; 1 style gap (below) |
| `reentrancy-benign` | 6 | 6 benign-by-design |
| `reentrancy-events` | 4 | 3 benign-by-design, **1 REAL (Low, off-chain)** |
| `missing-inheritance` | 4 | 4 benign-by-design, now pinned by a test |
| `costly-loop` | 3 | 3 benign-by-design — **and the row that dispositioned them named the wrong loop** |
| `reentrancy-no-eth` | 2 | 2 benign-by-design (both are H-9's window; PR #98) |
| `uninitialized-local` | 2 | 2 safe |
| `missing-zero-check` | 2 | 2 by-design (C-1 root-only config) |
| `low-level-calls` | 2 | 2 by-design — **composition of the existing row is stale** |
| `too-many-digits` | 2 | 2 false positive |
| `cache-array-length` | 2 | 2 style (optimization impact) |
| `cyclomatic-complexity` | 1 | 1 style |

**Three corrections to this document, before the triage.** Each is a row that was right when
written and has since been overtaken by a remediation — the failure mode
[SPRINT10 §F-3](SPRINT10-DEPLOYMENT-REVIEW.md) warned about, where a disposition is believed
because it is written down.

1. **`assembly` says "Six sites". There are eight.** The M-11 returndata-bounding remediation
   rewrote `SafeTransferLib.safeTransfer/safeTransferFrom/safeApprove` off `token.call(...)` and
   onto two new assembly helpers, `_call2` (`src/lib/SafeTransferLib.sol#48-70`) and `_call3`
   (`#74-100`). Those are the two new blocks.
2. **`low-level-calls` no longer reports what its row says it reports.** The row enumerates
   "exactly these three by-design sites and nothing more" — `SafeTransferLib`'s three `token.call`s.
   Those three no longer exist as Solidity low-level calls (M-11 moved them inside `_call2`/`_call3`,
   where this detector cannot see them), so the count went 4 → 2 and the *composition* changed. The
   two live rows are `AggregationRouterAdapter.executeSwap`'s pinned-router `router.call`
   (unchanged, by design) and `ChainlinkOracle._requireUsdQuote`'s
   `feed.staticcall(description.selector)` — **which this document has never mentioned**. It is
   deliberate and correct: a raw `staticcall` is the only way to probe `description()` on a feed
   that may not implement it and reject rather than revert, and it checks both `ok` and
   `ret.length >= 96` before decoding (`src/oracle/ChainlinkOracle.sol#253-264`).
3. **`uninitialized-local` says "`k`, `perfFee`, `childValTotalWad`". `k` no longer fires** — 2 rows,
   not 3.

### `unused-return` — 11 rows, and the SafeTransferLib question answered rather than assumed

The first thing to check is the one this detector is genuinely dangerous for: **an ignored transfer
or approve success flag.** There is none, and that is verified here rather than inherited from the
row above. Each of `SafeTransferLib`'s three reverting wrappers consumes its helper's boolean:

```solidity
function safeTransfer(address token, address to, uint256 amount) internal {
    if (!_call2(token, 0xa9059cbb, to, amount)) revert TransferFailed(token);
}
```

`safeTransferFrom` and `safeApprove` have the identical shape (`src/lib/SafeTransferLib.sol#29-43`).
`_call2`/`_call3` return `ok` only when the call succeeded **and** returned either nothing
(USDT-style) or a well-formed `true`; 1–31 bytes is treated as failure. So no row here is a
swallowed flag — and Slither does not flag these at all, since they are internal and return nothing.

The 11 rows are three shapes:

| shape | rows | site |
| --- | --- | --- |
| `BoundedCall` `(ok, word, retSize)` with `retSize` (and usually `word`) discarded | 5 | `VaultCore` (5 sites) |
| `IExecutionAdapter.executeSwap`'s return discarded | 1 | `VaultCore.executeRebalance` |
| Chainlink / Uniswap tuple fields the caller does not need | 5 | `DirectPoolAdapter` (1), `ChainlinkOracle` (4) |

**Shape 1 — H-1 by design, and `ok` is captured at all five.** Slither fires on the *discarded*
members, not on `ok`. Four of the five use `ok` only to emit
`ModuleCallFailed` and continue, which is the point of H-1: a failing bookkeeping module forfeits
its own bookkeeping and can never block an exit.

The fifth is the interesting one — the `feeEngine` call in `_settleExit`, where the vault takes
the module's **value**:

```solidity
(bool feeOk, uint256 feeWord,) = address(feeEngine)
    .boundedCall(abi.encodeCall(IFeeEngine.onRealize, (member, gain, 0)), MODULE_CALL_GAS);
if (feeOk) perfFee = feeWord;
...
uint256 cap = gain / 10;
if (perfFee > cap) perfFee = cap;
```

Discarding `retSize` means a module returning **0 bytes** is indistinguishable from one returning a
fee of **0**, and a module returning **1–31 bytes** yields those bytes left-aligned in a word — one
byte `0xff` becomes roughly 2^255. `BoundedCall` zeroes the scratch word first (the L-3 fix), so the
value is deterministic, but it is still garbage.

**Invariant: `perfFee` lands in `[0, gain/10]` for every possible `feeEngine` response, and no
response can block the exit.** The clamp, not `retSize`, is the load-bearing line. Pinned by two new
tests in `test/ModuleHardening.t.sol` — `test_unusedRetSize_shortReturningFeeEngineCannotBlockAnExit`
and `test_unusedRetSize_emptyReturningFeeEngineChargesNoFee`. The existing
`test_m2_fullyInvestedVault_feeStillCollected` covered only a **well-formed** `type(uint256).max`, so
the short- and empty-returndata shapes were unpinned until now. Fail-open on empty returndata (fee 0,
member keeps it) is stated here rather than left implicit.

Both tests were graded by mutation, and the second mutation is the one that matters:

- **Delete the clamp** (`uint256 cap = gain / 10; if (perfFee > cap) perfFee = cap;`) and the
  short-return test fails with `panic: arithmetic underflow or overflow (0x11)` — the garbage
  `feeWord` drives `feeFracWad` high enough that `usdcPay -= usdcFee` underflows. The failure mode is
  therefore not "the fee is too big"; it is **the member cannot exit**, which is precisely the H-1
  property. The clamp is exit liveness, not just fee correctness.
- **"Fix" the Slither row the obvious way** — consume `retSize` and add
  `require(!feeOk || feeRet >= 32)` — and **both** new tests fail `BadConfig()` while all five
  pre-existing tests in the file still pass. That is the real justification for committing them: a
  module that answers short or empty would block a member's exit, re-breaking H-1, and until now
  nothing in the suite would have stopped that change from landing. **Anyone tempted to "close"
  this `unused-return` row should read those two tests first.**

**Shape 2 — EX-3, and the strongest row in the group.** `executeSwap`'s return is ignored *on
purpose*: `VaultCore.executeRebalance` measures `received` from the vault's own `balanceOf` delta and
requires `received >= o.minAmountOut`. Consuming the adapter's word would be the defect.

**Shape 3 — deliberate, documented in-code, and one is already pinned.** `priceWad` takes
`(answer, updatedAt)` and drops `roundId`/`startedAt`/`answeredInRound`; the
`answeredInRound < roundId` idiom is deprecated on Chainlink OCR feeds, and its absence is not a
staleness gap — the heartbeat check beside it is. The sequencer-uptime read drops that feed's `updatedAt`
with an in-code paragraph saying why (it is event-driven, so an unchanged `updatedAt` is health, not
staleness). The two constructor reads are **construction-time decode proofs**: the return is discarded
because the *decode* is the assertion, and Solidity's returndata-size check runs whether or not the
value is used. The sequencer-feed one is already pinned by
`test/audit/ChainlinkOracle.t.sol::test_constructor_decodeProofsSequencerFeed`, which feeds the
constructor a has-code-but-wrong-ABI sequencer feed and asserts the revert.

### `reentrancy-benign` — 6 rows, checked against `_fullNavWad` rather than against the mutex

The mutex argument is not sufficient on its own, and this document has twice been read as if it
were. Each row is checked against the question H-9 actually asks: **is the "benign" write observable
by a re-entrant *reader*, from a *different* contract?**

| # | site | write after the call | verdict |
| --- | --- | --- | --- |
| 1 | `FeeEngine.pullEscrowed:151` | `claimableFees[...] += received` | **Guarded — the row is stale.** This is M-3 and it is fixed: `pullEscrowed` is `nonReentrant` (`FeeEngine.sol:144`) on an engine-wide lock, chosen because the double-credit was a cross-*vault* nesting that a per-vault lock cannot see. Slither does not model the mutex, so the row will not clear. Pinned by `test/audit/AuditFeeEngineReentrancy.t.sol`. |
| 2 | `VaultCore.pullChildEscrow:863-864` | `idleUsdc += delta`, `assetBalance[asset] += delta` | H-9 window — see below. |
| 3 | `VaultFactory.createVault:187` | `allVaults.push(vault)` | Benign — push order only. |
| 4 | `VaultFactory.createChildVault:223` | `allVaults.push(vault)` | Benign — push order only. |
| 5 | `VaultCore._redeemChildMeasured:838-842` | `idleUsdc`, `assetBalance` credits | H-9 window — see below. |
| 6 | `VaultCore._settleExit` | `claimable[to][asset] += amount` via `_payOrEscrow` | Benign — `claimable` is not a NAV input. |

**Rows 2 and 5 are the H-9 shape, and #98's guard covers them — checked against #98's diff, not
against prose. As recorded on 2026-09-01 that guard was not yet on `protocol/main` and these two
windows were UNGUARDED. Correction 2026-09-02 (FixSlitherTriage): #98 merged 2026-09-01T22:30:54Z
as `8336677f`, an ancestor of `52d10aee`; `VaultCore.locked()` and
`test/audit/AuditReentrancyGuardCoverage.t.sol` are present. Whether that re-dispositions these two
rows is a re-derivation against the merged code and is deliberately not decided here.** In both, internal accounting is measured across a full external call
(`child.claimEscrowed`, `child.requestExit`), so between the call and the credit an **ancestor**
walking `_fullNavWad` reads an understated child. Both entry points are `nonReentrant`, so `_lock`
is 2 for the whole window, and #98 *proposes* `require(!v.locked(), Reentrancy())` at the **top of
`_fullNavWad` itself** — inside the recursion, not at the `_childValueWad` depth-1 entry point. That
placement is what makes it cover a *grandparent* reading through two levels, which is what these two
rows need; #98's own comment records that the hoisted variant "passes every depth-1 test and leaves
grandchildren exploitable". Dormant at launch regardless (`allowSubVaults = false`, C-1).

**Row 6 is benign for a reason worth stating: `claimable` is not a NAV input.** `navWad`
(`VaultCore.navWad:300-311`) sums `idleUsdc` + basket + children and never reads `claimable`. Escrowed
slices have already been debited from `assetBalance` in pass 1, so a re-entrant reader sees a vault
that has *already* given the slice away — understated in the direction of safety.

**Rows 3 and 4: the Sprint-10 reasoning holds, re-checked.** `allVaults` is append-only and read
only by `vaultCount()` and enumeration; nesting permutes push order and nothing else. Note that
`createVault`/`createChildVault` still carry **no** mutex, so this is genuinely "benign for a
different reason" and not an instance of the mutex row.

### `reentrancy-events` — 4 rows, one of which is REAL

| # | site | verdict |
| --- | --- | --- |
| 1 | `FeeEngine.onFeeCollected:106` | Benign. `claimableFees` is credited **before** `registry.recordFeeCollected` — CEI holds and only the event is late. `registry` is immutable and is the canonical `OperatorRegistry`. |
| 2 | `Governance.execute:592` | **REAL (Low, off-chain) — next section.** |
| 3 | `VaultFactory.createChildVault:224` | Benign. A nested `VaultCreated` gets a **lower** `logIndex`, the indexer folds ascending, and the handler is keyed on `args.vault` — a different address per event, so inner-first is order-insensitive. |
| 4 | `VaultFactory.createVault:188` | Benign, same argument. |

Rows 3 and 4 are the case the existing text asserts ("the indexer sorts by `(block, logIndex)`,
matching emission order"). Verified rather than assumed: `sortEvents`
(`packages/indexer/src/chain.mjs:46-48`) folds by `(blockNumber, logIndex)`, and the
`VaultCreated` handler in `projections.mjs` writes into `ensureVault(state, e.args.vault)`. Row 2 is where that same
argument breaks, because its handler is keyed on the **vault** while the event identifies a
**proposal**.

## REAL — `Governance.execute`'s late `Executed` event makes the indexer drop a live proposal

**Severity: Low. Off-chain only — chain state is correct throughout. Not fixed in this PR:** the fix
belongs in `packages/indexer`, which this triage does not own (SWARM §4).

**The chain half is not a bug.** `execute` sets `p.status = Status.Executed` **before** the three
`IVaultExecution(p.vault)` calls (`Governance.execute:583-590`), so there is no double-execution and CEI
holds. Only `emit Executed(pid)` is after.

**But that ordering has a second consequence nobody wrote down.** `_isSettled(Executed)` is `true`,
and `propose` requires only that the vault's current active proposal be *settled*
(`Governance.propose:278`). So a **nested `propose` reached through the external call succeeds**, and
`activeProposalOf[vault]` legitimately becomes a new pid while the outer `execute` is still on the
stack. The caller position is the one this repo already conceded for #101: not the router — pinned
and selector-allowlisted — but **a counterparty reached through the route**. Residual stated
honestly: that caller must itself hold at least `proposalThresholdBps` of
`pastVotingEligibleShares(nowTs - 1)` and clear `proposalCooldown`. `executeRebalance` is a
**root-vault** path, so unlike H-5/H-6/H-9 this is *not* dormant behind the C-1 sub-vault gate.

**The off-chain half is the bug.** The nested `Proposed` carries a **lower** `logIndex`, the indexer
folds **ascending**, and `Executed`'s handler zeroes the vault's active proposal without checking
which proposal it is zeroing:

```js
case 'Executed': {
  const p = state.proposals.get(Number(a.pid));
  if (p) { p.status = 'Executed'; state.activeProposal.set(p.vault, 0); }   // projections.mjs:246
  break;
}
```

`Proposed` applies first and sets `activeProposal[vault] = 2`; `Executed(1)` then clears it. The
projection reports `activeProposal: null` (`vaultView`, `projections.mjs:339-348`) while the chain says pid 2 is
`Active`, and it never self-heals — nothing re-sets the map until the *next* `Proposed`.

**Why it matters rather than being cosmetic.** `hasPendingExecution` is what decides whether a
member's exit settles Mode I or is queued Mode F. A member who checks the API or the web app for
"is a proposal live on this vault" is told **no** when the answer is **yes**, and has their exit
queued unexpectedly. Wrong in the direction that surprises the member — the same class of defect
#100 found when Mode F's opening phase was documented one phase late.

**Fix shape (validated on a scratch copy, deliberately not applied here).** A guarded write, applied
**uniformly** to all three settle handlers — `Finalized`, `Executed` and `ProposalExpired`. Only `Executed` is post-external-call today; the change is identical for
all three, and a uniform fix is the one that survives the next reordering.

```js
function clearActive(state, vault, pid) {
  if ((state.activeProposal.get(vault) ?? 0) === Number(pid)) state.activeProposal.set(vault, 0);
}
```

The failing repro, and the verification that this fix makes it pass **without breaking any of the 11
existing `projections.test.mjs` cases**, are in the PR body. The repro is deliberately **not**
committed: `npm run gate` globs `packages/indexer/test/*.test.mjs`, and a red gate is never
committed (SWARM §6/§7).

### `missing-inheritance` — 4 rows, now pinned instead of called cosmetic

Four contracts satisfy an interface's function set without inheriting it, so **the compiler never
compares them**:

| interface (declared in) | implementation | reached from |
| --- | --- | --- |
| `IVaultExecution` (`Governance.sol#7-11`) | `VaultCore` | `Governance.execute:583/584/590` |
| `IRegistryAttest` (`VaultFactory.sol#9-11`) | `OperatorRegistry` | `VaultFactory.createVault`, `createChildVault` |
| `ISubRegistryChild` (`VaultFactory.sol#13-15`) | `SubVaultRegistry` | `VaultFactory.createChildVault` |
| `IVaultDeployer` (`VaultFactory.sol#17-19`) | `VaultDeployer` | `VaultFactory._deploy` |

"Cosmetic, ABIs match" is the right verdict and the wrong stopping point: *nothing checks that they
still match.* Rename or re-type a parameter on either side and the tree compiles clean; the failure
is a runtime revert in `Governance.execute` or, worse, in `VaultFactory.createVault` — and
`VaultFactory` pins its `vaultDeployer` **immutably**, so a drift there bricks vault creation for
the life of that deployment.

It fails **closed** in every case — Solidity's high-level calls check returndata size, and none of
these contracts has a fallback — which is why this stays benign-by-design rather than becoming a
finding. But the invariant is now executable: `test/InterfaceSelectorDrift.t.sol` asserts
`IX.f.selector == Impl.f.selector` for all seven functions across the four interfaces. The `is`
clause is what would normally do this job; that test is its substitute.

**Graded by mutation, and the honest result is narrower than "nothing else catches it."** Two drifts
were injected:

- `VaultCore.allocateToChild(address, uint256)` → `(address, uint128)`, interface untouched: the
  **build fails**, because three audit tests call the concrete type. Existing coverage already
  catches this one.
- `SubVaultRegistry.registerChild(address, address, uint256)` → `(…, uint96)`, interface untouched:
  the tree **compiles clean** (that method is reached only through `ISubRegistryChild` from
  `VaultFactory.createChildVault`, and no test calls it concretely). `SubVaults.t.sol` then fails with
  `FAIL: EvmError: Revert  setUp()` — a bare revert, no attribution. The new test fails with
  `ISubRegistryChild/SubVaultRegistry: registerChild: 0x01f42bf7… != 0xbfd20864…`.

So the contribution here is **diagnosis rather than detection**, plus one real durability argument:
the coverage that catches the second drift lives in the **sub-vault** suite, and sub-vaults are
disabled at launch (C-1). Coverage of a dormant feature is exactly the coverage most likely to be
trimmed, and this test does not depend on it.

Stated limitation so nobody over-trusts it: a selector pin cannot see a **swap of two same-typed
parameters** — `attestVault(address vault, address operator)` and
`attestVault(address operator, address vault)` have identical selectors. Nothing in this repo
catches that, and an `is` clause would not either.

### `costly-loop` — 3 rows, and the row that dispositioned them named the wrong loop

All three rows are `idleUsdc` writes inside **`executeRebalance`'s orders loop** — `-= o.amountIn`
the three `executeRebalance` credits (`+= delta`, `+= received`, `+= refund`). The composite row above disposes of
`costly-loop` as "**accepted for the basket loop** (capped at 10)". That is a correct statement about
a loop these rows are not in. `executeRebalance` iterates `orders.length`, and **`orders.length` is
capped by nothing in the contract** — not `MAX_BASKET_ASSETS`, not `MAX_CHILDREN`, not
`MAX_LOOKTHROUGH_DEPTH`. Answering the question directly: the bound is the block gas limit and
calldata cost, and nothing else.

It is still not exploitable, for reasons about governance rather than about the loop:

- The orders are hashed into `actionHash` at **propose** time and re-checked at execute
  (`Governance.execute:572`) — voters approved *these* orders, including how many there are.
  (The re-check is the `keccak256(payload) == p.actionHash` require; this cell previously cited
  the status write two lines further on.)
- `execute` is permissionless, so whoever calls it pays. An oversized payload OOGs the *executor*,
  not the vault.
- Nobody is obliged to execute. A proposal that cannot be executed lapses at `expiresAt`, and
  `markExpired` settles it.
- The residual is the one every passed-but-unexecuted proposal already has: `hasPendingExecution`
  stays true until `expiresAt`, so exits are Mode-F-queued for the execution window. That is the
  designed cost of a live proposal, not a new lever, and it requires passing a vote first.

**Deliberately not changed:** hoisting `idleUsdc` into a memory local written once after the loop,
which is what the detector is asking for. It was not a free optimization while H-9/#98 was open, as of 2026-09-01 — the
current code writes each debit to storage *before* the external call, and caching would change what
a cross-contract reader observes mid-loop. Whether that change is an improvement or a regression is
exactly the question #98 decided (merged 2026-09-01 as `8336677f`), and this is not the PR to
re-open it in.

### `reentrancy-no-eth` — 2 rows

Both are already-registered ground; neither is new.

- **`executeRebalance`** — the H-9 window, stated exactly as in the `reentrancy-balance` section
  above: `assetBalance`/`idleUsdc` are cross-function-reachable via `navWad()`, a same-contract mutex
  is definitionally no defence against a *different* `VaultCore` reading them, and the fix is PR #98
  (merged 2026-09-01 as `8336677f`).
  Not dormant as a *code path* (root vaults do rebalance), but unexploitable at launch because
  `_fullNavWad` needs a parent/child pair and `allowSubVaults = false`.
- **`allocateToChild`** — `VaultCore(child).skipWindow()` precedes `idleUsdc -= amountUsdc`.
  Benign, and for a sharper reason than the mutex: during `skipWindow()` the parent **still holds**
  the USDC, so an un-decremented `idleUsdc` is *truthful*, not stale. Hoisting the debit above the
  call would **create** an understatement window rather than remove one. #98 documents this on the
  same line.

### `assembly` — 8 blocks, all by design, one stated-invariant gap

`via_ir = true` (`contracts/foundry.toml:7`), so `memory-safe` is load-bearing for the optimiser
rather than decorative. Every block was checked for the annotation, for bounds, and for reads past
calldata length (SWARM §5).

| block | annotation | bounded | invariant stated above it |
| --- | --- | --- | --- |
| `SafeTransferLib.tryTransfer#112-132` | `memory-safe` | at most one word copied | yes (H-2 / EE-6 natspec) |
| `SafeTransferLib._call2#49-69` | `memory-safe` | at most one word copied | yes (M-11 `@dev`) |
| `SafeTransferLib._call3#78-99` | `memory-safe` | at most one word copied | yes (M-11 `@dev`) |
| `BoundedCall.boundedCall#16-32` | `memory-safe` | `copy = min(retSize, 0x20)` | yes (library notice + inline L-3 comment) |
| `BoundedCall.boundedStaticCall#40-51` | `memory-safe` | same | **no natspec at all on this function** — style gap |
| `VaultDeployer.deploy#52-71` | `memory-safe` | see below | partial |
| `VaultDeployer._writeChunk#90-95` | `memory-safe` | `mcopy` of `len` into a `new bytes(11+len)` | yes (the opcode table above it) |
| `VaultDeployer._readChunk#102-104` | `memory-safe` | `extcodecopy` of exactly `len` into `new bytes(len)` | no comment — style |

**No block reads past calldata length.** The only calldata read anywhere in the eight is
`calldatacopy(add(p, add(la, lb)), ctorArgs.offset, ctorArgs.length)` in `VaultDeployer.deploy`, and
`ctorArgs` is a `bytes calldata` parameter, so Solidity's ABI decoder has already proved
`offset + length <= calldatasize()` before the block is entered.

**The one gap worth writing down: `VaultDeployer.deploy`'s revert path is not memory-safe in the
literal sense, and the annotation says it is.**

```solidity
if (iszero(vault)) {
    if (iszero(returndatasize())) { mstore(0, failed) revert(0, 4) }
    returndatacopy(0, 0, returndatasize())
    revert(0, returndatasize())
}
```

`returndatacopy(0, 0, returndatasize())` can write far past the 0x00–0x3f scratch space — over the
free-memory pointer at 0x40, the zero slot at 0x60, and arbitrary heap. Under
[SPRINT10 §3.5](SPRINT10-DEPLOYMENT-REVIEW.md) this was reviewed as "the revert-path memory clobber",
so it is known; it is recorded here as a **stated-invariant gap** rather than a defect, because the
clobber is *unconditionally* followed by `revert` **in the same block**, so no Solidity-managed
memory is ever read afterwards and the optimiser has no reordering it could observe. It is the
standard bubble-the-callee's-revert idiom. A second, smaller gap in the same block:
`mstore(0x40, add(p, n))` leaves the free-memory pointer **unaligned** whenever `n % 32 != 0`, which
is safe only because nothing allocates after it in this function. Both facts belong in a comment
above the block and are not there. **Style, reported not changed (SWARM §4).**

One bound worth naming since nothing else does: `_writeChunk` does `mstore(p, shl(168, header))`, a
full 32-byte store into an `11 + len` allocation, in-bounds only because
`len = creationCode.length / 2`, about 12,365. The PUSH2 in that header carries `len + 1`, so the
generated initcode is correct only for `len < 0xFFFF`. Both hold with two orders of magnitude of
margin, and both are compile-time determined — `VaultCore`'s creation code is never caller-supplied.
`Eip170.t.sol::test_deployerCreationCodeIsTheCompiledVaultCore` asserts the round trip byte for
byte, which is the real defence.

### `low-level-calls`, `too-many-digits`, `uninitialized-local`, `missing-zero-check` — 8 rows

- **`low-level-calls` x2** — by design; see correction 2 at the top of this section for what changed.
  `AggregationRouterAdapter.executeSwap:78` is the pinned-router call behind the selector allowlist
  and the measured-delta minOut (EX-3). `ChainlinkOracle._requireUsdQuote:265` probes
  `description()` with a raw `staticcall` **because** the feed may not implement it and the correct
  response is to reject rather than revert; it checks `ok && ret.length >= 96` before decoding.
- **`too-many-digits` x2** — false positive, unchanged in substance.
  `SafeTransferLib.tryTransfer#114` is the left-aligned 4-byte `transfer(address,uint256)` selector
  padded to a word, not a magic number (the row's line reference has moved from `#40` to `#114`).
  `VaultDeployer.constructor#36` is `type(VaultCore).creationCode`, a compiler-embedded ~24.7 KB blob
  that Slither renders as a numeric literal.
- **`uninitialized-local` x2** — safe. `childValTotalWad` (in `VaultCore._settleExit`) is a
  summation accumulator. `perfFee` (same function) deserves the second look, because it is *conditionally* assigned:
  `if (feeOk) perfFee = feeWord;`, so the zero default IS the value on the module-failure path — and
  that is the H-1 behaviour, not an oversight. The clamp runs over it either way.
- **`missing-zero-check` x2** — both are `subVaultRegistry_`, in `VaultCore`'s and `VaultFactory`'s
  constructors, and both are intentionally unguarded: `subVaultRegistry == 0` is the **valid** and,
  at launch, the **only** configuration (C-1 root-only — `VaultFactory._deploy` passes `address(0)`
  outright while `allowSubVaults` is false). Already stated in the Fixed table above; re-verified
  here rather than assumed.

### `cache-array-length` x2 and `cyclomatic-complexity` x1 — style

- **`cache-array-length`** (in `VaultCore.navWad` and `VaultCore._settleExit`) — both loops read
  `childVaults.length` from storage each iteration, and neither mutates the array. Caching is safe:
  the only writer is `allocateToChild`, which is `nonReentrant`, and both loops run either under that
  lock or in a `view`. Genuine optimization-impact rows, left alone under SWARM §4. **No fix is in
  flight** — `fix/slither-cache-array-length` is 0 commits ahead of `protocol/main`.
- **`cyclomatic-complexity`** — `_settleExit` at 31. Not a defect, and not fixable without splitting
  the function, which the EIP-170 margin does not obviously favour. Worth recording as an
  **audit-surface observation**: this is the single function carrying the most named remediations in
  the codebase (H-1, M-2, EE-6/EE-8/EE-9, SV-4/SV-5, L-1, and S6 findings 4 and 5), so its complexity
  measures how much has been fixed inside it rather than neglect. It is the right place for a human
  auditor to spend disproportionate time.

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

