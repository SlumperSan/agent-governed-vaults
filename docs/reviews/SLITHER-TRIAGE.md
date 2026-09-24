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
| `missing-zero-check` | `OperatorRegistry.wire`, `SubVaultRegistry.wire`, `Governance.wireSubVaultRegistry` | Added `ZeroAddress`/`ZeroSubRegistry` guards — a fat-finger deploy can no longer wire the trust anchor to `address(0)`. (VaultCore/VaultFactory `subVaultRegistry == 0` is a VALID config — root-only vaults, now the launch default per C-1 — so those are intentionally *not* guarded.) **AI-audit note (§4.5):** benign scope gap — `VaultCore`'s constructor also zero-checks none of `operatorRegistry_`, `governance_`, `feeEngine_`, `oracle_`. Specific silent failure to record: a zero `governance` makes `boundedStaticCall` succeed with `retSize == 0`, so `_pendingExecution` returns `false` permanently and the H-1 fallback silently masks a mis-wired vault as "always Mode I". The canonical factory always wires real modules, so this bites only a hand-rolled deployment; recorded, not a code change. **Reconciled 2026-09-24 (card 134):** the analyser currently reports exactly 4 `missing-zero-check` rows — the two `subVaultRegistry_` sites the parenthetical above already covers, plus `IdentityGate.hasIdentity(address).agent` and `IdentityGate.agentIdOf(address).agent`. Both are VIEW-function query parameters, never stored and never mutate state; `address(0)` is a legitimate "no identity" input that simply returns not-found. Accepted by design, not a code change. |
| `unindexed-event-address` | `OperatorRegistry.FactorySet/FeeEngineSet` | Made the address params `indexed` for off-chain filtering. |
| `redundant-statements` | `FeeEngine.onRealize` | Removed the `lossUsdc;` no-op; the param is now unnamed (`uint256 /*lossUsdc*/`). |

## Accepted (false positive or by-design — verified against the code and prior reviews)

