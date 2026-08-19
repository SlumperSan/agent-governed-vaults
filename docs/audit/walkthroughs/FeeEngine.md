# Walkthrough — FeeEngine.sol

**Risk: High.** ~130 LoC. `contracts/src/FeeEngine.sol`.

## Purpose

The 10% performance fee on realized profit, netted against the cross-vault
per-(member, operator) loss carryforward held by the OperatorRegistry (the portable HWM, §7).
Crystallization happens **only at member redemption** (CM-3) — never on rebalance, so an
operator cannot churn to crystallize early. Collected fees accumulate per (operator, token)
for pull-based claims.

## Trust position

The engine is a protocol singleton, but VaultCore treats it as **potentially hostile on the
exit path** (H-1 philosophy): every call from `_settleExit` is gas-bounded, returndata-bounded
and non-blocking, and the returned fee is clamped by the vault to ≤ 10% of realized gain. The
engine can therefore never block an exit or extract more than the protocol fee. Conversely the
engine trusts only **attested vaults** — every mutating entry point resolves
`registry.operatorOf(msg.sender)` and reverts `UnattestedVault` for opId 0, so arbitrary
contracts cannot mint fee credits or read/consume carry through it.

## State

- `registry` (immutable) — carry reads + operator identity + fee-stat recording.
- `claimableFees[operator][token]` — collected fees awaiting operator claim (USDC *and*
  in-kind asset legs; M-2 uniform withholding means fees arrive in every payout token).

## External entry points

| Function | Caller | What it does |
| --- | --- | --- |
| `onRealize(member, gain, loss)` | attested vault (bounded call) | Gain path: `netGain = gain − carry` (floored at 0), returns `10% × netGain`. Loss path: no-op — losses reach the carry via the vault's own `recordRealization` call |
| `onFeeCollected(member, amountUsdc)` | attested vault, **after** the USDC fee transfer | Credits `claimableFees[operator][usdc]` with the amount **actually sent** (the vault's clamp may have reduced it) and reports it to registry stats |
| `onFeeCollectedAsset(member, asset, amount)` | attested vault, after an in-kind fee transfer | Credits the asset-leg fee at token amounts (USD-terms stats stay cash-leg-only; the indexer prices asset legs, S7) |
| `pullEscrowed(vault, asset)` | anyone (crank) | Claims a fee slice the vault EE-6-escrowed for the engine (failed transfer path) and credits it, measured by balance delta |
| `claimFees(token)` | operator | Pull-payment of accumulated fees |

## Key sequencing invariant (the subtle one)

Within one `_settleExit`, the call order is fixed: `onRealize` reads the carry **pre-update**,
then the vault calls `registry.recordRealization`, which consumes (gain) or builds (loss) the
carry. The "fee assessed ⟺ carry consumed" pairing is therefore **two decoupled best-effort
calls**, not an atomic operation — dispositioned as G5 (documented): both calls sit inside the
same 300k-gas bounded-call budget, the only revert path (`opId == 0`) is impossible for an
attested vault, and any realistic divergence favors the member, never solvency.
`FeeCarryInvariant.t.sol` fuzzes the pairing against a ghost model
(`invariant_carryMatchesGhost`, `invariant_feeNeverExceedsNetGainTenth`).

## Review focus

1. **Credit-from-collected discipline:** operator credits must come only from
   `onFeeCollected*` amounts (what physically arrived), never from the `onRealize` return
   (which the vault may clamp). An undercollected fee is forgiven in the member's favor —
   verify no path books uncollected fees as debt.
2. **`pullEscrowed` delta measurement:** fee-on-transfer or misbehaving assets credit only
   the measured delta; check no double-credit with a later direct `onFeeCollectedAsset`.
3. **Cross-vault flows:** two attested vaults under the same operator interleaving
   settlements — carry reads are per-call, so ordering across vaults in one block is worth a
   thought (registry state is global).

## Accepted risks here (do not re-report)

- **G5:** fee-assess vs. carry-consume non-atomicity (bounded, member-favoring; documented).
- **G3/CM-5:** exit-fee-manufactured losses build real carry — single-vault carry farming is
  economically gated (1% exit-fee cap ⇒ ~100:1 capital fronting + leaderboard drag), not
  code-prevented.
- Asset-leg fees are recorded in token units, not USD, in registry stats — a deliberate
  indexer-side pricing decision, not a lost-fee bug.
