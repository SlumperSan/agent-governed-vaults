# Static analysis, 2026-10-21

<!-- doc-claims: historical record. The `file:line` citations below describe the tree at `protocol/main` commit `c3277fc` (2026-10-21) and are deliberately NOT re-pointed as the code moves; read them with `git show c3277fc:<path>`. -->

Slither and Aderyn run over `contracts/src` at `protocol/main` commit
`c3277fc233c799b502a302fa95315b851a8952f8`. Every finding from both tools is triaged below as a
true positive, a false positive, or informational, with the reasoning and a file:line. No contract
source was edited for this report.

## Result in one paragraph

Neither tool found a new defect above informational. Slither reported 245 results across 18
detectors and 108 distinct sites; every one is covered by `contracts/slither-baseline.json`, and the
only count difference against the baseline is the drift the baseline already tolerates by design
(`incorrect-equality::VaultCore._mintShares`, 2 against a recorded 1). Aderyn reported 16 detector
classes (3 it labels high, 13 low); its three "high" classes are all false positives. The true
positives are housekeeping: two unused custom errors, two one-shot wiring functions that emit no
event, a fee cap written as a bare literal that duplicates a constant, a reused interface name,
two storage array lengths read in a loop, and one previously registered sub-vault finding (H-6)
that Slither's `divide-before-multiply` points at. Fixes are proposed for each, with one caution
that applies to all of them: any change to a protocol singleton's source changes its creation
code and therefore its CREATE2 address (see "Fix caution" at the end).

## Scope and method

| Item | Value |
| --- | --- |
| Commit | `c3277fc` (`protocol/main`, 2026-10-21) |
| Files | the 22 `.sol` files under `contracts/src`, 4,152 lines; tests, scripts and `contracts/lib` (forge-std) excluded |
| Compiler | solc 0.8.26, `via_ir`, optimizer 800 runs, `evm_version = cancun` (from `contracts/foundry.toml`) |
| Build | Foundry `forge` 1.7.1, the version CI pins |
| Slither | `slither-analyzer` 0.11.6 in a venv with the exact `eth-*`, `rlp`, `hexbytes`, `pycryptodome` and `web3` pins from the `slither` job in `.github/workflows/ci.yml`; invoked with that job's exact command (anchored path filter over lib, test and script; JSON output) |
| Aderyn | 0.6.8 (release binary), `aderyn . -s src` from `contracts/`, 88 detectors |
| Baseline check | `python3 contracts/scripts/slither_baseline_check.py <report> contracts/slither-baseline.json` printed `OK, 245 finding(s), all covered by the baseline` |

Verdict legend used throughout:

- **TP**: the detector is right and something should change (severity stated).
- **FP**: the detector's claim does not hold at this site, for the reason given.
- **Info**: the detector is factually right but the pattern is intended, documented, and safe; no change proposed.

Line numbers are as of `c3277fc`. Where a symbol is more durable than a line, the symbol is named
too.

Prior work this report builds on and does not repeat in full: `docs/reviews/SLITHER-TRIAGE.md`
(per-class history, the `reentrancy-balance` site analysis, the baseline mechanism) and
`docs/audit/AI-AUDIT-REPORT.md` (H-6, H-9, M-5, I-5). Every verdict below was re-checked against
the source at this commit rather than copied from those files; where this report agrees with
them it says so, and where it adds something it says that too.

## True positives and proposed fixes