| Detector | Disposition |
| --- | --- |
| `reentrancy-balance` (High ×8) | **Triaged row by row on 2026-09-01 — see "reentrancy-balance, eight rows, four sites" below.** The blanket "false positive" in the row beneath is what this replaces: it was right about same-contract reentrancy and wrong to stop there. One row is a real, reproduced defect (`AggregationRouterAdapter`, 600e6 USDC extracted in test); four are the cross-contract read-only window already registered as **H-9** — described here as "unfixed on `protocol/main`", which was true when this row was triaged and is **no longer**: PR #98 merged 2026-09-01, hours after this row was written, and `_fullNavWad` now carries `require(!v.locked(), Reentrancy())` (`VaultCore.sol:357`). The change itself is `0e70ea69`. See the dated correction in the section below. |
| `reentrancy-no-eth`, `reentrancy-events`, `reentrancy-benign` | **False positive, but NOT for one reason — check the site before reusing this row.** The `VaultCore` functions flagged (`deposit`, `executeRebalance`, `_settleExit`, child flows) carry the `nonReentrant` mutex (shared lock, `_lock`), which Slither does not model. **This row has twice been read as "everything flagged carries the mutex", and twice that was false** — see the Sprint 10 and Sprint 14 corrections below. `FeeEngine.onFeeCollected` has no mutex, and **`Governance` has none anywhere**; both are benign by CEI, which is a different argument that has to be made separately. A blanket dismissal is how a real finding gets filed as noise. CEI + the single lock were proven sound in SPRINT1-SECURITY-REVIEW §"Reentrancy / CEI" and re-verified in the SPRINT6 execution review. The H-1 fix additionally makes every external module call on the exit path gas-bounded and non-blocking. **Sprint 10 correction:** `VaultFactory.createVault` / `createChildVault` are also flagged (a hostile settlement or basket token can reenter from `decimals()` during `VaultCore`'s constructor) and they carry **no** mutex — so the mutex reasoning above does not cover them. They are still benign, for a different reason: the factory's only state is the append-only `allVaults`, so nesting interleaves push order and nothing else; `VaultCreated` is emitted innermost-first and the indexer sorts by `(block, logIndex)`, matching emission order; and a nested attempt to register the still-constructing outer vault as a sub-vault parent fails, because `registerChild` calls `IVaultFees(parent).exitFeeMaxBps()` on a contract that has no code yet. Pre-existing — `new VaultCore(...)` made the same constructor calls — but Sprint 7's extra hop puts these rows in the output more prominently, so the reasoning is recorded rather than assumed. **AI-audit correction (§4.5):** the mutex reasoning is sound for SAME-contract reentrancy but does not cover **cross-contract read-only reentrancy** — a `VaultCore`'s public views are read as an oracle by its PARENT while the child is mid-mutation, and a per-contract mutex is definitionally not a defence against a different contract reading it (**H-9**). Slither does not model this either, so the row's blind spot and the analyser's coincide. H-9 requires a parent/child pair and is therefore **dormant at launch** (root vaults only, C-1 gate) — that half stands. It was also described here as "deferred with the sub-vault feature", which is **no longer true**: it was FIXED IN CODE on 2026-09-01 (`0e70ea69`, `require(!v.locked(), Reentrancy())` at `VaultCore.sol:357`) and is not waiting on the feature. See the dated correction below. |
| `divide-before-multiply` | **By design for the payout legs.** The `a * b / ts * c / BPS` pattern in `_settleExit` loses precision **downward on purpose** — rounding favors the vault/remaining members, the algebraic condition for the §4.6 NAVps-non-decreasing invariant (SPRINT1 §4.6, fuzzed). **AI-audit correction (§4.5):** "rounds in the vault's favour" is not the same as "safe" — the same pattern at `:557` is what makes `:576`'s shortfall dust check unsatisfiable and reverts a member's child-backed exit (**H-6**). H-6 is a sub-vault-only path and is **dormant at launch** (root vaults only, C-1 gate; sub-vaults disabled), deferred with the sub-vault feature. Not a disposition change for the payout-leg rounding, but the "safe" generalization was too broad. |
| `unused-return` | **By design.** (a) The `boundedCall` results are intentionally best-effort (H-1): the `ok` flag is checked where liveness needs it and the rest ignored — a failing bookkeeping module must not block an exit. (b) `IExecutionAdapter.executeSwap`'s return is ignored because output is measured from the vault's OWN balance delta (EX-3), never the adapter's word. (c) `getReserves`/`latestRoundData` ignore fields the caller doesn't need (timestamp / round metadata). |
| `incorrect-equality` | **Safe.** All flagged `==` are on share counts / status enums / `totalShares == 0` first-deposit and sole-holder checks — exact-value comparisons, not balance-of equality that a donation could grief (NAV never reads `balanceOf`, EE-1). **+1 in Sprint 10** (newly visible, `src/lib/Checkpoints.sol#23`): `h.arr[len-1].ts == uint64(block.timestamp)` in `push`. The strict equality is the point of the line — it detects "a checkpoint already exists for this exact second" and overwrites it instead of appending a duplicate (the standard OZ `Checkpoints` idiom). A range or `>=` comparison here would corrupt history, not harden it. |
| `uninitialized-local` | **Safe.** `k`, `perfFee`, `childValTotalWad` are accumulators intentionally relying on Solidity's zero-default before being summed. |
| `timestamp` | **Accepted (K-4 / by design)** for `Governance` and `Checkpoints`. The protocol uses `block.timestamp` as its only clock (commitment C-2, no block numbers); governance/staleness windows are minutes-to-days, far outside miner tolerance (~±15s). **+1 in Sprint 10:** `Checkpoints.push` same-second overwrite. **AI-audit correction (§4.5):** this row predated Sprint 11 and omitted `UniswapV3TwapSource._observe` (`UniswapV3TwapSource.sol:255` as it then stood), the one timestamp use with a security consequence (**H-2**). H-2 has since been **FIXED** (the constructor now requires `maxObservationAge <= window/20`; regression `AuditTwapRealCostModel.t.sol`), and the contract itself no longer exists — the Chainlink-direct pivot (C-6) deleted `UniswapV3TwapSource.sol`, so that citation is history, not a location. The omission is closed. **Per-row re-triage correction (2026-09-01):** the class verdict answered "is every comparison outside miner tolerance?" (yes) and never asked "is each comparison against the right clock?". One is not — `Governance.applyStandingDefault` measures the VO-3 standing-default TTL against `block.timestamp`, but it is callable only from the reveal phase, so the commit phase consumes part of the 72h and `commitDuration >= DEFAULT_TTL` (legal until now) killed VO-3 outright for that vault. **T-1, Low, FIXED** in the PR that added this sentence: `COMMIT_HARD_CAP` is now `DEFAULT_TTL - 1`. Regression `AuditStandingDefaultTtlVsCommit.t.sol`. |
| `calls-loop`, `costly-loop`, `cache-array-length`, `cyclomatic-complexity` | **Accepted for the basket loop** (capped at 10). **AI-audit correction (§4.5):** the "~237k gas" bound was measured on a 1-child/1-grandchild fixture (6 `priceWad` calls); the caps actually permit ~730 calls at the `MAX_CHILDREN` fan-out, so `navWad` is bounded in *shape* but unbounded in *cost* (**M-5**, ~12M gas at 8×8 vaults). M-5's fan-out requires sub-vaults, which are **disabled at launch** (root vaults only, C-1 gate), so at launch `navWad` loops only over the basket (≤10) and the original bound holds; M-5 is deferred with the sub-vault feature. The `NavGas.t.sol` sub-vault assertion is a fixture bound, not a proof of the worst case. |
| `low-level-calls` | **By design.** `AggregationRouterAdapter.executeSwap` — the pinned-router call behind the selector allowlist + measured-delta minOut (EX-3). **+3 in Sprint 10** (newly visible): `SafeTransferLib.safeTransfer` / `safeTransferFrom` / `safeApprove`, each a `token.call(abi.encodeWithSelector(...))`. The low-level form is the whole point — it tolerates non-standard ERC-20s that return nothing or malformed data instead of reverting on them (H-2), which a high-level call cannot do. Every one checks `ok` and validates the return payload. Reviewed in SPRINT1; before Sprint 10 the analyser had never actually seen them (banner above), and now that it has, it reports exactly these three by-design sites and nothing more. **Reconciled 2026-09-24 (card 134):** those three SafeTransferLib sites no longer appear here — M-11 (see the `assembly` row below) moved `safeTransfer`/`safeTransferFrom`/`safeApprove` off plain `.call()` onto bounded inline assembly, so they now trip `assembly` instead. In their place: `IdentityGate.hasIdentity` and `IdentityGate.agentIdOf` (`staticcall` to the ERC-8004 identity registry, `ok`/`data.length` checked, documented NatSpec "fails open" — returns not-found rather than reverting) and `ChainlinkOracle._requireUsdQuote` (constructor-only `staticcall` probing `description()`, `ok`/length checked, fails CLOSED via `require`). Same "checked `ok`, validated the payload" class as the rest of this row — by design, not a code change. |
| `missing-inheritance` | **Cosmetic.** Interface-shaped contracts that don't formally `is` the interface; ABIs match. Sprint 7 added one instance: `VaultDeployer` vs `IVaultDeployer` (declared inside `VaultFactory.sol`). Same disposition — the single `deploy(bytes) returns (address)` selector matches, and `Eip170::test_factoryPinsItsDeployerImmutably` plus every factory-path test exercise the call across the interface. |
| `assembly` | **By design.** Six sites. **Three newly visible in Sprint 10** and predating it by far — `BoundedCall.boundedCall`, `BoundedCall.boundedStaticCall` (gas-bounded, returndata-capped module calls, the H-1 fix) and `SafeTransferLib.tryTransfer` (non-reverting transfer, the H-2 fix); all three were reviewed by hand in SPRINT1-SECURITY-REVIEW, which is where those fixes were designed. **Three from Sprint 7**, all in `VaultDeployer`: the SSTORE2 `_writeChunk` header, the `CREATE` in `deploy`, and `_readChunk`'s `extcodecopy`. This contract exists *because* the work cannot be expressed in Solidity — `type(VaultCore).creationCode` has to be relocated out of the factory's runtime (#10). All three blocks were reviewed opcode by opcode in [SPRINT10-DEPLOYMENT-REVIEW §3.5](SPRINT10-DEPLOYMENT-REVIEW.md), including the `memory-safe` annotations and the revert-path memory clobber. **Reconciled 2026-09-24 (card 134), +2, eight sites now:** `SafeTransferLib._call2` and `_call3` — the **M-11 remediation** referenced in the `SafeTransferLib` header comment. `safeTransfer`/`safeTransferFrom`/`safeApprove` used to do `token.call(...)`, copying the ENTIRE returndata buffer into memory, so a returndata-bombing token could OOG every one of them (the same MO-2 hardening `tryTransfer` already had, that these three didn't). Both helpers now use the identical bounded-copy, `memory-safe` assembly shape as `tryTransfer` — same pattern, same review standard, one detector class later. |
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

**Reconciled 2026-09-24 (card 134) — a fifth site, nine rows now.** `UniswapV3Adapter.executeSwap`
also fires `reentrancy-balance` and was never added to this table. Read 2026-09-24
(`contracts/src/UniswapV3Adapter.sol`): same shape as `DirectPoolAdapter.executeSwap` below —
`nonReentrant`, measured-balance-delta settlement (EX-3) — and it already carries the *scoped*
refund (`min(inAfter - inBefore, amountIn)`) that `AggregationRouterAdapter` needed a dedicated fix
for; it was written after that fix existed. Same verdict as `DirectPoolAdapter.executeSwap`: not
real as an exploit, guarded anyway.

| Site | Rows | Verdict |
| --- | --- | --- |
| `VaultCore.executeRebalance` (`executeSwap` at :870) | 4 | **Not real as flagged; real in a dimension the detector does not model.** |
| `VaultCore._settleExit` → `_redeemChildMeasured(…, false)` (:635) | 1 | **Not real.** |
| `DirectPoolAdapter.executeSwap` (both `pair.swap` branches) | 2 | **Not real as an exploit; guarded anyway.** |
| `AggregationRouterAdapter.executeSwap` (`router.call`) | 1 | **REAL — fixed.** |
| `UniswapV3Adapter.executeSwap` | 1 | **Not real as an exploit; guarded anyway — reconciled 2026-09-24.** |

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
*mutating* path (share minting). That is [`AI-AUDIT-REPORT.md` H-9](../audit/AI-AUDIT-REPORT.md).

> **FIXED — correction 2026-09-04.** The two sentences that followed carried three claims: that
> H-9 was "unfixed on `protocol/main`", that the fix was "written and in review as PR #98", and
> that "`_fullNavWad` is unreachable on the launch configuration". The first two are withdrawn as
> false; the third was true and is restated below rather than dropped.
>
> **PR #98 merged 2026-09-01T22:30:54Z** (merge commit `8336677f`), hours after this row was
> triaged at 19:47 UTC, so both claims went stale the same day they were written. The change
> itself is `0e70ea69` — the commit that introduced `locked()` and the `require`, and an ancestor
> of `protocol/main`. Cite `0e70ea69` to read the fix, `8336677f` for when it landed.
>
> On `protocol/main` today: `VaultCore.locked()` exists (`VaultCore.sol:161`, `return _lock != 1`)
> and `_fullNavWad` refuses to price a locked descendant — `VaultCore.sol:357`,
> `require(!v.locked(), Reentrancy())`. The substitution of "locked" for "mid-write" is sound only
> while **every state-mutating external on `VaultCore` is `nonReentrant`**; that invariant is
> stated at `locked()` and enforced by `test/audit/AuditReentrancyGuardCoverage.t.sol`, which
> enumerates the compiled ABI and fails when a mutating external appears outside its register.
> Adding one without the modifier silently reopens H-9 at full severity.
>
> **The dormancy argument is unchanged in substance and moved into this block** — it was the third
> of those claims, carried by the second sentence, and it is still independently true, so H-9 was never
> reachable at launch either way: `Deploy.s.sol` constructs the mainnet factory with
> `allowSubVaults = false` (C-1, root vaults only), so on that factory `createChildVault` reverts,
> `childVaults` stays empty and `_fullNavWad`'s child leg is never reached. Note this is a
> per-factory property — `DeployTestnet.s.sol` passes `true`, which is what lets the SV-* soak
> drills exercise the path at all.

The reproduction that accompanied the fix mints 2,000e18 shares for 1,000 USDC.

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
any one caller — see the next row for what the same shape cost when the sibling adapter *did* sweep
its whole balance (it no longer does). `test_directPoolAdapterRefusesNestedSwap` pins it.

**Checked again 2026-09-01 while scoping the aggregation adapter's sweep, and still clean:**
`DirectPoolAdapter` transfers the FULL `order.amountIn` to the pair and moves only its own measured
`amountOut`. It has no `balanceOf(tokenIn)` sweep and no refund leg at all, so the donation DoS
below has no purchase on it. It also therefore has no refund path for a pair that consumes less
than `amountIn` — not reachable through an honest V2 pair, which always takes the whole transferred
balance, and deliberately left alone.

### `AggregationRouterAdapter.executeSwap` — 1 row — REAL, fixed TWICE (#101, then the scoped refund)

The trailing "sweep unspent input back to the caller" returned `balanceOf(tokenIn)` — the adapter's
**whole** balance, including another order's in-flight input — to that call's `msg.sender`, and
`safeApprove(router, 0)` revokes the outer call's approval. Both were written assuming the adapter
only ever handles one order at a time; nothing enforced it.

> **This row said "fixed" after #101 and that was one fix short.** #101's `nonReentrant` closed the
> *reentrant* half. It made the theft **unreachable**, not impossible, and it left a second, purely
> non-reentrant exploit of the same root cause untouched — see **The donation DoS** below. The row is
> corrected rather than deleted: recording a finding as closed when only one of its two mechanisms
> was addressed is the failure mode worth keeping visible.

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

#### The donation DoS — same root cause, no reentrancy, and it gated the mainnet deploy

Both #101 reviewers reached this independently and neither was asked for it. A whole-balance sweep
does not need a nested call to be dangerous — it just needs a balance. Anyone `transfer`s `d` units
of `tokenIn` to the shared adapter. The next vault leg is refunded its own unspent input **plus
`d`**, and `VaultCore.executeRebalance` computes `spent = inBefore - inAfter` over ITS OWN balances
(the `Finding 3 (S6)` block in `VaultCore.executeRebalance` — locate it by its expression,
`spent = inBefore - inAfter`, never by a line number), which **underflows — `Panic(0x11)`** — as soon as `d` exceeds what the
route actually pulled. Note the threshold is `d > pull`, not `d > 0`; below it the same defect is
quieter and still real, silently over-crediting `idleUsdc` by `d`. The griefer then recovers the
donation with a 1-unit order, so the cost is gas and it is repeatable — and because
`VaultCore.isAllowedAdapter` is **constructor-only**, it is permanent for every vault built against
that bytecode, with no repointing path.

**Fixed by scoping the refund to this order's own delta**, `refund = min(amountIn, inAfter -
inBefore)` — the shape `VaultCore.executeRebalance` already carried (S6 Finding 3 / E3). Two clauses,
two attacks: `- inBefore` excludes a pre-existing donation (and makes the reentrant theft above
*impossible* rather than merely blocked), and the `min(…, amountIn)` clamp bounds a counterparty
that pushes `tokenIn` back mid-route.

**Three guards, not two, and each now has its own executing test.** This row previously said "both
clauses", which undercounted the line it was describing: the saturating floor
`inAfter > inBefore ? … : 0` is a third guard, it is *live* code (the adapter approves the router
for `order.amountIn` rather than for what a fee-on-transfer `tokenIn` actually delivered, so a full
pull can drive the balance below `inBefore`), and it had **zero** coverage — it could be deleted
with the whole suite green. Both #108 reviewers found that independently.

Reproduced in `test/audit/AuditAdapterScopedSweep.t.sol` — 10 tests, **7 of which fail against
`protocol/main`'s adapter**, three with `panic: arithmetic underflow or overflow (0x11)` inside
`executeRebalance` (401 units donated against a 400-unit route, the reviewers' own figure). The
three that pass on main are the honest-path regressions plus the `tokenOut` guard, whose leg main
already had correct. It is a separate file from `test/AdapterReentrancy.t.sol` on purpose: that file
is #101's record for the nested-sweep mechanism, this finding needs no reentrancy at all, and
reproducing it needs a vault-level harness.

**Retired 2026-09-03 by redeploy.** The live Base Sepolia adapter is now
`0x68be942cab962ac8f9064b45489f35fbd6f617d5` (`sourceCommit 8a0e1155`), which carries BOTH #101 and
this fix, so neither the cross-order theft nor the donation DoS is reachable on it. The previous
adapter `0xf3e08c8b…a9b1` (`sourceCommit 5934ef22`) had no `_lock`/`nonReentrant` at all and
carried both; because `isAllowedAdapter` is constructor-only it could not be repointed, so the fix
required new vaults — which the redeploy created. See `docs/DEPLOYMENT.md` §3.

**The `reentrancy-balance` count does not move.** Slither does not model the mutex for this
detector, so it still reports **8** after the fix. Expect that; it is not a failed fix. The total
went **227 → 225** on 2026-09-01, measured at `29b1b470`: the two rows that cleared are
`reentrancy-events` on the two adapters, which Slither *does* suppress once a guard is present.

**That 225 is a historical measurement, not the current total.** A clean run on the rebased tree
(`bab5ee90` merged in) reports **236**, and both #108 reviewers independently measured 236 as well.
The growth is not this change: only 3 of the 236 rows mention `AggregationRouterAdapter` at all, and
the delta tracks `calls-loop`, which is emitted per entry-point call path and grew with #98. One
reviewer measured 236 on `protocol/main` @ `52d10aee` too and found the **per-detector tallies
`diff`-identical** between main and this head — which is the claim that actually matters here, and
it is the one to cite. Do not read a bare total as a verdict on a branch: quote the per-detector
diff, or quote nothing. Adapter runtime cost of the two
guards: `AggregationRouterAdapter` 1,806 → 1,839 B, `DirectPoolAdapter` 2,165 → 2,210 B. The
scoped refund then took `AggregationRouterAdapter` **1,839 → 1,981 B** (+142); `DirectPoolAdapter`
is untouched at 2,210 B.
`VaultCore` is untouched by this change — and it is *byte-identical* to `protocol/main`, not merely
the same length: `contracts/src/VaultCore.sol` has an empty diff against main, under an unchanged
`foundry.toml`. Measured on the rebased tree (`bab5ee90` merged in): **20,650 B, 3,926 B of EIP-170
margin**, `sha256(deployedBytecode.object) = a5278797b781ea5a3888491da9933dab05999cbd678b4ca442208059ded7ceb4`.
The `20,481 B / 4,095 B` this line carried until now was measured before #98 and is stale. The same
pair is still carried by `docs/LAUNCH-READINESS.md`, which was **not** this PR's to correct —
flagged so it is not lost.

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

## Card 134 — this gate can fail now

`continue-on-error: true` is gone from `.github/workflows/ci.yml`'s `slither` job. Every one of the
242 findings Slither reports on `protocol/main` today (measured 2026-09-24, `slither . --filter-paths
"^lib/|^test/|^script/"`) is counted into `contracts/slither-baseline.json`, and
`contracts/scripts/slither_baseline_check.py` compares a fresh run against it after the Slither step.
Anything the baseline already covers passes; anything it does not reds the `slither` check.

**Not Slither's own `--triage-mode` / `--triage-database`, and this was tried first.** That
mechanism matches on Slither's own per-finding `id` — a hash of the finding's *description text*.
Detectors that bundle several equivalent comparisons or reads into one finding and pick which one to
name can render that text differently between runs with nothing in the code changed. Measured
directly on two of them — `timestamp` and `incorrect-equality`: adding one new, unrelated contract
file elsewhere in `contracts/src/`, with `VaultCore.sol` byte-for-byte unchanged, changed which
comparison `VaultCore._mintShares`'s `timestamp` and `incorrect-equality` findings named — sometimes
bundled into one finding, sometimes split into two. The `reentrancy-*` family bundles elements the
same way but was NOT observed to drift under this or the venv perturbation below — see
`FUZZY_COUNT_KEYS` in the script, scoped to the one key actually measured. A baseline keyed on
Slither's own id would have reintroduced the exact self-disarming-guard shape this card exists to
close: a required check that reds on routine, unrelated PRs, training whoever hits it to reflexively
regenerate the baseline — which re-accepts whatever is in the tree at that moment, including a real
new finding.

**The key `slither_baseline_check.py` uses instead never carries a line number, a column, or a
specific comparison's text**: `<check>::<Contract>.<function>` (or `<check>::<Contract>` for a
contract-level finding), derived by walking each finding's first element up its
`type_specific_fields.parent` chain to the nearest `function` and `contract` nodes. Comparison is a
multiset by key: the baseline's `count` for a key must cover the current run's count for it, or that
excess is new and fails the check. Exactly one key, `incorrect-equality::VaultCore._mintShares`, is
**presence-only** (baseline has the key at all clears any count for it, not just up to its recorded
count) — every other `incorrect-equality` key, including `_settleExit`'s 6, is still held to an
exact multiset bound: mutation-tested below TWICE, by two different causes, to move that ONE key's
count from 1 to 2 with the source byte-for-byte unchanged — an
unrelated new file elsewhere in `contracts/src/`, and the SAME tree analyzed from a freshly created
venv instead of the ambient one (see "Pinning the analysis environment" below). Every other
multi-element detector mutation-tested alongside it (`timestamp`, and the
`reentrancy-balance`/`reentrancy-events`/`reentrancy-benign`/`reentrancy-no-eth` family) held its
count exactly across both — so `FUZZY_COUNT_KEYS` in the script is one key, not a detector class, and
widening it without measuring the same drift is how a real new reentrancy site stops failing the
build. A key entirely absent from the baseline still fails regardless of detector: presence-only
relaxes the count bound on an already-accepted site, never "any finding from this detector is fine."

**A structural limit, not a bug: some detectors report once per FUNCTION, not once per instance.**
Measured by mutation-testing `IdentityGate.hasIdentity` (already 1 `low-level-calls` finding, 1
`missing-zero-check` finding): a second, textually distinct `staticcall` added to that same function
still reported count 1 for both, because Slither lists the second call as an extra sub-bullet in the
SAME finding rather than a second finding. For a detector shaped this way, this baseline can only
catch a genuinely new *site* (count 0 -> 1 in a function that had none), not a new instance added to
an *already-accepted* one. `low-level-calls` and `missing-zero-check` (once per parameter) are
measured to fold this way; `assembly` and `cyclomatic-complexity` are inferred to share the shape
(single element per finding, same as the two measured) but were not separately mutation-tested.
`reentrancy-benign`/`-events`/`-no-eth` currently sit at count 1 per key in this codebase, which is
consistent with folding but is equally consistent with "no site here happens to have a second
instance yet" — genuinely unknown either way. **`reentrancy-balance` is NOT in this group**: its
own baseline data proves it reports per instance, not per function — `VaultCore.executeRebalance`
alone carries 4 separate `reentrancy-balance` findings. `calls-loop`, `costly-loop`, `unused-return`
and `divide-before-multiply` are also per-instance — mutation-tested below, `calls-loop` caught a
second call added inside an already-baselined loop.

**Pinning the analysis environment — a real improvement, but not a fix for the drift above.**
`.github/workflows/ci.yml`'s `slither` job pins
`eth-abi`/`eth-account`/`eth-keyfile`/`eth-keys`/`eth-rlp`/`eth-typing`/`eth-utils`/`hexbytes`/
`pycryptodome`/`rlp`/`web3` alongside `slither-analyzer`, matched to the environment this baseline
was generated in (read off its `pip freeze`) — reproducible dependency resolution is worth having on
its own, and a mismatched `eth-abi` was the first, plausible suspect for the `incorrect-equality`
drift above. **It was tested and ruled out**: a venv built from these EXACT pins, analyzing the
identical tree, still reported `incorrect-equality::VaultCore._mintShares` at count 2, the same
drift as the unpinned venv. Whatever actually causes it survives pinning every dependency checked so
far — this is recorded rather than chased further, because `FUZZY_COUNT_KEYS`'s presence-only
tolerance for that one key already handles the effect regardless of its cause, and the pins still
remove the largest, most plausible source of unrelated future drift.

**Regenerating the baseline**, after adding a fix or a disposition to a table above — never before,
and from inside the pinned venv above so the counts match what CI will see:

```bash
cd contracts
forge build
rm -f slither-report.json
.venv/bin/slither . --filter-paths "^lib/|^test/|^script/" --fail-none --json slither-report.json
python3 scripts/slither_baseline_check.py --generate slither-report.json slither-baseline.json
```

`--generate` keeps the `reason` text for every key that still appears and writes a `TODO` for a
brand-new one — `git diff contracts/slither-baseline.json` afterward and replace every `TODO`
before committing; the reason is the disposition, not the count. `rm -f` first: Slither refuses to
overwrite an existing `--json` file, silently keeping the old one — this bit the mutation testing
below before the recipe accounted for it.

**Mutation-tested 2026-09-24, six cases, against the real baseline:**

| change | expected | result |
| --- | --- | --- |
| A scratch contract under `contracts/src/` with an unchecked low-level ETH send to a caller-supplied address (`to.call{value: address(this).balance}("")`) | reds — none of its findings are in the baseline | `arbitrary-send-eth`, `low-level-calls`, `missing-zero-check`, `unchecked-lowlevel`, all on the scratch contract, reported and the script exited 1 |
| The same scratch contract removed | green again | 242/242 findings covered, exit 0 |
| A blank line inserted at the top of `contracts/src/VaultCore.sol` (pure line shift, no semantic change), nothing else in the tree touched | stays green | 242/242 covered, exit 0. (The abandoned `--triage-mode` approach above was not re-run against this exact case — the code citation for why it would fail is `SourceMapping.__str__` in slither's own source, which renders every node's id-text as `filename_short + lines`, so any line shift changes the id it matches on.) |
| A second, textually distinct `staticcall` added inside the already-baselined `IdentityGate.hasIdentity` (a per-function detector) | stays green — the structural limit above, not a false negative in the multiset logic | 242/242 covered, exit 0 |
| A second, genuinely distinct external call (`oracle.priceWad(asset)`) added inside the loop in the already-baselined `VaultFactory._requireOracleCoversBasket` (a per-instance detector, baseline count 2) | reds — a real new instance at an accepted site | `calls-loop::VaultFactory._requireOracleCoversBasket: baseline allows 2, this run has 4` (plus one incidental new `unused-return`), script exited 1; reverted and re-verified green |
| The identical tree, no source touched at all, analyzed from a freshly created venv pinned to the exact `eth-*`/`rlp`/`hexbytes` versions above instead of the ambient install | stays green (the presence-only tolerance is what makes this pass, not luck) | 243 findings, not 242 — `incorrect-equality::VaultCore._mintShares` at count 2 instead of 1, exactly the drift `FUZZY_COUNT_KEYS` names — script still exited 0 |
