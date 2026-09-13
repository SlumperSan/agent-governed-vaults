# FeeEngine

The performance-fee module: 10% on realized profit, high-water-mark via a cross-vault loss
carryforward read from [[operatorregistry]]. A factory-wired singleton shared by every vault.
`contracts/src/FeeEngine.sol`.

## Why it matters

This is where a member's realized gain becomes an operator's fee. Crystallization happens **only at
member redemption** (CM-3): [[vaultcore]] calls `onRealize` with the member's realized P&L, the
engine nets it against the `(member, operator)` loss carry (read pre-update; the registry consumes
it afterward in the same settlement), and returns 10% of the **net** gain. Because it is a
singleton touched by every vault's exit path, a bug here, or the engine's own address being
blacklisted by a stablecoin issuer, is a systemic exit-liveness risk, which is exactly what two of
its findings address.

## Key state

- `PERF_FEE_BPS` = 1000 (10%).
- `registry` (immutable): the `IRegistryView` for carry reads, identity, and fee stats.
- `claimableFees[operator][token]`: collected fees awaiting operator claim.
- `_lock`: a reentrancy mutex (M-3, see below).

## Entry points

- `onRealize(member, gainUsdc, lossUsdc)`: returns the assessed fee. Requires the caller be an
  attested vault (`operatorOf(msg.sender) != 0`).
- `onFeeCollected(member, amountUsdc)` / `onFeeCollectedAsset(member, asset, amount)`: the vault
  reports what it **actually transferred**; operators are credited strictly from collected amounts.
  USD-terms stats are recorded on the cash leg only.
- `pullEscrowed(vault, asset)`: permissionless crank to pull an in-kind fee slice the vault
  EE-6-escrowed after a failed transfer, and credit it to the vault's operator.
- `claimFees(token)`: operator withdraws accumulated fees.

The vault treats this module as **untrusted**: it clamps the returned fee to <= 10% of gain
(`gain / 10`) and calls the engine **bounded and non-blocking** (H-1). A hostile or broken engine
loses its own bookkeeping, never a member's exit; see [[vaultcore]].

## Security findings that live here

- **M-3 (cross-vault reentrancy).** `FeeEngine` had **no mutex**, and it does **not** inherit
  VaultCore's: `pullEscrowed` measures a balance delta straddling a full-gas external call
  (`claimEscrowed`) that a hook token can re-enter, and the nested call targets a **different**
  vault, so that vault's own guard is not on the path. The arithmetic: an inner `pullEscrowed`
  credits its own `X`; the outer frame then measures the whole delta `X + X2` and credits that too,
  so `2X + X2` is credited against `X + X2` delivered; whoever claims first is paid from another
  operator's balance. Fixed with a **whole-engine** `nonReentrant` (per-vault would not see the
  cross-vault nesting); `claimFees` and `pullEscrowed` both guarded. (Note: the report records that
  ERC-777 specifically does **not** work here; this engine is not an ERC-1820 implementer, but that
  closes one hook mechanism, not the class.)
- **M-2 (escrow of the USDC fee leg): remediated in [[vaultcore]], systemic *because of* this
  contract.** `feeEngine` is the shared singleton and exactly the address class a stablecoin issuer
  blacklists. Once listed, a reverting `safeTransfer(feeEngine, ...)` made **every** exit carrying a
  positive performance fee, in **every** vault, revert permanently. VaultCore now degrades that leg
  to escrow. See [[fees-and-carry]] and [[mediums-and-lows]].

## HWM portability

The high-water-mark is **portable across vaults per operator**: a member who realized a loss under
an operator in vault A pays no performance fee under that operator in vault B until made whole. The
carry lives in [[operatorregistry]] (`carryOf[member][opId]`); FeeEngine reads it, VaultCore's
`_recordRealization` mutates it afterward.

## Links

- [[contracts-index]] · [[operatorregistry]] · [[vaultcore]] · [[subvaultregistry]]
- Architecture: [[fees-and-carry]]
- Findings: [[mediums-and-lows]] · [[threat-model-commitments]]
