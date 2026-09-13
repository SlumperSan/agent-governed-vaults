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
| No stranded partials | **This order's own** unspent `tokenIn` is refunded after the swap — `refund = min(amountIn, inAfter - inBefore)`, never `balanceOf(tokenIn)` |
| No nested measurement | `nonReentrant` mutex, same shape as `VaultCore._lock` — a nested `executeSwap` would otherwise revoke the outer call's router approval mid-route |

Call sequence: snapshot `tokenIn` balance → pull `amountIn` from caller → approve router →
snapshot `tokenOut` balance → `router.call(routeData)` (must succeed) → measure the `tokenOut`
delta → `require(delta ≥ minAmountOut)` → compute the `tokenIn` refund as this order's own
balance delta, clamped at `amountIn` → revoke approval → send output, then the refund, to the
caller.

## The refund is scoped to the order, and why that is not a detail

`executeSwap` used to end by sweeping `balanceOf(tokenIn)` — the adapter's **whole** balance —
to whoever called. Both halves of that were exploitable, and only one was closed by the
`nonReentrant` guard:

- **Cross-order theft (closed by the mutex, #101).** A counterparty reached through the route
  re-enters with a 1-unit order; the nested sweep hands it the outer order's unspent input.
  600e6 USDC on a 1,000 USDC partial fill.
- **Donation DoS (closed by the scoping, this change).** No reentrancy required. Anyone
  `transfer`s `d` units of `tokenIn` to the shared adapter. The next vault leg is refunded its
  own unspent input plus `d`, and `VaultCore.executeRebalance` — which computes
  `spent = inBefore - inAfter` over **its own** balances — underflows to `Panic(0x11)` whenever
  `d` exceeds what the route actually pulled. The griefer then recovers `d` with a 1-unit order,
  so the cost is gas and it is repeatable. `VaultCore.isAllowedAdapter` is **constructor-only**,
  so every vault built against that bytecode is affected permanently, with no repointing path.

The refund is now this order's own delta, the shape `VaultCore.executeRebalance` already carried
(find it by its expression, `spent = inBefore - inAfter`, not by a line number) (S6
Finding 3 / threat-model row E3 — *"never from a whole-vault balance-vs-accounting comparison"*).
Two clauses, two attacks, and each has its own executing test:

- `inAfter - inBefore` excludes `tokenIn` that was already sitting in the adapter. It is also
  what makes the cross-order theft **impossible** rather than merely unreachable: there is no
  longer a sum for a nested call to walk off with.
- The `min(…, amountIn)` clamp bounds a counterparty that **pushes** `tokenIn` at the adapter
  mid-route. Without it the same `Panic(0x11)` is reachable from inside the call.

`inBefore` is snapshotted **before** the `safeTransferFrom`, not after, so a fee-on-transfer
`tokenIn` cannot re-open the channel: snapshotting after would refund `amountIn` against a
balance that only grew by `amountIn - fee`.

The mutex stays. It is defence in depth against a different attacker: a nested call's
`safeApprove(router, 0)` would still revoke the outer call's approval mid-route, and
non-reentrancy is what the `IExecutionAdapter` abstraction promises every other integrator.

Evidence: `contracts/test/audit/AuditAdapterScopedSweep.t.sol` (10 tests, each naming the
mutation that kills it). Seven of the ten fail against `protocol/main`'s adapter — three of them
with `panic: arithmetic underflow or overflow (0x11)` inside `executeRebalance`. The refund line
carries THREE guards (`- inBefore`, the `min(…, amountIn)` clamp, and the saturating
`inAfter > inBefore ? … : 0` floor) and each has its own executing test; the floor's was added
after review, when both reviewers showed it could be deleted with the suite green.

**Retired 2026-09-03 by redeploy.** The live Base Sepolia adapter is now
`0x68be942cab962ac8f9064b45489f35fbd6f617d5`, deployed at `sourceCommit 8a0e1155`, and it carries
BOTH #101 and this fix — `git merge-base --is-ancestor 8a2afc3e 8a0e1155` and
`git merge-base --is-ancestor 29996eaf 8a0e1155` both succeed. Neither the cross-order theft nor
the donation DoS is reachable on it. The soak has **not** been re-run against it yet — gate 3 is
still STALE and needs the owner's funded key — but when it runs it will run against this fixed
shape rather than the old one.

*What this replaced, kept because the constraint it turns on is permanent:* the previous adapter
`0xf3e08c8b…a9b1` (`sourceCommit 5934ef22`) had no `_lock`/`nonReentrant` at all and carried the
cross-order theft (a LOSS OF FUNDS) as well as the donation DoS (a revert). Because
`isAllowedAdapter` is constructor-only, the vaults created against it could not be repointed — a
fixed adapter required new vaults, which is exactly what the redeploy did. That constraint still
holds for the current adapter. See `docs/DEPLOYMENT.md` §3.

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
- **A `tokenIn` donation stays stranded here forever.** There is no rescue function and adding
  one would be new external surface on a contract many vaults share, guarding value that is
  never the protocol's. Donating to this address is burning.
- **A `tokenOut` donation landing DURING the route is over-delivered to the caller.** Deliberate:
  `outBefore` is snapshotted inside the call, so the surplus rides out with `amountOut` — and
  `VaultCore.executeRebalance` credits *its own* measured `tokenOut` delta, so the surplus becomes
  vault assets. A donation *before* the call is excluded by `outBefore` outright (pinned by
  `AuditAdapterScopedSweep::test_preExistingTokenOutIsNotSweptIntoTheOrdersOutput`). Do not "fix"
  this into a clamp; a clamp would strand the surplus instead of banking it.

  **Two corrections to how this row used to justify itself**, because a "do not re-report" entry's
  whole function is to stop the next person looking, and it must therefore be complete:

  1. *"`received >= minAmountOut` can only be helped by a larger delta"* is true but is **not the
     bound that matters** — a mid-route pusher could otherwise top a shortfall up to exactly
     `minAmountOut` and force through a swap that should have reverted `SwapSlippage`. The real
     bound is **`MinOutTooLow`** in `VaultCore.executeRebalance`: oracle-priced, checked
     pre-execution against `MAX_REBALANCE_SLIPPAGE_BPS`, and no donation can move it.
  2. The surplus is net-positive in **value**, not neutral in **effect**. It is the only
     unprivileged write into `navWad()`'s inputs, and `_deposit` gates `navWad()` against
     `capacityCapUsdc` — so a sufficiently large over-delivery can **close a capped vault to
     further deposits**. LOW as an attack (it needs a governance-chosen route to reach the pusher,
     and burns value >= the vault's headroom, which becomes the members'), but it is not "strictly
     beneficial", and the earlier wording never considered the cap.
