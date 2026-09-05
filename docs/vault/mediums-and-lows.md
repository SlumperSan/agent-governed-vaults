# Mediums and Lows

The 15 Medium and 7 Low findings, with the report's launch disposition for the root-only
configuration. Most Mediums are fixed; the rest are accepted design tradeoffs, config-mitigated, or
dormant at launch.

## Why it matters

The Medium tier is where "value extraction or governance distortion" lives, plus the deploy-tooling
and reference-config defects that make the mainnet config NOT-DEPLOYABLE. Several Lows are the
enablers (L-1) or the zero-margin coincidences (L-2) behind larger findings.

## Mediums

- **M-1**: `OracleAggregator` accepted the same source address repeated (`[S,S,S]` had median `S`);
  SF-1 independence unenforced. **FIXED** (O(m²) distinctness loop).
- **M-2**: USDC settlement legs used reverting `safeTransfer`, not the EE-6 `tryTransfer`+escrow, so
  a blacklisted `feeEngine` (a shared singleton) bricks every fee-paying exit protocol-wide;
  falsifies PX-1. **FIXED** (both USDC legs routed through `tryTransfer` + `claimable`). Cost 504
  VaultCore bytes, affordable only because M-11 returned 336.
- **M-3**: `FeeEngine.pullEscrowed` is unguarded and its balance delta straddles a full-gas external
  call (double-credit). **FIXED** (mutex / credit-from-callee). ERC-777 specifically does not work.
- **M-4**: a settlement token with `dec < 6` bricks redemptions via the truncation-dust check.
  **FIXED** (`require(usdcScalar <= SHORTFALL_DUST_WAD)`).
- **M-5**: `navWad()` costs ~12M gas at the `MAX_CHILDREN` 8×8 fan-out (~730 `priceWad` calls vs the
  fixture's 6); no path removes a child, so the tree can cross the block gas limit permanently.
  **DORMANT-AT-LAUNCH**: the fan-out needs sub-vaults; at launch `navWad` loops the basket only
  (≤10).
- **M-6**: the only worked config disabled its own CM-6/VO-5 defences (`proposalThresholdBps = 0`,
  `concentrationCapBps = 10000`, `proposalCooldown = 0`, the last unvalidated). **FIXED** (concentration
  ceiling + `proposalCooldown` bounds shipped; configs corrected). The `proposalThresholdBps` floor
  was implemented, measured, and **reverted**: a fraction-of-live-stake floor a constructor cannot
  see is C-2 shape (pinned in `AuditProposalThresholdFloor.t.sol`).
- **M-7**: serial-proposal exit freeze: `propose → wait → finalize(Defeated) → propose` freezes exits
  on a ~50% duty cycle for gas. **NOT mitigated**: the `proposalCooldown` floor is per-proposer and a
  second address sidesteps it. Accepted residual, bounded by the ≥1h commit phase.
- **M-8**: voters approve an opaque 32-byte `actionHash`; no on-chain payload disclosure.
  **Accepted design tradeoff**: deliberate front-running (MEV) protection; the lapsed-`deadline`
  sub-part is bounded by H-4's 2% slippage cap.
- **M-9**: settlement timing is a free option over the exit performance fee (`gain/10`).
  **Accepted**: bounded by `gain/10` and permissionless-crank market timing.
- **M-10**: commit-reveal binds an address, not an actor: a whale splitting stake gets an informed
  last-mover reveal at the cost of the forfeited half. **Accepted (VO-7 residual)**: inherent to
  per-address commit-reveal.
- **M-11**: `SafeTransferLib`'s non-`try` helpers are returndata-unbounded (MO-2 covers one of four
  call shapes). **FIXED**: bounding the copy; the bounded-assembly path also returned 336 VaultCore
  bytes, which made M-2 affordable.
- **M-12**: the `VERIFIED-ON-CHAIN` badge licenses less than it appears (1 of 22 checks hard-coded
  pass; `maxObservationAgeSeconds` never checked). **FIXED** (earlier remediation).
