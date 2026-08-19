# Walkthrough — AggregationRouterAdapter.sol

**Risk: High (external calls with off-chain-supplied calldata).** ~76 LoC.
`contracts/src/AggregationRouterAdapter.sol`.

## Purpose

The first concrete `IExecutionAdapter`: swap execution through a DEX-aggregation router
(0x/1inch-style) using off-chain-computed route calldata. This is the contract class behind
the 2026 arbitrary-calldata exploits (SwapNet/Aperture ~$13–17M; earlier Dexible, Unizen,
LI.FI), all sharing one root cause — trusting off-chain-supplied call targets/calldata. Every
hardening below exists because of that history (EX-1..EX-3, RESEARCH-SPRINT1).

## The hardening, point by point

| Defense | Mechanism |
| --- | --- |
| No attacker-chosen target | `router` is **pinned immutable** at construction — `routeData` cannot choose where the call goes (EX-2) |
| No arbitrary function | `routeData`'s 4-byte selector must be on the **construction-time allowlist** (EX-1); ≥4 bytes required |
| No trusted slippage | `minAmountOut > 0` is mandatory; enforced HERE on the **measured tokenOut balance delta**, never on router return values or calldata-embedded params (EX-3) |
| No stale execution | `deadline` enforced here, `block.timestamp`-compared (C-2) |
| No approval residue | Approve exactly `amountIn` pre-swap, **revoke to 0 after** — no cross-transaction approval remains for a router upgrade to abuse (EX-2) |
| No stranded partials | Unspent `tokenIn` is swept back to the caller after the swap |

Call sequence: pull `amountIn` from caller → approve router → snapshot `tokenOut` balance →
`router.call(routeData)` (must succeed) → measure delta → `require(delta ≥ minAmountOut)` →
revoke approval → send output + leftover input back to caller.

## Trust position

The adapter is chosen by the vault creator via the construction-time **adapter allowlist** in
VaultCore (EX-1: members signed up for these venues; changing venues means a new vault). Even
so, VaultCore does not trust the adapter's arithmetic: `executeRebalance` re-measures the
output on the **vault's own** balance of the fixed, basket-constrained `tokenOut` and enforces
the order's `minAmountOut` again. A malicious adapter can at worst fail swaps or waste the
input leg it was approved for in that transaction — it cannot misreport its way into vault
accounting.

## Review focus

1. **Selector-allowlist bypass surface:** an allowlisted router selector whose argument
   structure lets `routeData` embed a nested arbitrary call (router-dependent — the allowlist
   is only as good as the chosen selectors; this is a deployment-review item, flag anything
   that makes a dangerous selector look safe).
2. **Token callbacks:** `amountOut` is measured as a same-address balance delta; a
   fee-on-transfer or reentrant `tokenOut` interacts with the delta measurement (vault-side
   re-measurement + `nonReentrant` on the vault bound the blast radius).
3. **The `router.call` is intentionally unbounded** (unlike module calls): a malicious router
   can consume gas or revert — that fails the rebalance transaction, which is governance-
   initiated and retryable; it never touches member exit liveness.

## Accepted risks here (do not re-report)

- **EX-2 residual:** sandwich/MEV on rebalance execution is bounded by `minAmountOut`, not
  eliminated; private-mempool submission is an off-chain operator concern (documented).
- A creator who allowlists a bad router+selector set at creation builds a vault whose
  rebalances can fail or leak slippage — visible on-chain pre-deposit; PX-3-class "read the
  config" risk, not a protocol control.
