# Highs

The nine High-severity findings from the AI pre-audit. Four are fixed, four are dormant at launch
(they need a funded child, unreachable under [[root-vaults-only]]), and one is partially fixed +
config-mitigated.

## Why it matters

Highs are loss-of-funds or permanent-lockup findings one notch below Critical (each was adjusted up
one level for immutability). The oracle Highs (H-1, H-2) feed C-4/C-6; H-4 is the unbounded-slippage
gap that turns governance capture into a drain; H-8 is the key open High for a root-only launch.

## The nine findings

### H-1 — Lower median degenerates to `min()` at two fresh sources — **FIXED**
The aggregator returned `fresh[(k-1)/2]`; at `k == 2` that is `fresh[0]`, the **minimum**, and the
constructor permitted the documented 2-of-3 mainnet config. Bias is one-directional: downward. Fixed
by requiring `k >= 3` and `quorum >= 3` (`MIN_MEDIAN`), so a "median" is always a median — which is
why each asset now needs **five** sources and `base-mainnet.json` became NOT-DEPLOYABLE. Note the
`k <= 2a` residual this leaves became [[c6-oracle-byzantine]]. Regression:
`AuditAggregatorLowerMedian.t.sol`.

### H-2 — TWAP reports a stale tick as zero seconds old — **FIXED**
`UniswapV3TwapSource._meanTick` synthesizes its endpoint from the current tick; the live tick's
weight is `min(A, W)/W`, reaching 1.0 once a pool is quiet for the window `W`. `latestPrice`
hardcoded `updatedAt = block.timestamp` (`:255`), so a stale tick voted as fresh, and the constructor
never required `maxObservationAge < window`. An earlier single-block-manipulation claim was **refuted
against itself** (a swap writes an observation stamping the pre-swap tick, resetting `A`). What
survives is the freshness misreport on an honestly-quiet pool. Fixed: the constructor now requires
`maxObservationAge <= window / 20` (≤5% contamination). Regression: `AuditTwapRealCostModel.t.sol`,
`AuditTwapFaithfulMock.t.sol`.

### H-3 — The repo's own V3 mock made H-2 undetectable — **FIXED**
`OracleSourceMocks.sol` generated cumulatives from a single current tick, so a correct historical
TWAP and a live-tick extrapolation were numerically identical — no assertion in the 58-test Sprint-11
oracle suite could fail for H-2's class. This is why H-2 survived internal review. Fixed by replacing
the linear mock with a faithful observation-ring port (`FaithfulUniV3Pool.sol`). Test-only change.
Regression: `AuditTwapFaithfulMock.t.sol` (8 tests + the faithful pool).

### H-4 — EX-2's oracle-bounded slippage was never implemented — **FIXED**
Both execution paths compared the measured output delta only against the **caller-supplied**
`minAmountOut` (1 wei suffices); the oracle was never consulted on the execution path. The measured-
delta check defends against a lying router (EX-3) but is not a slippage bound. Fixed:
`executeRebalance` now bounds every leg against the vault's own oracle at
`MAX_REBALANCE_SLIPPAGE_BPS = 200` (2%), a protocol constant (a creator-set value would be a silent
no-op, M-6). Cost 375 VaultCore bytes.

### H-5 — Child positions marked at gross look-through value — **DORMANT-AT-LAUNCH**
`_childValueWad` marks the parent's child position at gross NAV; realization always returns strictly
less (child exit fee, 10% perf fee, in-kind truncation), and SV-5 draws idle first, so the first
exiter extracts the un-accrued realization drag from the remainers ($18 on identical deposits in the
PoC). Requires a funded child → **dormant at launch** under [[root-vaults-only]]; deferred with
sub-vaults.

### H-6 — `ExitNeedsChildSettlement` is structurally unsatisfiable — **DORMANT-AT-LAUNCH**
The shortfall loop sizes the child unwind **gross** but the child repays **net**, so a residual
always survives the 1e-6 tolerance and `_settleExit` reverts; `++i` never revisits a child. Ordinary
child fees and in-kind truncation (not just failing transfers) hit it on the default config,
converting an unconditional exit right into a governance-liveness dependency. Requires a funded child
→ **dormant at launch**; deferred with sub-vaults. (Its closure is also why the broken
`redeemFromChild` escape hatch no longer matters at launch.)

### H-7 — A frozen child governance strands the parent's exit — **DORMANT-AT-LAUNCH**
C-2 applied to a *child*: `_childPendingExecution` returns true forever, the shortfall loop skips
that child, `redeemFromChild` reverts `ChildSettlementPending`, and the parent's members never chose
the child's config. Fixing C-2 removes the trigger. Requires a parent/child pair → **dormant at
launch**; deferred with sub-vaults.

### H-8 — The `<5`-member quorum regime is stake-blind and its boundary is purchasable for dust — **PARTIALLY FIXED + config-mitigated**
The regime is selected by head count alone; a proposer buys the 5th seat for one `minDepositUsdc` to
flip into the stake regime, or uses dust sybils to pass/grief in the signer regime. Status moved
PLAUSIBLE → CONFIRMED by test. Fixed in code: the signer regime now also requires the FOR side to
clear the stake quorum (kills the zero-stake sybil pass) and passes on an outright FOR-stake majority
regardless of head count (kills the dust-griefing lockout) — additive, so no M-6 liveness cliff. The
**regime-flip (buy the 5th seat) has no safe contract fix** and is **config-mitigated**: `minDepositUsdc`
must be economically meaningful (base-mainnet.json smoke minimum raised 1 → 100 USDC). This is the
key open High for a root-only launch. Regression: `AuditQuorumRegimeDust.t.sol` (3 tests).

### H-9 — Read-only cross-contract reentrancy through look-through NAV — **DORMANT-AT-LAUNCH**
`executeRebalance` and `_redeemChildMeasured` leave a `VaultCore`'s accounting understated during an
external call; `nonReentrant` protects *that* vault, not an ancestor reading it through unguarded
views inside `_childValueWad`/`_fullNavWad`. Per-contract mutex is definitionally no defence against a
different contract reading mid-mutation — Slither's blind spot coincides. Requires a parent/child pair
→ **dormant at launch**; deferred with sub-vaults.

## Links

- [[c1-empty-electorate]] (closes H-5/H-6/H-7/H-9 as a class) · [[c4-depressed-price-theft]] ·
  [[c6-oracle-byzantine]] · [[root-vaults-only]]
- [[oracleaggregator]] · [[oracle-sources]] · [[chainlinkoracle]] · [[governance]] · [[vaultcore]] ·
  [[execution-adapters]] · [[sub-vaults]]
- [[mediums-and-lows]] · [[threat-model-commitments]] · [[slither-triage]] · [[security-index]]
