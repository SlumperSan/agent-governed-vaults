# VaultCore

The single contract that **holds all vault funds** and does all share accounting: deposits with a
4-hour observation window, two-mode redemption, in-kind payout with per-asset escrow isolation,
tenure-decaying exit fees, capacity caps, cost-basis tracking, rebalancing, and sub-vault
allocation. `contracts/src/VaultCore.sol`.

## Why it matters

This is the custody contract. Every USDC and every basket token a member deposits lives here, and
every payout leaves from here. There is no admin, no upgrade path, and no setter: the constructor
fixes every trust-relevant parameter and the code is immutable after. It is **not ERC-4626**
(commitment C-1): redemption is in-kind, pricing is forward, and the 4626-shaped views
(`totalAssets`, `convertToShares`, `convertToAssets`) are labeled **indicative only**. Because it
holds the money and can never be patched, it is also the contract where the **EIP-170 size cap is
binding** — several audit fixes could only be afforded by first *shrinking* other code.

## Key state

- **Immutables:** `usdc`, `usdcScalar` (`10**(18-decimals)`, read at runtime — never assumed),
  `creator`, `operatorRegistry`, `governance`, `feeEngine`, `oracle`, `subVaultRegistry`,
  `capacityCapUsdc` (0 = uncapped), `minDepositUsdc`, `exitFeeMaxBps` (<= `EXIT_FEE_CAP_BPS` = 100),
  `exitFeeDecayPeriod`, and the `isAllowedAdapter` allowlist.
- **Basket:** `basketAssets[]` (<= `MAX_BASKET_ASSETS` = 10), `assetUnit`, internal `assetBalance`
  and `idleUsdc` — NAV **never reads `balanceOf`** (donation defense, EE-1).
- **Shares:** `totalShares` (WAD), `sharesOf`, `costBasisUsdc`, `lastDepositTime` (tenure clock),
  `nonCreatorMemberCount`, `holderCount`.
- **Observation window:** `pendingDeposit`, `windowCleared`, `skipOptIn`, `totalPendingUsdc`
  (escrowed, excluded from NAV).
- **Mode-F queue:** `queuedExitShares`, `totalQueuedShares` (locked shares: no vote, no transfer).
- **Snapshots (VO-9):** `Checkpoints.History` for eligible stake, total eligible, holder count —
  read by [[governance]] at `createdAt - 1`.
- **Sub-vaults:** `childVaults[]` (<= `MAX_CHILDREN` = 8), `MAX_LOOKTHROUGH_DEPTH` = 3.
- **Escrow:** `claimable[member][asset]` (EE-6 isolation).

## Entry points

- `deposit(uint256)` / `deposit(uint256, uint256 minSharesOut)` — first-ever deposit escrows into
  the 4-hour window; repeat / window-cleared deposits mint immediately. `minSharesOut` is the M-15
  immediate-path slippage bound.
- `activate(address)` / `cancelPending()` / `skipWindow()` — window lifecycle.
- `requestExit(uint256)` — Mode I (settle now) or Mode F (queue) per `_pendingExecution`;
  `settleQueuedExit(address)` — settle a queued exit once execution is no longer pending.
- `executeRebalance(address adapter, SwapOrder[])` — **governance-only**, allowlisted adapter.
- `allocateToChild` / `redeemFromChild` / `pullChildEscrow` — governance-only sub-vault flows
  (dead at launch, see [[root-vaults-only]]).
- `claimEscrowed(address asset)` — pull an EE-6-escrowed slice.
- Views: `navWad`, `navPerShareWad`, `votingEligibleShares`, `pastVotingEligibleShares`,
  `pastTotalVotingEligibleShares`, `pastHolderCount`.

## Invariants and deliberate properties

- **NAVps is non-decreasing across any redemption** (§4.6): the exit-fee fraction of every slice
  stays in the vault for remaining members. Fee waived for a sole holder (would route to self).
- **Oracle staleness reverts every NAV path, including exits** (K-4 / SF-2). No escape hatch — an
  exit during staleness is exactly the stale-price exit the breaker prevents.
