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
| `reentrancy-no-eth`, `reentrancy-events`, `reentrancy-benign` | **False positive, but NOT for one reason — check the site before reusing this row.** The `VaultCore` functions flagged (`deposit`, `executeRebalance`, `_settleExit`, child flows) carry the `nonReentrant` mutex (shared lock, `_lock`), which Slither does not model. **This row has twice been read as "everything flagged carries the mutex", and twice that was false** — see the Sprint 10 and Sprint 14 corrections below. `FeeEngine.onFeeCollected` has no mutex, and **`Governance` has none anywhere**; both are benign by CEI, which is a different argument that has to be made separately. A blanket dismissal is how a real finding gets filed as noise. CEI + the single lock were proven sound in SPRINT1-SECURITY-REVIEW §"Reentrancy / CEI" and re-verified in the SPRINT6 execution review. The H-1 fix additionally makes every external module call on the exit path gas-bounded and non-blocking. **Sprint 10 correction:** `VaultFactory.createVault` / `createChildVault` are also flagged (a hostile settlement or basket token can reenter from `decimals()` during `VaultCore`'s constructor) and they carry **no** mutex — so the mutex reasoning above does not cover them. They are still benign, for a different reason: the factory's only state is the append-only `allVaults`, so nesting interleaves push order and nothing else; `VaultCreated` is emitted innermost-first and the indexer sorts by `(block, logIndex)`, matching emission order; and a nested attempt to register the still-constructing outer vault as a sub-vault parent fails, because `registerChild` calls `IVaultFees(parent).exitFeeMaxBps()` on a contract that has no code yet. Pre-existing — `new VaultCore(...)` made the same constructor calls — but Sprint 7's extra hop puts these rows in the output more prominently, so the reasoning is recorded rather than assumed. **AI-audit correction (§4.5):** the mutex reasoning is sound for SAME-contract reentrancy but does not cover **cross-contract read-only reentrancy** — a `VaultCore`'s public views are read as an oracle by its PARENT while the child is mid-mutation, and a per-contract mutex is definitionally not a defence against a different contract reading it (**H-9**). Slither does not model this either, so the row's blind spot and the analyser's coincide. **2026-09-01 correction — "false positive" is now disproved for this class, twice, and the dormancy argument is a configuration property rather than a code one.** (a) H-9 was filed PLAUSIBLE with *no executing test*; **#98 wrote one** — a parent pricing a mid-swap child reads an understated `_fullNavWad` and mints against it, **2,000e18 shares for 1,000 USDC** — so H-9 is a CONFIRMED, reproduced defect, not an analyser artefact. Slither never flagged H-9 itself — it cannot, the read is in a DIFFERENT contract — but the rows this line covers are the mutation windows H-9 reads through: `VaultCore._settleExit` and `_redeemChildMeasured` (`reentrancy-benign`), `executeRebalance` and `allocateToChild` (`reentrancy-no-eth`). (b) The sibling detector `reentrancy-balance` produced an outright **theft** at `AggregationRouterAdapter.executeSwap` (600e6 USDC extracted in test) — see the per-row section below; the class dismissal had held there too. **Status on `protocol/main` @ `29b1b470`, stated because this document has twice been read as describing code that had not landed:** #101 IS merged (`cf42c58a`) and both adapters carry a `nonReentrant` mutex. **As recorded on 2026-09-01, at `29b1b470`: #98 was then an open PR and H-9 was UNFIXED**; there was no `locked()` anywhere in `contracts/src` and no `test/audit/AuditReentrancyGuardCoverage.t.sol` at that commit, and the paragraph above was reasoned against that. **Correction 2026-09-02 (FixSlitherTriage) — branch state only:** #98 merged 2026-09-01T22:30:54Z as `8336677f`, which `git merge-base --is-ancestor 8336677f 52d10aee` confirms is an ancestor of `protocol/main`; `VaultCore.locked()` and `test/audit/AuditReentrancyGuardCoverage.t.sol` are both present there. **Whether H-9's disposition changes now that the guard has landed is deliberately NOT decided here** — that is a re-derivation against the merged code and belongs to whoever owns the H-9 row. H-9's disposition against the merged tree has since been re-derived separately and mutation-verified at `c3c789ba` (an ancestor of `52d10aee`), against the guard `VaultCore._fullNavWad:352` and its regressions `test/audit/AuditLookThroughReadOnlyReentrancy.t.sol` and `test/audit/AuditReentrancyGuardCoverage.t.sol`; **that re-derivation owns the row, not this document**. The original claim is restated above rather than deleted, in the past tense it should have been written in: a present-tense claim about branch state, written from intent rather than from `git`, has no expiry on its face and reads as current forever — which is how three documents went on asserting this one after #98 had merged. What remains true is the *launch* mitigation: H-9 needs a parent/child pair and sub-vaults are disabled at launch (`allowSubVaults = false`, C-1 gate) — but that is a property of the deployment CONFIG, undone by the first sub-vault, not a reason the detector was wrong. |
| `divide-before-multiply` | **By design for the payout legs.** The `a * b / ts * c / BPS` pattern in `_settleExit` loses precision **downward on purpose** — rounding favors the vault/remaining members, the algebraic condition for the §4.6 NAVps-non-decreasing invariant (SPRINT1 §4.6, fuzzed). **AI-audit correction (§4.5):** "rounds in the vault's favour" is not the same as "safe" — the same pattern at `:557` is what makes `:576`'s shortfall dust check unsatisfiable and reverts a member's child-backed exit (**H-6**). H-6 is a sub-vault-only path and is **dormant at launch** (root vaults only, C-1 gate; sub-vaults disabled), deferred with the sub-vault feature. Not a disposition change for the payout-leg rounding, but the "safe" generalization was too broad. |
| `unused-return` | **By design.** (a) The `boundedCall` results are intentionally best-effort (H-1): the `ok` flag is checked where liveness needs it and the rest ignored — a failing bookkeeping module must not block an exit. (b) `IExecutionAdapter.executeSwap`'s return is ignored because output is measured from the vault's OWN balance delta (EX-3), never the adapter's word. (c) `getReserves`/`latestRoundData` ignore fields the caller doesn't need (timestamp / round metadata). |
| `incorrect-equality` (x13) | **Triaged row by row on 2026-09-01 - see "`incorrect-equality`, thirteen rows" below.** The blanket "Safe" this replaces reached the right verdict on the wrong evidence: it cited "NAV never reads `balanceOf`, EE-1" as if that covered all thirteen rows, when only four of them are about NAV at all. No row is REAL; three now have executing tests.
| `uninitialized-local` | **Safe.** `k`, `perfFee`, `childValTotalWad` are accumulators intentionally relying on Solidity's zero-default before being summed. |
| `timestamp` | **Accepted (K-4 / by design)** for `Governance` and `Checkpoints`. The protocol uses `block.timestamp` as its only clock (commitment C-2, no block numbers); governance/staleness windows are minutes-to-days, far outside miner tolerance (~±15s). **+1 in Sprint 10:** `Checkpoints.push` same-second overwrite. **AI-audit correction (§4.5):** this row predated Sprint 11 and omitted `latestPrice` (`UniswapV3TwapSource.sol:282-292`), the one timestamp use with a security consequence (**H-2**). H-2 has since been **FIXED** (the constructor now requires `maxObservationAge <= window/20`; regression `AuditTwapRealCostModel.t.sol`), so the omission is closed. |
| `costly-loop`, `cache-array-length`, `cyclomatic-complexity` | **Accepted for the basket loop** (capped at 10). **`calls-loop` moved out of this row on 2026-09-01** — its 121 results are dispositioned cluster by cluster in "`calls-loop`, 121 rows, 23 sites, 9 clusters" below. The three detectors left here keep the disposition unchanged. **AI-audit correction (§4.5):** the "~237k gas" bound was measured on a 1-child/1-grandchild fixture (6 `priceWad` calls); the caps actually permit ~730 calls at the `MAX_CHILDREN` fan-out, so `navWad` is bounded in *shape* but unbounded in *cost* (**M-5**, ~12M gas at 8×8 vaults). M-5's fan-out requires sub-vaults, which are **disabled at launch** (root vaults only, C-1 gate), so at launch `navWad` loops only over the basket (≤10) and the original bound holds; M-5 is deferred with the sub-vault feature. The `NavGas.t.sol` sub-vault assertion is a fixture bound, not a proof of the worst case. |
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

*Can `totalShares == 0` while `navWad() > 0`?* If yes, the 1:1 re-open at `_mintShares:445` gives
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

## `calls-loop`, 121 rows, 23 sites, 9 clusters (triaged 2026-09-01)

`calls-loop` is the largest group in the output by a factor of four and had never been triaged row
by row — it was folded into a shared "accepted for the basket loop" disposition with three other
detectors. This section replaces the `calls-loop` half of that row.

**The 121 rows are 23 physical sites.** Slither emits one row per *entry-point call path* that
reaches a loop, not one per loop, so a single expression inside `_fullNavWad` appears eleven times
because eleven public functions reach it. The unit of judgement is therefore the site, and the unit
of disposition is the cluster of sites that share a bound and a callee. Counts below are from
`slither . --filter-paths "^lib/|^test/|^script/" --json -` at `protocol/main` @ `29b1b470`
(225 results total) and sum to 121 exactly.

| # | Cluster | Rows | Sites | Callee | Bound | Verdict |
| --- | --- | ---: | ---: | --- | --- | --- |
| A | Look-through NAV recursion — `_fullNavWad` (6 call sites) and `_holdingValueWad` (2) | 88 | 8 | child `VaultCore` public views | `MAX_CHILDREN` 8 × registry depth × `MAX_BASKET_ASSETS` 10 | **BENIGN AT LAUNCH** (conditional — see below) |
| B | `_assetValueWad` → `oracle.priceWad` | 12 | 1 | immutable, factory-blessed oracle | `MAX_BASKET_ASSETS` = 10 | **BENIGN BY DESIGN** (K-4 fail-closed) |
| C | `_bal` → `balanceOf` | 3 | 1 | basket ERC-20 / USDC | 10 (+ USDC) | **BENIGN BY DESIGN**, conditional on basket curation |
| D | Child exit/redeem legs — `_redeemChildMeasured` (2 call sites), `_childPendingExecution`, `_settleExit` | 8 | 4 | child `VaultCore` | `MAX_CHILDREN` = 8 | **BENIGN AT LAUNCH** (same gate as A) |
| E | `VaultFactory._requireOracleCoversBasket`, `createChildVault` | 3 | 2 | oracle / parent vault | caller-supplied array | **STYLE** |
| F | `SubVaultRegistry` ancestor walks — `registerChild`, `stackedExitFeeCapBps` | 2 | 2 | `IVaultFees.exitFeeMaxBps` | ancestor chain, `MAX_DEPTH` = 3 | **BENIGN BY DESIGN** |
| G | `VaultCore` constructor → `decimals()` | 1 | 1 | basket ERC-20 | length checked ≤ 10 *before* the loop | **STYLE** |
| H | `executeRebalance` → `adapter.executeSwap` | 1 | 1 | allowlisted adapter | **`orders.length` unbounded** | **BENIGN BY DESIGN**, with a recorded residual |
| I | `ChainlinkOracle` constructor (3 call sites) | 3 | 3 | Chainlink feeds | deploy-time admin arrays | **STYLE** |
| | **Total** | **121** | **23** | | | |

**No cluster is REAL.** The reason is structural and worth stating once: *every* loop bound in this
contract set is either an immutable compile-time constant or a governance-gated counter. There is no
loop over members, holders, or the exit queue anywhere in `src/` — all 20 `for` sites and all three
`while` sites were enumerated to confirm it (the third `while`, `Checkpoints.getAt:39`, is a binary
search with no external call, which is why it produces no `calls-loop` row). That is a stronger
property than a bound: the classic `calls-loop` DoS — spam the array, brick the loop — has no array
to spam.

### A — the look-through recursion (88 of 121 rows)

The bound is three constants, all `public constant` in `VaultCore`: `MAX_CHILDREN = 8`,
`MAX_LOOKTHROUGH_DEPTH = 3` and `MAX_BASKET_ASSETS = 10`.

**No untrusted party can grow it.** `childVaults` is pushed in exactly one place —
`allocateToChild` — which requires `msg.sender == address(governance)`, requires a
creation-time registry edge (`parentOf(child) == address(this)`), and enforces
`childVaults.length < MAX_CHILDREN`. `registerChild` is factory-only, and `createChildVault`
additionally requires `msg.sender == parent.creator()`.

One asymmetry worth naming, because it looks like a hole and is not: **`registerChild` has no
fan-out cap of its own.** A parent's creator can register a ninth, or a nine-hundredth, child edge
in the registry. `MAX_CHILDREN` bites only in `allocateToChild` — and `childVaults`, the array the
loop actually walks, is only appended there. So the registry may hold arbitrarily many edges while
the looped array stays capped at 8. The bound is on the funded set, which is the set NAV prices.
Pinned by `AuditCallsLoopMaxBound::test_childVaultsCannotBeGrownByAnUntrustedCaller`, which creates
a ninth child successfully and then shows `allocateToChild` refusing it with `TooManyChildren`.

**At the launch configuration these 88 rows execute zero iterations, and the gate is per-vault
immutable state rather than a factory flag.** `VaultFactory._deploy:250` passes
`allowSubVaults ? subVaultRegistry : address(0)` into the `VaultCore` constructor, so with
`allowSubVaults == false` every vault carries `subVaultRegistry == address(0)` in its own immutable
storage. `allocateToChild`'s first `require` then fails on state the vault holds itself,
independently of any later factory or registry. That is the fact an auditor can verify per vault
on-chain, and it is a stronger statement than "`createChildVault` reverts".

**This disposition is conditional, not permanent.** It holds *because* `allowSubVaults == false`,
which is a deployment parameter, not code. Enabling sub-vaults re-opens **M-5** — `navWad` bounded
in shape but not in cost — on the same day. The disposition must be re-read, not inherited, at that
point.

**The registry, not the look-through constant, is what actually bounds the fan-out.**
`MAX_LOOKTHROUGH_DEPTH = 3` admits three descendant levels (8 + 64 + 512 = 584 nodes, ~5,850
`priceWad` calls). `SubVaultRegistry.MAX_DEPTH = 3` is "levels including root" and `registerChild`
requires `parentDepth + 1 < MAX_DEPTH`, so `depthOf ∈ {0,1,2}` and only **two** descendant levels
can exist (8 + 64 = 72 nodes, ~730 `priceWad` calls). The previously recorded ~730 figure is
correct, and it is correct because of the registry. A backstop looser than the constraint it backs
up is worth knowing about: if the registry cap ever moves, the look-through constant will not catch
it at the value a reader would expect.

Measured at the structural maximum (8 × 8 × 10, 73 vaults, every one fully funded on all ten
assets) in `test/audit/AuditCallsLoopMaxBound.t.sol`: **`navWad()` costs 10,402,702 gas** on
`protocol/main` @ `52d10aee`, pinned to ±1% of `NAV_GAS_MEASURED = 10_402_702` and additionally
held under a `NAV_GAS_CEILING` of 11,200,000.

The ceiling is a **coarse regression fence, not a tight pin** — a round number under the block
limit, sitting 7.7% above the measurement, so a regression of up to ~797k gas on the protocol's
most expensive path would pass it. That is why the ±1% assertion against the measured value
exists: the first recorded figure here was 10,108,782, a merge of `protocol/main` moved it +2.9%
within a day, and nothing turned red. A measured number in prose is a citation, and it drifts the
same way a line number does.

**This is the first measurement of M-5 rather than an estimate of it, and it substantially confirms
the recorded figure.** The register carried "~12M gas at 8×8 vaults"; the measured number is 10.4M —
about 13% lower, same order, same conclusion. The estimate was sound and is now evidence.

Two things make 10.4M worse than it looks, not better. First, it is a **floor**: the fixture prices
through the production `ChainlinkOracle` but against *mock* aggregators, and a live Chainlink read
goes proxy → aggregator with cold storage on each hop, so real feeds cost strictly more. Second, it
is **transaction gas, not a free `eth_call`** — `navWad` sits on the `deposit`, `activate`,
`requestExit` and `settleQueuedExit` paths, so a member pays it to enter or leave. At that cost a
single NAV read consumes a large fraction of a Base block, which is the substance of M-5: bounded in
shape, and expensive enough in cost that the deposit and exit paths become the concern. The
pre-existing
`NavGas.t.sol` bound (~237k, `< 600_000`) is a 1-child/1-grandchild/3-asset fixture and, as this
document already noted, is a fixture bound rather than a proof of the worst case; the new test is
the proof. Its ceiling is set tight enough that raising `MAX_CHILDREN` or `MAX_LOOKTHROUGH_DEPTH`
breaks it.

### B — the oracle read inside the basket loop (12 rows)

Twelve rows, one expression: `_assetValueWad` is `amount * oracle.priceWad(asset) /
assetUnit[asset]`, reached from twelve public entry points including `deposit`, `activate`,
`requestExit`, `settleQueuedExit` and `executeRebalance`.

`ChainlinkOracle.priceWad` fails closed per asset: an unlisted asset, a reverting feed, a
non-positive or future-stamped answer, an answer past its heartbeat, or one outside the sane-price
band all `revert StaleOracle(asset)`. There is **no `try`/`catch` and no gas cap** at
`_assetValueWad`. So **one stale feed on one funded basket asset freezes every path in the vault,
including exits.** That is intended and is stated in two places already: `navWad`'s natspec
("Reverts while the oracle breaker is tripped — freezing everything, including exits, by design
(K-4)") and `VaultFactory._requireOracleCoversBasket`'s comment ("a feed that later goes stale or
gets deprecated still freezes the vault — the accepted single-provider tradeoff, K-4/SF-2").

The bound is `MAX_BASKET_ASSETS = 10`, checked in the constructor *before* its loop, and
`basketAssets` is never written after construction. The oracle is immutable and C-6-blessed.

**What makes this benign rather than a griefing vector is EE-1, and it deserves to be explicit.**
`navWad` prices only assets with a non-zero *internal* `assetBalance`, and there is no
permissionless path that credits `assetBalance`. The writes are `executeRebalance` (governance),
`_redeemChildMeasured` (governance-gated `credit` flag), and `pullChildEscrow` — which is
permissionless but requires `isChildVault[child]` and moves value out of a registered child's
escrow, not from a caller-supplied transfer. **A donation of a basket token to the vault credits
nothing**, because NAV reads `assetBalance` and never `balanceOf`. So an attacker cannot pick the
one basket asset whose feed is dead, donate a wei of it, and freeze the vault. Pinned by
`test/audit/AuditCallsLoopFailClosed.t.sol`:
`test_oneDeadFeedOnAFundedAssetFreezesTheWholeVault`,
`test_deadFeedOnAZeroBalanceAssetDoesNotFreezeTheVault`, and
`test_donatingTheDeadFeedTokenDoesNotFreezeTheVault`.

One coherence note, because the escrow machinery reads like a general liveness answer and is not one
here: the oracle revert fires in `_assetValueWad` **before** any transfer, so EE-6 escrow
degradation and `MODULE_CALL_GAS` bounding are both downstream of it. Neither is a defence against
an oracle outage.

### C — `balanceOf` inside the measured-delta loops (3 rows)

`_bal` is `IERC20Metadata(token).balanceOf(address(this))` with **no gas cap** — unlike every
payout leg, which goes through `_payOrEscrow` → `tryTransfer(..., MODULE_CALL_GAS)`. A basket
token that consumes all remaining gas in `balanceOf` therefore bricks `executeRebalance` and
`_redeemChildMeasured`, and the constructor's `IERC20Metadata(a).decimals()` probe proves
nothing about `balanceOf` — pinned by
`AuditCallsLoopFailClosed::test_constructorDecimalsProbeDoesNotProveBalanceOfIsSafe`, which shows
such a vault constructs successfully.

The basket is chosen by the vault creator at construction and is immutable, so this is a curation
assumption and not a code guarantee. Stating it plainly rather than folding it into "tokens are
curated": **the entire defence for cluster C is that the creator did not pick a hostile token.**

### D — the child exit and redeem legs (8 rows)

`_redeemChildMeasured` calls `VaultCore(child).requestExit` and reads `queuedExitShares` inside the
shortfall loop; `_childPendingExecution` and `_settleExit` :633 read child views in the same loop.
Bound is `MAX_CHILDREN = 8` and the callee is a registry-admitted, factory-deployed `VaultCore` —
same gate and same launch reasoning as cluster A, so the same conditional disposition applies. Note
these calls are *mutating* (`requestExit`), not views: the loop is already defended against a child
that queues rather than settles (`ChildSettlementPending`, and the Finding-4 `continue` over children with a pending execution),
which is exit-liveness handling rather than DoS surface.

### E, G, I — the deploy-time and creation-time loops (7 rows)

`VaultFactory._requireOracleCoversBasket` and the `createChildVault` subset check loop
over a **caller-supplied** `basketAssets` array with no length check of their own; `VaultCore`'s
`≤ MAX_BASKET_ASSETS` require lives in the constructor, which for the :214 loop runs *after* it. The
`ChainlinkOracle` constructor loops (:184, :199, :254) are over deployer-supplied arrays. In all
cases an oversized array costs the caller their own gas and nothing else — no other party's
transaction is affected, and no state survives the revert. `_requireOracleCoversBasket` additionally
wraps its call in `try`/`catch`. **STYLE**; adding a length guard would be a readability
improvement, not a fix.

### F — the `SubVaultRegistry` ancestor walks (2 rows)

Both are `while (a != address(0))` walks up `parentOf`, calling `IVaultFees(a).exitFeeMaxBps()`.
Neither has a numeric bound in its own body — the bound is an invariant of the registry, which is
worth writing down because it is not local:

1. `registerChild` is **factory-only** and enforces `parentDepth + 1 < MAX_DEPTH`, so any chain is
   at most 3 long.
2. `parentOf` can never cycle, because the only caller (`VaultFactory.createChildVault`) always
   passes a **freshly deployed** `vault` as `child`, and `registerChild` refuses a child that is
   already registered. A cycle would require registering a pre-existing vault as a child of its own
   descendant, which no caller can construct.

Point 2 is the load-bearing one and is exactly what a future admin-callable `registerChild` would
silently break. Pinned by `AuditCallsLoopMaxBound::test_registryCapsDescendantLevelsAtTwo…`.

### H — `executeRebalance`'s unbounded `orders` array (1 row)

`orders.length` has **no bound** (`VaultCore.executeRebalance:891`). The function is governance-only and the
adapter is allowlisted, so no untrusted party reaches it — which is why this is not REAL. The
residual is nonetheless larger than "the proposer wastes gas", and it was verified rather than
assumed:

`Governance.execute` writes `p.status = Status.Executed` at `Governance.execute:574` and makes the
external `executeRebalance` call at `Governance.execute:590` — *after* the write. An out-of-gas inside the loop
therefore reverts the whole transaction and unwinds the status write, leaving the proposal `Passed`.
`hasPendingExecution` then returns `block.timestamp <= p.expiresAt` (`Governance.hasPendingExecution:630`), which keeps the
vault in Mode F: `requestExit` queues and `settleQueuedExit` reverts. So a rebalance proposal that
is too large to execute **traps every exit in the vault for the remainder of its execution window**.

Bounded, and that is the difference from the permanent freeze in
`test/audit/AuditExecutionWindowFreeze.t.sol`: `EXECUTION_WINDOW_HARD_CAP = 90 days`, and
`markExpired` is permissionless once the window lapses. Recorded as an out-of-scope
recommendation rather than fixed here (SWARM §4): a `require(orders.length <= MAX_ORDERS)` in
`executeRebalance` would make the failure mode a rejected proposal instead of a Mode-F window.

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
