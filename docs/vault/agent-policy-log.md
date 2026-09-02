# Agent policy log — vault #1

The append-only evaluation and proposal log required by
[[agent-policy-vault-1]] §7.2. **Empty is correct: no contract is deployed to Base mainnet, so
there is nothing to evaluate yet.**

## Why it exists

`Governance.propose` commits only a `bytes32 actionHash`; `event Proposed` emits that hash and the
orders themselves do not reach the chain until `execute(pid, payload)` is called. A member watching
the chain therefore **cannot decode a rebalance before voting on it.** This file is where the
operator publishes the pre-image, so the member's check is
`keccak256(payload) == Proposed.actionHash` and needs nothing further from the operator.

## Rules

- One entry per evaluation instant, including evaluations that produced **no** proposal.
- An entry for a proposal is published in the same hour the proposal is opened.
- Entries are appended, never edited. A correction is a new entry that names the one it corrects.
- Each entry names the policy version it was constructed under
  ([[agent-policy-vault-1]] §7.3).
- A `Proposed` event from the operator's address with no matching entry is a breach of the policy.

## Entry template

```
### <n> — <evaluation instant, UTC> — <PROPOSED pid=<n> | NO PROPOSAL>

policy version : 1.x
eval block     : <number>  (timestamp <unix>, <UTC>)

priceWad(WETH)   : <wad>
priceWad(cbBTC)  : <wad>
assetBalance(WETH)  : <units>
assetBalance(cbBTC) : <units>
idleUsdc            : <units>
NAV (wad)           : <wad>
w_WETH / w_cbBTC / w_USDC (bps) : <..> / <..> / <..>
drift (bps)                     : <..>

outcome        : <drift < 500 | suspension §2.5(<n>) | proposal opened>

-- when a proposal was opened --
proposal tx    : <hash>   proposed block : <number> (timestamp <unix>)
adapter        : <address>
orders         : [ { tokenIn, tokenOut, amountIn, minAmountOut, deadline, routeData }, ... ]
payload (hex)  : 0x...
keccak256      : 0x...   (must equal actionHash in the Proposed event)
```

## Entries

*None. See the pre-launch note above.*

## Links

- [[agent-policy-vault-1]] · [[governance-commit-reveal]] · [[governance]] · [[vaultcore]]