- **M-13**: no deploy script consumes `base-mainnet.json`; the mainnet script has strictly weaker
  post-conditions than the testnet one. **Deploy tooling**: not a contract defect; blocking for a
  real mainnet deploy (tracked with #41), not for the contract security posture.
- **M-14**: gas-capped `view` callers get a silently wrong (smaller-`k`, minimum) NAV; every
  state-changing path is refuted with a number (a starved-source deposit needs > block gas limit).
  **View-only, no funds at risk**: an integration constraint (do not gas-cap NAV reads).
- **M-15**: no slippage/deadline protection on entry or exit; every deposit/exit is an unbounded
  market order (the user-side half of C-4/H-1/H-2). **PARTIALLY FIXED**: a backward-compatible
  `deposit(uint256 amountUsdc, uint256 minSharesOut)` overload reverts `SlippageExceeded`; deadline
  dropped (both settle in-block) and exit-side `minValueOut` dropped for the byte budget (283 B left).
  Partially subsumes C-4's deferred defence-in-depth. Regression: `AuditDepositSlippage.t.sol`.

## Lows

- **L-1**: `VaultFactory.createChildVault` performed no authorization on `parent`; the enabler that
  removes the timelock race in C-1. **FIXED** (`msg.sender == parent.creator()`, commit `b50f652a`);
  now moot at launch behind the C-1 `allowSubVaults` gate but retained for the enabled path.
- **L-2**: `SHORTFALL_DUST_WAD` passes at 6 decimals with exactly zero margin (`1e12 − 1` vs `1e12`).
  **FIXED** (assert the invariant).
- **L-3**: `BoundedCall` returns a word built from uninitialised memory for 1–31-byte returndata;
  `VaultCore.sol:588` does not gate on `retSize`. **FIXED** (zero `ptr` / gate on `retSize`); bounded
  to Low by the `gain/10` clamp.
- **L-4**: `minCardinality: 900` in `base-mainnet.json` is off by one (900 slots span 1798 s < 1800 s
  window → constructor reverts). Fails closed; not currently triggered. Config note.
- **L-5**: basket admission validates only `decimals() <= 18`; rebasing / double-entrypoint tokens
  break accounting. **Accepted (creator-disclosed)**: a per-vault listing constraint.
- **L-6**: SV-6 quorum-floor inheritance is never re-checked on children. **DORMANT-AT-LAUNCH**:
  needs children; deferred with sub-vaults.
- **L-7**: asymmetric absentee recall: `clearStandingDefault` is revocable mid-reveal while
  `setDelegate` is locked. **Accepted asymmetry**: the standing default is the weaker, tally-only
  instrument (never counts toward quorum), so member opt-out is defensible.

## From the Slither triage

- **T-1** (Low, Slither `timestamp` triage): a standing default's VO-3 TTL is measured when the
  default is APPLIED, and `applyStandingDefault` is callable only from the reveal phase, so the
  commit phase consumes part of the 72h and the usable life is `DEFAULT_TTL - cfg.commitDuration`.
  `_validateConfig` bounded `commitDuration` to `[1h, 30 days]` and never related it to
  `DEFAULT_TTL`, so a vault registered at `commitDuration >= 72h` (legal, silent, no event) had
  every standing default provably expired before its reveal window opened, killing VO-3
  permanently for that vault. Low: defaults never touch quorum (VO-2/K-3) and are Rebalance-only
  (VO-4), so the consequence is direction-only; and both shipped configs use `commitDuration: 3600`,
  so the total-kill variant was never reachable at launch. **FIXED**: `COMMIT_HARD_CAP` is now
  `DEFAULT_TTL - 1` instead of `30 days`, making the dead configuration unrepresentable at both
  `_validateConfig` call sites (`registerVault` and `execute`'s RuleChange branch). No runtime path
  changed. **Deliberately NOT fixed by re-anchoring the TTL to `p.createdAt`**: that would stretch
  the maximum staleness of an applied default to `DEFAULT_TTL + cfg.commitDuration`, and VO-3's
  accepted disposition is precisely the upper bound on that staleness. Regression:
  `AuditStandingDefaultTtlVsCommit.t.sol` (8 tests, 12/12 mutations caught).

## Informational

I-1 (Pyth `conf` unvalidated pre-deploy), I-2 (`MODULE_CALL_GAS = 300_000` hardcoded on an immutable
protocol), I-3 (`base-mainnet.json` self-contradictory status field), I-4 (dead code + four
concentration-cap doc sites contradicting the code), I-5 (fees strandable in `FeeEngine`). Recorded,
low or no action.

## Links

- [[oracleaggregator]] · [[oracle-sources]] · [[chainlinkoracle]] · [[feeengine]] · [[vaultcore]] ·
  [[governance]] · [[vaultfactory]] · [[safetransferlib]] · [[execution-adapters]]
- [[highs]] · [[c4-depressed-price-theft]] · [[c1-empty-electorate]] · [[root-vaults-only]] ·
  [[threat-model-commitments]] · [[slither-triage]] · [[security-index]]
