# Walkthrough — DirectPoolAdapter.sol

**Risk: High (external calls), structurally simpler than the router adapter.** ~94 LoC.
`contracts/src/DirectPoolAdapter.sol`.

## Purpose

A **second** `IExecutionAdapter` implementation that swaps directly against one
Uniswap-V2-style pair, with the amount-out computed on-chain from reserves. It exists to
*prove* the venue abstraction (C-2): `VaultCore.executeRebalance` drives it identically to
the aggregation adapter although the venue shape is completely different — no off-chain
calldata, no selector allowlist (`test_governedRebalanceThroughDirectPoolAdapter`). If a
reviewer wants to check that VaultCore has no hidden venue assumptions, diffing the two
adapters against the interface contract is the fast way.

## Mechanism

- One immutable `pair` per adapter instance (the analog of the pinned router); `token0`/
  `token1` cached at construction. `FEE_BPS = 30` (canonical V2 fee).
- `executeSwap`: validate deadline / minOut>0 / amountIn>0 / tokenIn≠tokenOut / both tokens
  in the pair → pull input → read reserves → compute constant-product quote → transfer input
  to the pair → `pair.swap(...)` → measure output delta → `require(delta ≥ minAmountOut)` →
  send output to caller.

The same safety contract as the router adapter holds: **minOut and deadline enforced here on
measured deltas** (EX-3), never trusting the quote or any external return value, and the
`routeData` field is simply ignored.

## Review focus

1. **Reserve read vs. swap atomicity:** the quote is computed from `getReserves` in the same
   transaction; a sandwich moves reserves before this transaction executes, which surfaces as
   the measured delta failing `minAmountOut` — the caller's floor is the real protection, the
   quote is just sizing. Verify no path pays out on the quote rather than the delta.
2. **Token quirks:** fee-on-transfer input tokens under-deliver to the pair (V2 `swap` then
   reverts on K); rebasing/callback tokens interact with the delta measurement. Bounded by the
   vault-side re-measurement and `nonReentrant`.
3. **No approval surface at all** on this path (direct transfer to the pair) — one less thing
   to audit; confirm the leftover-input story (none should exist here because the full
   `amountIn` goes to the pair).

## Accepted risks here (do not re-report)

- Ordinary V2 MEV exposure bounded by `minAmountOut` (EX-2 residual, as with the router
  adapter).
- A creator allowlisting an adapter pinned to a pathological pair is a visible-at-creation
  config choice (PX-3-class), not a protocol control.
