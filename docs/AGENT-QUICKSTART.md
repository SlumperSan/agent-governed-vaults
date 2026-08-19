# Agent Quickstart

Integrate an AI agent with the index-vault protocol in minutes. This page is written for
machines and the humans wiring them: everything an agent needs to **read metered data**, **pay
via x402**, and **act on-chain** (deposit, vote, exit) is here or one link away.

- **API contract:** [api/openapi.yaml](api/openapi.yaml) (OpenAPI 3.1 — generate a client from it)
- **SDK:** [`packages/agent-sdk`](../packages/agent-sdk) (env-agnostic JS; handles the x402 loop)
- **On-chain ABIs:** `contracts/out/*/*.json` after `forge build`
- **Machine index:** [`/llms.txt`](../llms.txt)

## 1. Read metered data (x402)

Reads cost a few cents in USDC, settled by EIP-3009 authorization. The SDK does the whole
402 → authorize → retry loop; you supply a wallet (address + EIP-712 signer) and the USDC domain.

```js
import { createProtocolClient } from '@x402-vaults/agent-sdk';

const client = createProtocolClient({
  baseUrl: 'https://api.example.xyz',
  wallet: {
    address: agentWalletAddress,
    sign: (typedData) => wallet.signTypedData(typedData), // any EIP-712 signer
  },
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE },
});

const { data } = await client.leaderboard();   // pays automatically, returns typed rows
const vault = await client.getVault(vaultAddr); // { data: VaultView, receipt }
await client.health();                          // free
```

**Spend control (recommended):** wrap the signer with a per-task budget and a per-tx cap so a
compromised prompt can't drain the agent wallet. Use a dedicated hot wallet funded per session —
never the treasury. (See the `llm-trading-agent-security` patterns.)

## 2. The x402 flow, unwrapped

If you're not using the SDK, the loop is:

1. `GET /operators/leaderboard` → `402` with header
   `PAYMENT-REQUIRED: {"scheme":"exact","x402Version":2,"asset":USDC,"amount":"10000","payTo":…,"network":"base","nonce":…}`
2. Build an EIP-3009 `TransferWithAuthorization` for `(to=payTo, value≥amount, asset=USDC, nonce)`,
   sign it (EIP-712) with the agent wallet, wrap as the envelope, base64-encode it.
3. Retry with `PAYMENT-SIGNATURE: <base64 envelope>` → `200` + `PAYMENT-RESPONSE` receipt.

The facilitator verifies and settles the authorization on-chain; the API server never holds keys.
`packages/agent-sdk/src/eip3009.mjs` builds the typed data and envelope for you.

## 3. Act on-chain

The metered API is read-only. State changes go directly to the contracts (ABIs in
`contracts/out/`). The agent-relevant entrypoints:

| Goal | Call | Notes |
| --- | --- | --- |
| Join a vault | `VaultCore.deposit(amountUsdc)` | First deposit enters a **4-hour observation window** (no shares/votes yet). Call `activate(self)` after the window, or `skipWindow()` to opt in immediately (irreversible, once per vault). |
| Propose | `Governance.propose(vault, ptype, actionHash)` | Needs ≥ `proposalThresholdBps` of eligible stake. `ptype`: 0 Rebalance, 1 RuleChange, 2 ChildAllocation. |
| Vote | `Governance.commitVote(pid, hash)` then `revealVote(pid, support, salt)` | **Commit-reveal** — two txns. `hash = keccak256(abi.encode(pid, voter, support, salt))`. Missing the reveal window forfeits your vote. |
| Delegate | `Governance.setDelegate(vault, delegate)` | Concentration-capped on the delegate's *received* weight. |
| Exit | `VaultCore.requestExit(shares)` | Instant pro-rata **in-kind** (Mode I). If a rebalance is passed-but-pending, it queues and settles at **post-rebalance NAV** (Mode F) — call `settleQueuedExit(self)` after execution. |

**Read NAV/eligibility before acting:** `VaultCore.navPerShareWad()`,
`pastVotingEligibleShares(member, ts)`, `exitFeeBpsOf(member)`.

## 4. Things an integrating agent must know (protocol semantics)

- **Observation window:** a first deposit is sequestered 4h with no shares and no vote. Budget for
  it; use `skipWindow()` only if you accept immediate entry.
- **Forward pricing:** exiting between a vote passing and its execution settles at the *post*-
  rebalance price — you carry the rebalance outcome. Check `Governance.hasPendingExecution(vault)`.
- **Oracle breaker:** if the multi-source median goes stale, **everything freezes, including
  exits** — by design. Don't strand funds in a vault whose oracle sources you don't trust.
- **Fees:** 10% of realized profit (per-member high-water mark that follows *operator identity*
  across vaults) + an exit fee ≤1% decaying with tenure, paid to remaining members. Sub-vaults
  stack fees — read `SubVaultRegistry.stackedPerfFeeBps(vault)` / `stackedExitFeeCapBps(vault)`.
- **Reputation is portable:** your realized losses under an operator shelter future gains under
  that *same operator* from fees. Operator identity is the registry key, not display metadata —
  verify via `OperatorRegistry.operatorOf(vault)` before trusting a vault's branding.

## 5. Index the chain yourself (optional)

`packages/indexer` folds normalized events into vault/operator state with deterministic replay.
Point `src/chain.mjs` at your RPC + the factory/registry addresses to run your own projection
instead of (or alongside) the metered API.
