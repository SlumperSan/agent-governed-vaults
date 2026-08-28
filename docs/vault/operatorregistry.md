# OperatorRegistry

The canonical registry of operator identity, cross-vault loss carryforward, and the aggregate
leaderboard. `contracts/src/OperatorRegistry.sol`. The **C-3 load-bearing reference** — every vault
holds it as an immutable from day one.

## Why it matters

(Note: the "C-3 load-bearing" tag on this contract and on VaultCore's `operatorRegistry` immutable
is a **threat-model** item — the registry must be wired from day one — and is a *different*
numbering from HOME's [[c3-oracle-brick]] critical, which is the oracle malformed-returns finding
that lives in [[oracleaggregator]]. Do not conflate the two C-3s.)

Three requirements meet in one contract, and each is a trust anchor for the off-chain reputation and
fee system:

1. **HWM portability (§7)** — the per-`(member, operator)` USDC loss carryforward. A member who
   realized a loss under an operator in one vault pays no performance fee under that operator in
   another until made whole. Carry mutates **only** through attested vaults.
2. **Leaderboard integrity (SF-4 / SF-5)** — lifetime gain/loss/fees accumulators per operator,
   aggregated across ALL attested vaults, **monotone**: closed vaults' history is retained,
   wind-downs recorded, nothing ever decremented. No cherry-picking is possible.
3. **Anti-Sybil (CM-4)** — identity is the registry id. A fresh identity escapes its loss carry but
   restarts at zero track record — visible and reputation-costly by construction.

Only vaults deployed by the canonical [[vaultfactory]] are attested (CM-5), so throwaway-vault
mark-farming requires real, visible vaults.

## Key state

- `operatorIdOf`, `operatorAddressOf`, `operatorCount` (ids start at 1; 0 = unregistered).
- `_vaultOperator[vault]` — opId (0 = unattested).
- `carryOf[member][opId]` — the portable HWM loss carryforward, USDC.
- `statsOf[opId]` — `OperatorStats { lifetimeGainUsdc; lifetimeLossUsdc; lifetimeFeesUsdc;
  vaultCount; }` (all monotone).
- `factory` and `feeEngine` — one-shot `wire`, deployer-only, locked after.

## Entry points

- `registerOperator(address)` — permissionless and harmless (grants no authority, cannot rebind an
  existing operator, CM-4).
- `attestVault(vault, operator)` — **factory-only** (CM-5); auto-registers a new operator.
- `recordRealization(member, gainUsdc, lossUsdc)` — **attested-vault-only**; losses build the carry,
  gains consume it. Called at redemption settlement **after** [[feeengine]] has read the
  pre-realization carry (call order fixed in `VaultCore._settleExit`).
- `recordFeeCollected(opId, amountUsdc)` — **feeEngine-only**, feeds the aggregate stats.
- `leaderboardEntry(opId)` — the aggregate, all-vaults-included record.

## Findings

No open finding lives in this contract; it is the **reference implementation** the C-3 remediation
leans on (a load-bearing dependency wired into VaultCore at construction, never zero). Its
correctness properties — factory-gated attestation (CM-5), monotone accumulators (SF-5), and the
fixed call order with [[feeengine]] — are what make the marks and the leaderboard trustworthy. The
`recordFeeCollected` caller restriction (`OnlyFeeEngine`) and the `attestVault` restriction
(`OnlyFactory`) are the one-shot-wired authority boundaries that keep the record from being forged.

## Links

- [[contracts-index]] · [[feeengine]] · [[vaultfactory]] · [[vaultcore]]
- Architecture: [[fees-and-carry]]
- Findings: [[threat-model-commitments]] · [[security-index]]
