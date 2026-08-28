# Execution Adapters

The `IExecutionAdapter` implementations a passed rebalance routes swap legs through. Two ship: an
aggregation-router adapter (0x/1inch-style) and a direct Uniswap-V2-pair adapter.
`contracts/src/AggregationRouterAdapter.sol`, `contracts/src/DirectPoolAdapter.sol`.

## Why it matters

Rebalancing is the one path where vault funds leave for an external venue and come back. It is the
classic drain surface — the arbitrary-calldata exploit class (SwapNet/Aperture 2026, Dexible 2023,
Unizen 2024, LI.FI). VaultCore's `executeRebalance` allow-lists adapters fixed at creation (EX-1)
and never trusts an adapter's return value: it debits internal accounting before each swap and
credits the **measured balance delta** after (EX-3). The adapters enforce the same contract on their
own side. That two adapters with entirely different venue shapes satisfy one interface is the
concrete proof of the venue abstraction (C-2).

## The shared safety contract (EX-1..EX-3)

- **Target is pinned immutable** — `routeData` cannot choose its own target (EX-2). The aggregation
  adapter pins `router`; the direct adapter pins `pair`.
- **`minAmountOut` and `deadline` enforced HERE on measured balance deltas** — never trusted from
  router return values or calldata-embedded slippage params (EX-3). `minAmountOut > 0` is mandatory,
  never optional.
- **Approvals are per-swap and revoked after; leftovers swept back to the caller.**

## AggregationRouterAdapter

- `router` immutable; `allowedSelector[bytes4]` allowlist fixed at construction (EX-1) —
  `routeData`'s selector must be on it.
- `executeSwap`: pull `tokenIn`, approve `router`, `router.call(routeData)`, measure
  `tokenOut` delta, require `>= minAmountOut`, revoke approval, sweep unspent `tokenIn` back. Partial
  fills never strand funds.

## DirectPoolAdapter

- Pinned to one immutable V2-style `pair`; `token0` / `token1` cached.
- `executeSwap`: computes `amountOut` **on-chain** from reserves (constant-product, 0.30% fee), does
  the pair swap, then still enforces `minAmountOut` on the measured delta — the quote is never
  trusted as the accounting source.

## Defence-in-depth from VaultCore

The adapter's measured-delta check is **not** a slippage bound — it is a defence against a lying
router. The actual slippage bound is VaultCore's **H-4** `MAX_REBALANCE_SLIPPAGE_BPS = 200` (2%),
which values each leg against the vault's *own* oracle before executing. See [[vaultcore]]. This
layering is deliberate: the adapter defends against the venue, the vault defends against a bad trade
that governance approved.

## Security findings that touch here

- **EX-1 / EX-2 / EX-3** — the pinned-target, selector-allowlist, and measured-delta discipline
  above.
- **M-11** — both adapters call ERC-20 transfers through [[safetransferlib]], whose returndata-bomb
  hardening covers the adapter call sites. See that note.

## Links

- [[contracts-index]] · [[vaultcore]] · [[safetransferlib]]
- Architecture: [[nav-and-shares]]
- Findings: [[highs]] · [[mediums-and-lows]] · [[threat-model-commitments]]
- Decision: [[build-vs-buy]]