| # | Tool, detector | Site | Severity | Proposed fix |
| --- | --- | --- | --- | --- |
| TP-1 | Aderyn `unused-error` | `Governance.sol:205` `error NoActiveProposal()`; `OperatorRegistry.sol:69` `error NotOperator()` | Info | Delete both declarations. Grep confirms no `revert`/`require` uses either anywhere in `contracts/src`. |
| TP-2 | Aderyn `state-change-without-event` | `SubVaultRegistry.wire` (`SubVaultRegistry.sol:52`); `Governance.wireSubVaultRegistry` (`Governance.sol:64`) | Low (observability) | Emit an event on each, matching `OperatorRegistry.wire`, which already emits `FactorySet` and `FeeEngineSet`. Today the only way to see these two wirings happened is to read storage; an indexer cannot. Suggested: `event FactorySet(address indexed factory)` in `SubVaultRegistry`, `event SubVaultRegistrySet(address indexed registry)` in `Governance`. |
| TP-3 | Aderyn `literal-instead-of-constant` | `VaultCore.sol:748` `uint256 cap = gain / 10;` in `_settleExit` | Info (drift risk) | The 10% cap restates `FeeEngine.PERF_FEE_BPS = 1_000` (`FeeEngine.sol:35`) and `SubVaultRegistry.PERF_FEE_BPS` (`SubVaultRegistry.sol:22`) as a bare divisor. If one moves and the other does not, the cap silently disagrees with the engine. Replace with a named constant, for example `gain * PERF_FEE_CAP_BPS / BPS` with `PERF_FEE_CAP_BPS = 1_000`, and add a test asserting it equals `FeeEngine.PERF_FEE_BPS`. |
| TP-4 | Aderyn `reused-contract-name` | `interface IERC20Balance` declared in both `AggregationRouterAdapter.sol:7` and `FeeEngine.sol:20` | Info | Foundry disambiguates by path so the build is fine, but tools keyed on contract name (Hardhat artifacts, some verifiers, Slither's own name resolution) can collide. Move the one-function interface to `src/interfaces/` and import it in both files. Interfaces produce no bytecode, so this change alone should not move either contract's creation code; confirm with `scripts/test/create2-manifest.test.mjs`. |
| TP-5 | Slither `cache-array-length`; Aderyn `storage-array-length-not-cached` | `VaultCore.sol:335` (`navWad`), `:666` (`_settleExit`), `:705` (`_settleExit` child unwind) | Gas only | Cache `childVaults.length` in a local before each loop. On the launch configuration (`ALLOW_SUB_VAULTS = false` at `contracts/script/lib/ProtocolCreate2.sol:37`, so `childVaults` is empty) each loop costs one SLOAD, so the saving is tiny; worth folding into the next VaultCore change rather than shipping alone. |
| TP-6 | Slither `divide-before-multiply` (row at `VaultCore.sol:675` to `:677`) | `_settleExit`: `usdcPay = cashTargetWad / usdcScalar`, then `shortfallWad = cashTargetWad - usdcPay * usdcScalar` | High as registered, dormant | This is the arithmetic H-6 in `docs/audit/AI-AUDIT-REPORT.md` is about: the child unwind is sized gross and repaid net, so `ExitNeedsChildSettlement` can be unsatisfiable on a child-backed exit. Not new. Reachable only when a vault has children, which the mainnet factory forbids (`allowSubVaults` false); the testnet factory allows it. Fix as H-6 proposes (size the child redemption so the net proceeds cover the shortfall, or settle the remainder in kind); it must land before any factory with `allowSubVaults = true` reaches mainnet. The other three `divide-before-multiply` rows are Info, below. |

No true positive here needs action before the current v2 deploy plan unless the v2 singletons are
being rebuilt anyway; see "Fix caution".

## Slither, every finding

245 results, grouped by the baseline key `<detector>::<Contract>.<function>`. "xN" is how many
results Slither emitted for that key.

### High impact: `reentrancy-balance` (9 results, 5 sites)

All nine are the measured-balance-delta pattern (EX-3): read a balance, make the external call,
compare the new balance. Reading before the call is the pattern itself, so the detector cannot
tell it from the bug it hunts.

| Key | Lines | Verdict | Reasoning |
| --- | --- | --- | --- |
| `VaultCore.executeRebalance` x4 | call `:976`; reads `:974`, `:975`, `:977`, `:988` | FP as flagged | `nonReentrant` on the whole function; only `governance` may call it (`:935`); the adapter is allowlisted at construction. The cross-contract read-only window (a parent pricing this vault mid-swap) is real in general and is H-9; it is closed by `require(!v.locked(), Reentrancy())` in `_fullNavWad` (`VaultCore.sol:379`). Agrees with SLITHER-TRIAGE. |
| `VaultCore._settleExit` x1 | `:716` via `_redeemChildMeasured` `:880` | FP | Both callers are `nonReentrant`; every internal decrement (`sharesOf`, `totalShares`, `idleUsdc`, slices) is final before the child call; child proceeds are measured, not trusted. Sub-vault only. |
| `DirectPoolAdapter.executeSwap` x2 | `:105` read, `:107`/`:108` swap | FP | `nonReentrant`; the adapter sends exactly `amountIn` to the pair and forwards only its own measured `amountOut`, so re-entry can only shrink the outer delta and fail on `Slippage()`. |
| `UniswapV3Adapter.executeSwap` x1 | `:173` read, `:189` call | FP | `nonReentrant`; refund scoped to this order (`min(inAfter - inBefore, amountIn)`, `:203` to `:204`), `inBefore` read at `:169`, before the pull at `:170`. |
| `AggregationRouterAdapter.executeSwap` x1 | `:122` read, `:123` call | FP now (was a real bug, fixed) | Was the cross-order sweep fixed in #101 plus the scoped refund. Verified at this commit: `nonReentrant`, `inBefore` read before the pull (`:117`), refund clamped to `amountIn` (`:163`). Slither does not model the mutex so the row persists; expected. |

### Medium impact

| Key | Lines | Verdict | Reasoning |
| --- | --- | --- | --- |
| `divide-before-multiply::VaultCore._settleExit` x4 | `:675` with `:677`; `:675` with `:678`; `:675` with `:765`/`:768`; `:765` with `:790` | 1 TP (TP-6), 3 Info | The `:677` row is H-6, above. The other three round each payout leg down, in the vault's favour, which is the direction the NAV-per-share invariant needs; the loss is at most one unit of the smallest denomination per leg. |
| `incorrect-equality::VaultCore._settleExit` x6 | `:657` `memberShares == ts`, `:682`, `:696` `slice == 0`, `:715` `cs == 0`, `:720`, `:765` `payoutValueWad == 0` | FP | Exact comparisons on share counts and computed amounts used as skip or sole-holder tests. None compares a token `balanceOf`, so a donation cannot steer them (NAV reads internal accounting only). |
| `incorrect-equality::VaultCore._mintShares` x2 | `:507` `ts == 0`, `:510` `sharesOf[member] == 0` | FP | First-deposit and new-holder tests on internal counters. The x2 versus baseline x1 is the documented Slither rendering drift (`FUZZY_COUNT_KEYS`), not a code change. |
| `incorrect-equality::VaultCore.convertToShares` / `convertToAssets` / `navPerShareWad` x1 each | `:1134`, `:1141`, `:404` | FP | `ts == 0` guards the empty-vault branch. |
| `incorrect-equality::VaultCore._checkPositionFloor` x1 | `:641` | FP | `remaining == 0` is the "full exit is allowed" carve-out of the dust floor. |
| `incorrect-equality::Governance._isSettled` x1 | `:737` | FP | Enum equality on proposal status. |
| `incorrect-equality::Checkpoints.push` x1 | `src/lib/Checkpoints.sol:23` | FP | Same-second overwrite; strict equality is the point (standard checkpoint idiom). |
| `reentrancy-no-eth::VaultCore.allocateToChild` x1 | call `:835` `skipWindow()`, write `:845` | FP | `nonReentrant`; governance-only (`:821`); target is a registry-attested child. The in-source comment at `:838` explains why the debit sits after the call. |
| `reentrancy-no-eth::VaultCore.executeRebalance` x1 | `:976`, writes `:970`, `:983` | FP | Same as the `reentrancy-balance` row for this function. |
| `uninitialized-local::VaultCore._settleExit` x2 | `perfFee` `:740`, `childValTotalWad` `:665` | FP | Accumulators that rely on Solidity's zero default; both are assigned before any read that matters. |
| `unused-return::VaultCore._settleExit` x4 | `:743`, `:753`, `:778`, `:796` (`boundedCall` to FeeEngine) | Info | Intentional (H-1): fee and bookkeeping calls are best-effort so a failing module cannot block an exit. `ok` is checked at each and a `ModuleCallFailed` event emitted. The residual, that a failed `onFeeCollected` after a successful transfer strands that fee in FeeEngine, is already registered as I-5. |
| `unused-return::VaultCore._recordRealization` x1 | `:1041` | Info | Same H-1 best-effort pattern; failure emits `ModuleCallFailed`. |
| `unused-return::VaultCore.executeRebalance` x1 | `:976` | Info | Ignoring the adapter's `amountOut` is the EX-3 rule: output is the vault's own measured balance delta (`:977`). |
| `unused-return::UniswapV3Adapter.executeSwap` x1 | `:189` | Info | Same rule inside the adapter; delta measured at `:196`. |
| `unused-return::DirectPoolAdapter.executeSwap` x1 | `:100` `getReserves()` | Info | Ignores `blockTimestampLast` only; reserves feed a quote, and the binding check is the measured delta against `minAmountOut`, itself floored against the vault oracle by `MinOutTooLow` in `VaultCore.executeRebalance`. |
| `unused-return::ChainlinkOracle.priceWad` x1 | `:321` | Info | Ignores `roundId`, `startedAt`, `answeredInRound`. Checks done: `answer > 0`, `updatedAt != 0`, not in the future, within heartbeat, optional price band, and any revert maps to `StaleOracle` (`:322` to `:338`). `answeredInRound` is deprecated by Chainlink; not checking it is current practice. |
| `unused-return::ChainlinkOracle._requireSequencerUp` x1 | `:356` | Info | Uses `answer` and `startedAt` with a grace period; deliberately skips `updatedAt` because the uptime feed only writes on transitions (comment `:350` to `:355`). |
| `unused-return::ChainlinkOracle.constructor` x2 | `:243`, `:268` | Info | Constructor probes that a feed decodes; values unused by design. |

### Low impact

| Key | Lines | Verdict | Reasoning |
| --- | --- | --- | --- |
| `missing-zero-check::VaultCore.constructor` x1 | `:271` `subVaultRegistry_` | FP | Zero is the valid "root-only vault" configuration. |
| `missing-zero-check::VaultFactory.constructor` x1 | `:117` `subVaultRegistry_` | FP | Same; the factory passes zero to root-only vaults. |
| `missing-zero-check::IdentityGate.hasIdentity` / `agentIdOf` x1 each | `:58`, `:71` | FP | View query parameters; zero is a legal "no identity" input and is never stored. |
| `reentrancy-benign::FeeEngine.pullEscrowed` x1 | `:144` | FP | `nonReentrant` (M-3 fix); credit is the measured delta. |
| `reentrancy-benign::VaultCore._redeemChildMeasured` x1 | `:868`, call `:880` | FP | Only reached from `nonReentrant` callers; credit is measured. |
| `reentrancy-benign::VaultCore._settleExit` x1 | `:644` | FP | `nonReentrant` callers; writes after the call are escrow credits to the recipient. |
| `reentrancy-benign::VaultCore.pullChildEscrow` x1 | `:903` | FP | `nonReentrant`; child must be registered (`:904`); credit is measured. |
| `reentrancy-benign::VaultFactory.createVault` / `createChildVault` x1 each | `:218`, `:239` | FP | No mutex, but the only state is append-only `allVaults`; a nested create during VaultCore's constructor reorders pushes and nothing else. Agrees with SLITHER-TRIAGE (Sprint 10 note). |
| `reentrancy-events::VaultFactory.createVault` / `createChildVault` x1 each | `:218`, `:239` | Info | Event order under nesting matches emission order; indexers sort by log index. |
| `reentrancy-events::FeeEngine.onFeeCollected` x1 | `:94`, call `:105` | FP | Caller must be an attested vault (`:102`); the external call is to the immutable registry. |
| `reentrancy-events::Governance.execute` x1 | `:689`, calls `:705`, `:706`, `:714` | FP | Status is set to `Executed` before the vault calls, so a re-entry fails `NotPassed`; the vault targets are themselves `nonReentrant`. |
| `timestamp` x32 (32 keys, listed below) | various | Info, and FP where the flagged comparison is not about time | Governance phases, timelock, cooldown, oracle heartbeat and sequencer grace use `block.timestamp` with windows of minutes to days, far above validator influence. Many rows flag comparisons that do not involve time at all (for example `ts == 0` at `VaultCore.sol:404`, `idleUsdc >= amountUsdc` at `:827`), because Slither's taint reaches them through `_snapshot`; those are FP. The one historically real timestamp issue (T-1, standing-default TTL against commit window) is fixed per SLITHER-TRIAGE. |
| `calls-loop` x132 (15 keys, listed below) | various | Info | External calls in bounded loops: basket at most 10 assets (`MAX_BASKET_ASSETS`), children at most 8 (`MAX_CHILDREN`), look-through depth at most 3. A reverting oracle or child halts the loop, which is the intended fail-closed behaviour (K-4). Cost at full sub-vault fan-out is M-5, dormant while sub-vaults are off. |

`timestamp` keys (one result each): `AggregationRouterAdapter.executeSwap` (`:102` deadline),
`DirectPoolAdapter.executeSwap` (`:88`), `UniswapV3Adapter.executeSwap` (`:155`),
`ChainlinkOracle.priceWad` (`:324`, `:328`), `ChainlinkOracle._requireSequencerUp` (`:360`,
`:362`), `Checkpoints.push` (`:23`), `Governance._accrueDelegate`, `_isSettled`, `_refreshStatus`
(`:730`), `applyStandingDefault`, `commitVote`, `execute` (`:692`), `finalize`,
`hasPendingExecution` (`:751`, `:754`), `markExpired`, `propose` (`:328` cooldown),
`revealDelegated`, `revealVote`, `setDelegate`; `VaultCore._checkCreatorGate`,
`_checkPositionFloor`, `_deposit`, `_exitFeeBps` (`:1064` fee decay), `_mintShares`,
`_settleExit`, `activate` (`:465` observation window), `allocateToChild`, `convertToAssets`,
`convertToShares`, `executeRebalance`, `navPerShareWad`, `requestExit`. Verdicts: the rows naming
a deadline, phase, cooldown, heartbeat, grace, fee decay or window are Info; the rest are FP.

`calls-loop` keys and counts: `VaultCore._fullNavWad` x77 (look-through recursion; each of 11
child or basket reads counted per path), `_holdingValueWad` x22, `_assetValueWad` x12,
`_redeemChildMeasured` x4, `_bal` x3, `_childPendingExecution` x2, `_settleExit` x2, `constructor`
x1 (basket `decimals()`), `executeRebalance` x1 (adapter call per order); `VaultFactory._requireOracleCoversBasket`
x2, `createChildVault` x1; `SubVaultRegistry.registerChild` x1, `stackedExitFeeCapBps` x1 (ancestor
walk, depth capped at 3); `ChainlinkOracle.constructor` x2, `_requireUsdQuote` x1 (one-time feed
config loop). All Info for the reason in the table.

### Informational and optimization

| Key | Lines | Verdict | Reasoning |
| --- | --- | --- | --- |
| `assembly` x8 | `BoundedCall.boundedCall` `src/lib/BoundedCall.sol:16`, `boundedStaticCall` `:40`; `SafeTransferLib._call2` `src/lib/SafeTransferLib.sol:49`, `_call3` `:78`, `tryTransfer` `:112`; `VaultDeployer.deploy` `:59`, `_writeChunk` `:97`, `_readChunk` `:109` | Info | Re-read at this commit. Each block copies at most one word of returndata (returndata-bomb safe), zeroes the scratch word before a short copy (L-3), writes only at or above the free pointer without bumping it (consistent with `memory-safe`), and treats 1 to 31 bytes of returndata as failure. Residual worth recording: none of the ERC-20 helpers checks `extcodesize`, so a call to a codeless address reads as success. Not reachable as a loss today, because every token that reaches these helpers has already passed a high-level call that reverts on a codeless address (`decimals()` in the VaultCore constructor for USDC and basket assets; `balanceOf` reads in the adapters and FeeEngine). Keep that property if new call paths are added. |
| `low-level-calls` x4 | `AggregationRouterAdapter.executeSwap` `:123`; `IdentityGate.hasIdentity` `:59`, `agentIdOf` `:72`; `ChainlinkOracle._requireUsdQuote` `:298` | Info | Router call is selector-allowlisted to a pinned router with measured-delta settlement; the IdentityGate staticcalls check `ok` and length and return "no identity" on failure (deny, not allow); the oracle probe is constructor-only and fails closed. |
| `missing-inheritance` x4 | `OperatorRegistry` `:21`, `SubVaultRegistry` `:19`, `VaultCore` `:40`, `VaultDeployer` `:33` | TP, cosmetic | The narrow interfaces (`IRegistryAttest`, `ISubRegistryChild`, `IVaultExecution`, `IVaultDeployer`) are declared next to their callers and the ABIs match. Declaring `is` would let the compiler check the match; optional, and it touches creation code of singletons (see caution). |
| `cyclomatic-complexity` x1 | `VaultCore._settleExit` `:644` (complexity 32) | TP, maintainability | A 167-line function carrying cash, basket, child-unwind, fee and escrow legs. Suggest splitting into `_computeExitTargets`, `_unwindChildren` and `_distributeExit` the next time this function is changed for a functional reason, not as a standalone refactor. |
| `costly-loop` x3 | `VaultCore.executeRebalance` `:966`, `:982`, `:992` | Info | `idleUsdc` updated per order. Orders are few and governance-supplied; caching in memory would complicate the per-leg accounting the measured-delta checks rely on. |
| `too-many-digits` x2 | `SafeTransferLib.tryTransfer` `:114`; `VaultDeployer.constructor` `:43` | FP | A padded `transfer` selector, and `type(VaultCore).creationCode` rendered as a literal. |
| `cache-array-length` x2 | `VaultCore.sol:335`, `:666` | TP, gas | TP-5. |

## Aderyn, every finding

| Detector (Aderyn label) | Instances | Verdict | Reasoning |
| --- | --- | --- | --- |
| `reentrancy-state-change` (high) | 28: `DirectPoolAdapter.sol:82`; `FeeEngine.sol:101`, `:103`, `:118`, `:145` to `:149`; `Governance.sol:233`, `:334`, `:335`, `:351`; `SubVaultRegistry.sol:75`; `VaultCore.sol:284`, `:316`, `:822`, `:835`, `:907`, `:976`; `VaultFactory.sol:227`, `:253` to `:264`; `ChainlinkOracle.sol:218`, `:243`, `:268` | FP | Grouped by reason. Constructors (`DirectPoolAdapter`, `VaultCore` `:284`/`:316`, `ChainlinkOracle`): no reachable state yet. `nonReentrant` functions (`VaultCore` `:822`/`:835`/`:907`/`:976`, `FeeEngine.pullEscrowed`). Calls only to the immutable registry or an attested vault (`FeeEngine.onFeeCollected`, `onFeeCollectedAsset`). `SubVaultRegistry.registerChild` `:75`: factory-only, reads `exitFeeMaxBps()` from registered ancestors. `VaultFactory` creates: covered by the Slither `reentrancy-benign` row. `Governance.registerVault` and `propose`: the external calls go to the vault being registered or proposed on; a hostile contract that registers itself (possible, since `registerVault` only checks `msg.sender == vault.creator()`) can only disturb proposal bookkeeping for its own address, and nothing elsewhere in the protocol trusts `Governance.vaultRegistered`. |
| `reused-contract-name` (high) | `AggregationRouterAdapter.sol:7`, `FeeEngine.sol:20` | TP, Info | TP-4. Aderyn's "high" label overstates it; no runtime effect. |
| `unprotected-initializer` (high) | `Governance.sol:57`, `OperatorRegistry.sol:73`, `SubVaultRegistry.sol:45` | FP | Each flagged line is `function initialized() external view`, a read-only status getter. The functions that actually initialise (`Governance.wireSubVaultRegistry` `:64`, `OperatorRegistry.wire` `:80`, `SubVaultRegistry.wire` `:52`, `VaultFactory.initialize`) each require `msg.sender == deployer`, the `PROTOCOL_INITIALIZER` constant (`src/lib/ProtocolInitializer.sol`), and revert on a second call. |
| `costly-loop` (low) | `VaultCore.sol:693`, `:705`, `:786`, `:885`, `:946`; `VaultFactory.sol:140` | Info | Storage writes inside loops bounded by basket (at most 10), children (at most 8), order count, or a constructor allowlist. |
| `large-numeric-literal` (low) | `DirectPoolAdapter.sol:126`, `:128`; `FeeEngine.sol:36`; `Governance.sol:71`; `SubVaultRegistry.sol:91`, `:93` x2, `:95`; `UniswapV3Adapter.sol:65`; `VaultCore.sol:48`, `:53`; `ChainlinkOracle.sol:132` | FP | `10_000` (bps denominator), `300_000` (module gas), `90_000` (heartbeat cap), already written with separators and mostly already named constants. |
| `literal-instead-of-constant` (low) | `AggregationRouterAdapter.sol:106` x2; `DirectPoolAdapter.sol:126`, `:128`; `IdentityGate.sol:61`, `:75`; `SubVaultRegistry.sol:91`, `:93` x2, `:95`; `VaultCore.sol:285`, `:286` x2, `:317`, `:318`, `:748`; `ChainlinkOracle.sol:305`, `:307` x2 | 1 TP, rest FP | `VaultCore.sol:748` (`gain / 10`) is TP-3. The rest are self-describing: `4` (selector length), `32` (ABI word), `18` (WAD decimals), `10_000` in a display-only helper, `3`/`4` character offsets in the "/USD" check. |
| `missing-inheritance` (low) | `SubVaultRegistry.sol:19`, `VaultCore.sol:40`, `VaultDeployer.sol:33` | TP, cosmetic | Same as the Slither row. |
| `modifier-used-only-once` (low) | `AggregationRouterAdapter.sol:83`, `DirectPoolAdapter.sol:72`, `UniswapV3Adapter.sol:113` | Info | Each adapter's `nonReentrant` guards its single entry point; keeping it as a modifier states the adapter-wide invariant and matches `VaultCore._lock`. |
| `require-revert-in-loop` (low) | `VaultCore.sol:335`, `:389`, `:666`, `:705`, `:946`; `VaultFactory.sol:140`, `:193`, `:255` | Info | Intended: one bad order, stale asset, locked child or unlisted basket asset must fail the whole call (fail closed), not be skipped. |
| `state-change-without-event` (low) | `Governance.sol:64`, `SubVaultRegistry.sol:52`, `VaultCore.sol:903` | 2 TP, 1 FP | `wireSubVaultRegistry` and `SubVaultRegistry.wire` are TP-2. `VaultCore.pullChildEscrow` (`:903`) is FP in effect: the child's `claimEscrowed` emits on the transfer side and the credit is observable as a balance change; an event would be nice but nothing is hidden. |
| `state-variable-could-be-immutable` (low) | `VaultCore.sol:117` `address[] public basketAssets` | FP | Dynamic arrays cannot be `immutable` in Solidity. It is write-once in the constructor in practice. |
| `storage-array-length-not-cached` (low) | `VaultCore.sol:335`, `:666`, `:705` | TP, gas | TP-5. |
| `unchecked-return` (low) | `VaultCore.sol:479`, `:499`, `:793`, `:976`; `ChainlinkOracle.sol:268` | FP / Info | `:479` and `:793` ignore `_payOrEscrow`'s bool, which is safe because a false result already escrowed the amount for the recipient (`:1006` to `:1008`). `:499` ignores the minted share count from `_mintShares` (internal, minted shares are recorded inside). `:976` is EX-3 (Info). `ChainlinkOracle.sol:268` is a constructor decode probe (Info). |
| `uninitialized-local-variable` (low) | 14 loop counters and accumulators: `SubVaultRegistry.sol:92`; `UniswapV3Adapter.sol:141`; `VaultCore.sol:313`, `:330`, `:335`, `:382`, `:389`, `:666`, `:705`, `:786`, `:946`; `VaultFactory.sol:193`, `:255`; `ChainlinkOracle.sol:181` | FP | `for (uint256 i; ...)` and zero-default accumulators. |
| `unused-error` (low) | `Governance.sol:205`, `OperatorRegistry.sol:69` | TP, Info | TP-1. |
| `unused-public-function` (low) | `VaultCore.sol:402` `navPerShareWad()` | FP | Part of the vault's external read surface (used by off-chain readers and tests); `public` versus `external` makes no difference here worth a bytecode change. |

## Fix caution: source edits move CREATE2 addresses

`contracts/foundry.toml` sets `bytecode_hash = "none"` and `cbor_metadata = false` so that creation
code depends on code alone, and `contracts/config/create2-manifest.json` with
`scripts/test/create2-manifest.test.mjs` pin the result. Any of TP-2, TP-3, TP-5, the
`missing-inheritance` change, or a `_settleExit` refactor changes the creation code of the
contract touched, and for a protocol singleton (OperatorRegistry, SubVaultRegistry, Governance,
FeeEngine, VaultFactory) that means a different CREATE2 address on every chain. Removing unused
errors (TP-1) and moving an interface (TP-4) are expected not to change runtime bytecode, but that
should be confirmed by the manifest test rather than assumed.

So the practical recommendation is:

1. If the v2 Ethereum singletons have not yet been deployed and their addresses are not yet
   published, fold TP-1, TP-2, TP-3 and TP-4 into one small contract PR before deploy, regenerate
   the manifest, and run the full gate. These change no behaviour.
2. If the addresses are already fixed or published, leave all of them; none is worth a new
   address.
3. TP-5, the `missing-inheritance` change and the `_settleExit` split only ride along with the next
   functional VaultCore change.
4. TP-6 (H-6) is a blocker for enabling sub-vaults on any mainnet factory, not for the current
   root-only deploy.

Per the repository's working agreement, contract changes need the owner's diff review; this report
proposes and does not edit.

## Notes on the baseline and prior triage

- `docs/reviews/SLITHER-TRIAGE.md` quotes 242 findings, measured 2026-09-24 on `protocol/main`.
  At `c3277fc` the baseline's recorded counts sum to 244 over 108 keys, and this run produced 245;
  the extra one is the tolerated `_mintShares` drift. The 242 is a dated measurement, not an error,
  but a reader comparing raw totals should use the per-key comparison instead.
- The `missing-inheritance` row in SLITHER-TRIAGE names only `VaultDeployer`; Slither now also
  reports `OperatorRegistry`, `SubVaultRegistry` and `VaultCore`. Same disposition, all four are in
  the baseline.
- Aderyn is not in CI. Its unique true positives here (TP-1 to TP-4) are all informational, so
  adding it as a gate would mostly add noise; running it once per audit cycle, as here, looks
  sufficient.

## Reproducing

From `contracts/` at `c3277fc`, with Foundry 1.7.1 and solc 0.8.26 available:

1. `forge build`
2. Build the venv and run Slither exactly as the `slither` job in `.github/workflows/ci.yml`
   does, writing JSON to a fresh file.
3. `python3 scripts/slither_baseline_check.py <report.json> slither-baseline.json`
4. `aderyn . -s src -o aderyn-report.json`

In this run the network policy blocked `binaries.soliditylang.org` and the Foundry installer, so
solc 0.8.26 and Foundry 1.7.1 were taken from their GitHub release assets and solc was placed where
Foundry's version manager looks for it; the compiler version string was checked
(`0.8.26+commit.8a97fa7a`).