- **Shares are non-transferable** in this design (EE-7).
- **Creator 5% is a withdrawal gate, not a solvency condition** (CM-2): `_checkCreatorGate` binds
  creator *action* while non-creator members remain; evaluated at Mode-F **queue** time (L-1).
- **NAV uses internal accounting only** — a token donation cannot mint free shares (EE-1).

## Security findings that live here

- [[c1-empty-electorate]] — the 4626 non-compliance and indicative-only views are C-1's honest
  labeling; the electorate gate itself is enforced in [[vaultfactory]].
- [[c4-depressed-price-theft]] — the **two-mode exit** (Mode I / Mode F) is C-4's remediation; see
  [[two-mode-exits]]. `requestExit` picks the mode from governance state.
- **H-1** — bookkeeping modules (feeEngine, operatorRegistry) are called **bounded and
  non-blocking** via `BoundedCall` (gas cap `MODULE_CALL_GAS` = 300k). A reverting / gas-guzzling /
  returndata-bombing module loses its own bookkeeping (event-logged) but can never block an exit.
  See [[safetransferlib]].
- **H-4** — `MAX_REBALANCE_SLIPPAGE_BPS` = 200 (2%) bounds each rebalance leg against the vault's
  *own* oracle. Deliberately a **protocol constant, not a creator parameter**: a creator-set
  `maxSlippageBps = 10000` would be a silent no-op — the M-6 mistake. The measured-delta check
  (`received >= minAmountOut`) is a defense against a lying router (EX-3), **not** a slippage bound.
- **M-2** — the USDC fee/payout legs now degrade to **escrow** on a failed transfer, exactly like
  in-kind slices. Previously a blacklisted member (or the singleton feeEngine being blacklisted)
  could permanently brick every exit carrying a positive performance fee. This fix cost 504 B and
  was affordable only because [[safetransferlib]]'s M-11 fix returned 336 B first.
- **M-4 / L-2** — the constructor `require(usdcScalar <= SHORTFALL_DUST_WAD)` pins the settlement
  decimal floor. `dec >= 6` was *required but unenforced*: below 6 decimals almost every exit
  reverted (misleadingly as `ExitNeedsChildSettlement`). It also documents L-2 — at the canonical 6
  decimals the old bound held with exactly **one unit of slack**, by coincidence and undocumented;
  now a constructor invariant.
- **M-15** — `deposit(uint256, uint256 minSharesOut)` is the **immediate-path** slippage defense.
  Exit has no `minValueOut` overload — dropped for the byte budget (documented residual). See
  [[mediums-and-lows]].
- Sub-vault look-through (Sprint-6 Findings 1/4/5) — recursive `_fullNavWad`, skip-child-mid-
  rebalance, and reduce-shortfall-by-what-actually-arrived. Dead at launch.

## Size — EIP-170

VaultCore is the **only** contract meaningfully near the cap. Current margin is **~283 B**.

> Reconciliation (three docs, three points in time): the LAUNCH-READINESS table's **1,014 B**
> predates M-15's `deposit(uint256,uint256)` overload, which spent **731 B** → ~283 B left; the
> AUDIT-HANDOFF **1,182 B** is an earlier intermediate value (before M-11 returned bytes and M-2
> spent them). The overload is present in the current source (`:358`), so ~283 B is the live figure.

This is why **H-5, H-6, H-9 and the exit-side `minValueOut`** all remain unfixed — they land in
VaultCore and several would not fit even alone. Any future VaultCore fix likely requires moving
code out (see [[delegatecall-split-rejected]] for the rejected split).

## Links

- [[contracts-index]] · [[governance]] · [[oracleaggregator]] · [[feeengine]] ·
  [[operatorregistry]] · [[execution-adapters]] · [[safetransferlib]] · [[subvaultregistry]]
- Architecture: [[nav-and-shares]] · [[two-mode-exits]] · [[fees-and-carry]] · [[sub-vaults]]
- Findings: [[c1-empty-electorate]] · [[c4-depressed-price-theft]] · [[highs]] · [[mediums-and-lows]]
- [[threat-model-commitments]] · [[launch-readiness-gates]]
