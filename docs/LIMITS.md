# Limits and honest risks

Read this before you build anything on this protocol that touches money you would mind losing.

Nothing here is a legal hedge or a disclaimer written to be skipped. Each item is a specific,
consequential thing that is true today, with a pointer to the code or the evidence. Where the
project has not proven something, this page says *not proven* rather than *safe*.

---

## 1. The headline: what is and is not audited

| Component | Status |
| --- | --- |
| `contracts/` | **Audit candidate. NOT externally audited.** Four internal adversarial review rounds, invariant and fuzz suites, and an AI pre-audit are complete; an external audit is not. |
| `packages/agent-sdk/` | **Outside the contract audit scope.** Off-chain code. Tested, not audited. |
| `packages/reference-agent/` | **Beta demonstration. Outside the audit scope. Not a product.** |
| `apps/api/`, `packages/indexer/` | Outside the audit scope. Off-chain, non-custodial, holds no keys. |

Internal review is not external audit. It was performed by the people and agents who wrote the code,
which is exactly the arrangement external audit exists to correct. Treat every claim of correctness
on this site as *tested*, not as *verified by an independent party*.

See [docs/AUDIT-HANDOFF.md](AUDIT-HANDOFF.md) for scope, proven invariants and known residuals, and
[docs/CHANGES-SINCE-REVIEWS.md](CHANGES-SINCE-REVIEWS.md) for exactly what internal review did and
did not cover.

## 2. The reference agent is a demonstration, not a product

[`packages/reference-agent`](../packages/reference-agent) exists to show a complete integration. It
is **beta**, it ships **outside the contract audit scope**, and it should not be treated as
something to point at a funded wallet and leave running.

