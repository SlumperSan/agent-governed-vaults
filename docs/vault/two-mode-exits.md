# Two-Mode Exits

**Definition.** The redemption side of [[vaultcore]] (commitment C-4): shares burn at
*settlement*, never at request, and settle either instantly (Mode I) or forward-priced after a
pending rebalance executes (Mode F). Default payout is pro-rata **in kind**.

**Why it matters.** Mode F closes the free option of exiting at pre-rebalance prices while already
knowing the rebalance outcome (resolves K-1). In-kind payout makes oversized exits harmless with
no dilution on remainers — which is *why* swing pricing is not needed in v1.

## Mode I vs Mode F (commitment C-4)

- **Mode I (instant):** no pending execution exists → the request settles in the
  same transaction at current NAV. The common path; this is what "instant exit at pro-rata NAV"
  means.
- **Mode F (forward):** the vault has a pending execution → the request is queued and settles at
  **post-execution NAV**. Queued requests are irrevocable and do **not** settle automatically:
  `settleQueuedExit(member)` must be called, and anyone can call it, once no execution is pending.
  Queueing starts at the active proposal's **reveal start** (`Governance.hasPendingExecution`, true
  from `commitDeadline`) — before the vote is tallied, and for **any** proposal type, not only a
  rebalance ([[governance-commit-reveal]], VO-8).

Between request and settlement in Mode F, shares stay outstanding (still earn/lose with the vault,
still count in `totalSupply`) but are **locked**: non-transferable and excluded from voting-
eligible stake — closing the exit-then-veto vector (EE-10). If a passed proposal expires
unexecuted, queued exits settle at then-current NAV — no indefinite lock.

## In-kind redemption (default)

For `s` shares of supply `T`, the redeemer receives `s/T × balance_i` of every basket asset plus
`s/T × idleUSDC`, minus the exit fee. In-kind is the manipulation-resistant path: no forced
selling, so no slippage borne by remainers; the exiter carries their own execution cost.

- **Per-asset transfer failure isolates** — a failed/blacklisted/misbehaving token's slice is
  escrowed for later claim rather than reverting the whole redemption (EE-6). `tryTransfer` is
  assembly, gas-capped, bounded to one returndata word (MO-2); malformed results degrade to escrow
  rather than reverting ([[safetransferlib]]).

## Exit fee (stays in the vault, never to operator)

```
fee(t) = feeMax × max(0, 1 − t / decayPeriod)     feeMax ≤ EXIT_FEE_CAP_BPS = 100 (1% cap)
```

`feeMax`/`decayPeriod` are vault-set at creation (immutable after funding, K-2 regime). The
redeemer's shares burn in full but the fee fraction of their pro-rata slice **stays in the vault**,
mechanically accruing to remaining members' NAVps. Never routed to the operator; **waived when the
redeemer is the last member** (no one to accrue to). This is a *different mechanism* from the 10%
performance fee, which goes to the operator via [[fees-and-carry]] — do not conflate them.

**Invariant: NAVps for remaining members is non-decreasing across any redemption.** Proven by the
invariant suites without any swing haircut.

## Swing pricing — SPECIFIED, NOT IN v1 (DEFERRED)

v1 ships **in-kind redemption only**. Swing pricing exists solely to neutralize first-mover
dilution of *cash* redemptions, and there is no cash-redemption path in v1, so there is nothing to
swing — the NAVps-non-decreasing invariant already holds. The `σ(x)` formula is the spec for a
future, optional cash path (delivered *through the execution adapter* so the vault needs no venue
liquidity), and is **out of the audited surface**. EE-11 (split-to-dodge) is therefore N/A in v1.

## Interaction with the oracle breaker

Redemptions read NAV, so a tripped oracle breaker freezes exits too (K-4 / SF-2, **ACCEPTED** — no
escape hatch, since any exit-during-staleness *is* the stale-price exit the breaker prevents). Only
*active* share capital is trapped; pending/observation-window capital is always reclaimable
([[nav-and-shares]]). See [[oracle-layer]].

## Links

- [[architecture-overview]] · [[nav-and-shares]] (NAV, forward pricing on entry) ·
  [[governance-commit-reveal]] (Mode-F queue at passage) · [[fees-and-carry]] (perf fee vs exit
  fee) · [[oracle-layer]] (breaker freezes exits) · [[execution-adapters]]
- Contracts: [[vaultcore]] · [[safetransferlib]]
- Security: [[c4-depressed-price-theft]] · [[threat-model-commitments]]
