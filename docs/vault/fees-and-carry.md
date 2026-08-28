# Fees and Carry

**Definition.** The performance-fee system: a 10% fee on *realized profit* crystallized only at
member redemption ([[feeengine]]), with a high-water mark carried as a **USDC-denominated loss
carryforward per `(member, operator)`** across all vaults sharing the [[operatorregistry]].

**Why it matters.** The cross-vault HWM is what makes "no cherry-picking" real: an operator can't
shed a losing track record by minting a fresh identity, and a member who lost under an operator
pays no fee elsewhere until made whole. This is the **operator-registry immutable reference,
commitment C-3** — load-bearing on VaultCore's redemption path from day one.

## Performance fee (goes to the operator)

`PERF_FEE_BPS = 1_000` (10%), on **realized profit only**, crystallized **only at member
redemption** (CM-3) — realization is member-initiated by construction, so an operator cannot churn
rebalances to force early fees. This is a **different mechanism** from the exit fee, which stays in
the vault and accrues to remaining members ([[two-mode-exits]]) — the exit fee is described there,
not here.

## Cross-vault HWM as loss carryforward (commitment C-3, §7)

NAVps is not comparable across vaults, so the portable mark is USDC-denominated carry:

```
onRealize(member, op, gain):  fee = 10% × max(0, gain − carry[member][op])
                              carry[member][op] = max(0, carry[member][op] − gain)
onRealize(member, op, loss):  carry[member][op] += loss
```

The engine reads carry **pre-update** from the registry; the registry consumes it afterward in the
same settlement. A member who realized a loss under operator X in vault A pays no performance fee
in vault B until X has made them whole. No prior art — Enzyme/dHEDGE use global per-vault marks —
so this is treated as an **unvalidated mechanism** with extra invariant weight (§7 novelty).

## Registry-gated integrity

- Carry accrues **only** from vaults deployed by the canonical [[vaultfactory]] against the
  canonical registry (CM-5) — else marks would be forgeable via throwaway vaults. Single-vault
  carry-farming remains a documented residual (G3), gated economically by the 1% exit-fee cap
  forcing ~100:1 transient capital fronting plus leaderboard reputation drag — a deterrent, not a
  code fix.
- **Leaderboard:** operator-level aggregate across **all** vaults sharing the registry; no per-vault
  opt-out at the contract level. Aggregates only canonical-factory vaults; TVL-weighted and
  member-count-weighted views stop dust vaults dominating (SF-4). Closed-vault history is retained
  permanently — an operator can't wind down losers to shorten their loss window (SF-5). A fresh
  identity = zero track record, making a reset visible and costly (CM-4; residual: reputation, not
  funds, is the enforcement).

## Hostile-module and payout defenses

- The vault may **clamp** the returned fee (hostile-module defense) and reports what it actually
  transferred via `onFeeCollected`; operators are credited strictly from *collected* amounts.
- FeeEngine has its **own** reentrancy mutex (M-3) — it does not inherit VaultCore's, since a
  nested `pullEscrowed` targets a *different* vault.
- Fee withheld **uniformly** across cash and in-kind legs; asset-leg fees credited to the operator
  via the engine's per-token claim flow (MO-4 — otherwise fully-invested vaults would pay ~zero
  fee). Fee-assess vs carry-record are separate bounded calls; `MODULE_CALL_GAS = 300k` covers the
  carry write (G5, not atomic but not exploitable at current params).
- Operator-as-member receives the exit fee only via their member share like anyone else; the
  prohibition is on *routing*, and routing is to shares, not identity (EE-9, **ACCEPTED**).

## Links

- [[architecture-overview]] · [[two-mode-exits]] (exit fee, the other fee) · [[nav-and-shares]]
  (realization) · [[sub-vaults]] (fee stacking cap) · [[off-chain-stack]] (leaderboard indexer)
- Contracts: [[feeengine]] · [[operatorregistry]] · [[vaultcore]] · [[safetransferlib]]
- Security: [[threat-model-commitments]] · [[mediums-and-lows]]