Its own limitations, stated by its authors in
[REFERENCE-AGENT.md §7](REFERENCE-AGENT.md#7-risks-and-honest-limitations):

- **It has never touched a real chain.** No transaction it constructs has ever been mined. Execute
  mode is tested against mocks only. Chain reads in the demo come from a stub and every value is
  marked `[stub-chain]` in the narrative.
- **The shipped vote evaluator is not a strategy.** A drift band over idle USDC balance is a
  demonstration of the plug point. It also *cannot see what it is voting on*: a proposal commits to
  `actionHash`, the keccak of a payload that is not on-chain until execution, so no evaluator
  reading only chain state can know what a rebalance actually does.
- **Entry marks do not survive a restart**, so a pre-restart drawdown is invisible to the exit
  policy after a restart.
- **No gas management, no MEV protection, no leader election.** Transactions are plain and public.
  Two instances on the same account race and produce duplicates.

There is a further, sharper argument for caution here, and it is worth stating because it is
evidence rather than opinion: **the reference agent shipped with two launch-class bugs that were
found only by running it live during the soak** — a policy flag that was inert, and a deposit path
that could never have succeeded. Both passed code review and a green test suite. That is what the
developer path being under-exercised looks like from the inside.

## 3. The contracts are immutable

There are **no proxies and no upgrade path**. What deploys is what runs, permanently.

The consequences are structural, not theoretical:

- A bug found after deployment cannot be patched. The response is a migration — members exit one
  vault and enter another — not a fix.
- **Per-vault rules are immutable after funding**, except by full consensus plus a timelock of up to
  30 days. A parameter chosen badly at creation is chosen badly for the life of the vault.
- `OperatorRegistry` attestation **has no rebind**, so an operator's payout address is permanent. It
  should be a multisig, never an EOA.
- `proposalThresholdBps` is fixed per vault at creation. An operator who falls below the threshold
  through passive dilution — other members deposit, `totalShares` grows, nothing re-checks — loses
  the right to propose **anything, including the change that would lower the threshold.** A floor
  was implemented, measured and deliberately reverted, because a constructor cannot observe live
  stake distribution.

## 4. The oracle is single-provider, and a stale oracle freezes exits

Prices come from **Chainlink, and only Chainlink**. The defences against a bad answer are a
heartbeat check, a sane-price band, and an L2 sequencer-uptime gate. There is no second provider to
fall back to.

**When the oracle goes stale, everything freezes — including exits.** This is by design, not a bug:
`navPerShareWad()` reverts with `StaleOracle`, and every function that needs a NAV reverts with it,
`requestExit` included. A vault whose oracle has stalled is a vault you cannot leave until it
clears.

What that means for an agent:

- **A failed NAV read is not an early warning. It is the freeze.** `OracleAggregator` exposes no
  per-source timestamp, so a genuine advance warning is not readable on-chain. Anything labelled
  "oracle-freeze warning" is detection after the fact.
- **Pending capital is always reclaimable.** A deposit still in the observation window is not
  trapped by the breaker. Active shares are.
- **A feed deprecation fails that asset closed** — safe, but with no fallback. Supported assets are
  limited to WETH and cbBTC because Base has no cbETH/USD feed.
- **The sequencer guard has never run against a real uptime feed.** Testnet leaves it `address(0)`
  by design, so its first real execution would be on mainnet.

Do not put an agent into a vault whose oracle sources you have not looked at yourself.

## 5. x402 reads are served on broadcast, not on finality

The facilitator returns a transaction hash when it **broadcasts** the settlement, not when the
settlement is mined. The API serves your data while the USDC transfer is still in the mempool.

Measured on Base Sepolia: the full paid-read loop is **289 ms**; waiting for the settlement to
actually be mined adds **4,598 ms**. So there is a window — seconds on a 2-second-block chain,
longer with confirmations — in which data has been delivered for a payment that is not yet final,
and **a reorg can un-settle a paid read.**

If you need finality, configure the facilitator to wait for the receipt (and for N confirmations)
before returning, and pay for it in latency. Do not treat a `receiptId` as proof of settlement
merely because it is a transaction hash; verify it yourself with `eth_getTransactionReceipt` and
check for the `AuthorizationUsed` event. Full mechanism and numbers:
[The x402 flow §7](X402-FLOW.md#7-the-finality-caveat--read-this-before-you-trust-a-paid-read).

Two related sharp edges:

- **`FACILITATOR=stub` — the local-development default and what the quickstart runs — accepts
  payments without settling anything.** No USDC moves, no nonce burns, no signature is verified. It
  will happily accept a signature made under the wrong EIP-712 domain, which is the bug most likely
  to be waiting for you when you switch to a real facilitator. A green local run does not prove your
  domain config.
- **Signing is spending.** Under EIP-3009 a signature is a bearer instrument for that exact amount.
  There is no step after signing at which you can decline, so a budget check must live *inside* the
  signer, not around the call.

## 6. Economic mechanics that are not bugs but will cost you

- **Forward pricing (Mode F).** Exiting between a rebalance vote passing and its execution settles
  at the **post-rebalance** NAV, and the shares lock until `settleQueuedExit`. You carry the outcome
  of a trade you did not choose to make, at a price you could not see. Check
  `Governance.hasPendingExecution(vault)` before requesting an exit.
- **The observation window.** A first deposit is sequestered for 4 hours with no shares and no vote.
  `skipWindow()` opts out — **irreversibly, once per vault.** The reference agent will not call it
  autonomously under any configuration.
- **Fees stack multiplicatively.** Sub-vault performance fees compound up the parent chain:
  `keep = keep × 0.9` per level, so a two-level vault costs **19%** effective, not 10%. Read
  `SubVaultRegistry.stackedPerfFeeBps(vault)` and `stackedExitFeeCapBps(vault)`; never assume the
  base rate.
- **Shares are non-transferable.** Exiting is the only way out. There is no secondary market to sell
  into if your policy turns out to be wrong.
- **An exit fee of up to 1% is paid to the remaining members**, decaying with tenure. Leaving early
  is a transfer to the people who stay.
- **Permissionless creation means scam vaults exist.** `operatorId: 0` is unattested. Branding is
  metadata and can say anything; `OperatorRegistry.operatorOf(vault)` is the identity.

## 7. What has not been proven yet

Stated as *not proven*, not as *fine*:

- **The protocol has no mainnet deployment.** Launch is a documented NO-GO. The Base Sepolia
  lifecycle smoke test is parked mid-run and awaiting a re-run.
- **The soak and canary runs need re-running** against the current tree; the previous results
  predate a pivot.
- **The operational restore drill has not been recorded.**
- **The sequencer guard has never executed against a live uptime feed** (see §4).

Current state, with the launch-gate board, is in
[docs/LAUNCH-READINESS.md](LAUNCH-READINESS.md) and `npm run cc`.

## 8. Not financial advice

This documentation describes how software works. It is not investment advice, it does not recommend
any vault, operator or strategy, and the leaderboard is a record of past realizations rather than a
prediction. An operator's net realized figure includes their losses precisely so that it cannot be
read as a recommendation.

---

**Licence:** BUSL-1.1 (contracts). See [README](../README.md).
