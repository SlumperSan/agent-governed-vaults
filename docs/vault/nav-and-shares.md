# NAV and Shares

**Definition.** How [[vaultcore]] values the basket (NAV), converts between USDC and vault
shares, and admits new capital through the observation window: all in WAD (1e18) internally,
with USDC (6 decimals) scaled only at the boundary.

**Why it matters.** Every deposit, redemption, fee, and vote weight is denominated against this
accounting. Getting the pending-capital exclusion and forward pricing right is what defeats
donation-style NAVps distortion (EE-1) and stale-valuation minting.

## Not ERC-4626 (commitment C-1)

In-kind redemption, swing pricing (specified only), and forward pricing each break
`previewRedeem`/`previewWithdraw` round-trip guarantees, so the vault makes **no 4626 compliance
claim**. It exposes 4626-shaped *read-only* views (`totalAssets`, `convertToShares`,
`convertToAssets`) for tooling, documented indicative-only. (This is *commitment* C-1, distinct
from *audit* C-1, the empty-electorate critical [[c1-empty-electorate]].)

## Definitions

```
NAV    = Σ_i balance_i × price_i  +  idleUSDC        (USDC terms, WAD internally)
NAVps  = NAV × WAD / totalSupply                     (WAD; first deposit: 1e18)
```

`price_i` comes from the oracle ([[oracle-layer]]). **Sequestered (pending) deposits are excluded
from NAV and from `idleUSDC` until activation.** If the oracle breaker is tripped, every NAV-
reading function reverts: deposits, redemptions, execution, by design (K-4, **ACCEPTED**).

Share math never reads raw `balanceOf`; it uses internal escrow accounting (defeats EE-1 donation
manipulation). Rounding is always **against the actor** (mint rounds shares down, payout rounds
down, fees round up), so dust accrues to the vault and the NAVps-non-decreasing invariant holds.

## Deposit and forward pricing on entry

Post-window (or window-skipped, or repeat deposit):

```
sharesMinted = amount × totalSupply / NAV        (amount × WAD / 1e18 if supply == 0)
```

Minted at the NAV of the *activation* transaction, **forward pricing on entry**, so a depositor
can never mint against a stale valuation they observed 4 hours earlier.

## Observation window (entry)

- An agent's **first** deposit escrows USDC as a *pending deposit*: excluded from NAV, zero
  shares, zero voting/proposal rights. After `OBSERVATION_WINDOW = 4 hours` anyone calls
  `activate`, minting shares at activation NAV. Pending deposits are cancellable before activation.
- **Skip:** an agent may irrevocably opt in to skipping the window for a given vault: shares mint
  immediately. Once per agent per vault, cannot be undone. Repeat deposits by an existing member
  mint immediately.
- The window is a **social/observational** mechanism, **not** the Sybil defense. Flash-deposit
  governance attacks are stopped by proposal-time stake snapshots ([[governance-commit-reveal]],
  VO-9), not the window (EE-3).
- **Pending capital is never frozen.** `cancelPending` reads no oracle, so an un-activated deposit
  is always reclaimable even while the breaker is tripped (resolves OQ-1; verified by
  `test_pendingDepositCancellableDuringOracleFreeze`). Only *active* share capital is trapped.

## Other VaultCore accounting rules

- **Shares are non-transferable in Sprint 1** (EE-7), this moots share-aging fee dodges until
  transferability is ever proposed.
- **Creator 5% is a *withdrawal gate*, not a solvency condition** (`CREATOR_MIN_STAKE_BPS = 500`).
  Creator redemptions revert if they would take creator share below 5% while ≥1 non-creator member
  remains. Passive dilution below 5% by others' deposits is allowed and merely freezes creator
  withdrawals until restored (CM-2). "Freezes" is literal: below 5% no burn amount passes, and
  past 95% external fill the cap blocks the restoring top-up, see `docs/NOW.md` traps and
  `test/audit/AuditCreatorGateTraps.t.sol`.
- **Capacity cap is OPTIONAL.** `capacityCapUsdc == 0` opts out (uncapped); `isCapped()` reports
  which. When set, deposits above cap revert.
- `MAX_BASKET_ASSETS = 10` bounds NAV-loop gas (E8).

## Links

- [[architecture-overview]] · [[two-mode-exits]] (redemption side) · [[oracle-layer]] (price_i) ·
  [[fees-and-carry]] (realization at redemption) · [[governance-commit-reveal]] (eligible stake)
- Contracts: [[vaultcore]] · [[oracleaggregator]] · [[safetransferlib]]
- Security: [[c1-empty-electorate]] · [[threat-model-commitments]]
