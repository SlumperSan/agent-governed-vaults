# Agent policy — vault #1

**Policy version 1.0 · effective from `[PER-LAUNCH VARIABLE — set at first publication, §7]`**

This is the complete, binding rule set that vault #1's operator follows when it opens a rebalance
proposal. It is published **before** the proposals it authorises, and it contains no discretion:
given the chain state at a stated instant, the rules below determine whether a proposal is opened
and exactly what its payload contains.

> **Pre-launch status.** No contract in this protocol is deployed to Base mainnet. Everything below
> describes a procedure and the source-readable constraints it operates inside. Fields marked
> `[PER-LAUNCH VARIABLE]` are filled in at v1.1, published before the first proposal, and are the
> only values in this document that are not already fixed by source or reference configuration.

## Why it matters

Vault #1 is founder-operated. If the founder simply traded it, the "operated by an agent policy"
description would be false and the operator's conduct would be unfalsifiable. Publishing the policy
in advance replaces trust with arithmetic: a member holding only this file and a block explorer can
take any proposal the operator has made and determine, without asking anyone, whether it complies.

That test is the design constraint for every rule here. Where a rule could be read two ways, it is
rewritten until it cannot be.

---

## 1. Scope

| | |
| --- | --- |
| **Vault** | `[PER-LAUNCH VARIABLE — vault #1's Base mainnet address, from the published address book]` |
| **Operator proposing address** | `[PER-LAUNCH VARIABLE]` — the address whose `Proposed` events this policy binds |
| **Operator payout address** | `[PER-LAUNCH VARIABLE]` — the `OperatorRegistry` payout address; a Safe, not an EOA |
| **Basket** | WETH `0x4200000000000000000000000000000000000006` (18 dp) and cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8 dp) |
| **Settlement asset** | Circle-native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 dp) |
| **Oracle** | `ChainlinkOracle` — WETH from Chainlink ETH/USD `0x50015f8b17fb2C290Dde41fDc246ed0dcEE93a8b`, cbBTC from BTC/USD `0x32F587986D3fb47601157c19615d568BeD0BCabc`, both 8 dp, 3,600 s heartbeat, gated on the Base L2 sequencer uptime feed |
| **Execution adapter** | `AggregationRouterAdapter` pinned to Uniswap `SwapRouter02` `0x2626664c2603336E57B271c5C0b26F421741e481`, selectors `exactInputSingle` and `exactInput` — address `[PER-LAUNCH VARIABLE]` |
| **Swap route** | single-hop `exactInputSingle`, fee tier `[PER-LAUNCH VARIABLE — fixed at v1.1, per pair]` |
| **Performance fee** | assessed on-chain, **never claimed** — see §5.6 |

The basket, the oracle and the adapter allowlist are **not** policy choices that could later drift.
Each is written once in `VaultCore`'s constructor (`basketAssets`, `assetUnit`, `oracle`,
`isAllowedAdapter`) and there is no setter for any of them, so this row of the table is a property
of the deployment rather than a promise by the operator.

Governance phase durations — `commitDuration`, `revealDuration`, `timelockDuration`,
`executionWindow` — plus `quorumBps`, `proposalThresholdBps`, `concentrationCapBps` and
`proposalCooldown` are read from `Governance.configOf(vault)`. **That on-chain struct is the
authority for every duration this policy references.** Where a formula below needs one, it names the
field, never a number.

---

## 2. Target allocation and the rebalance trigger

### 2.1 Targets

Over the vault's total NAV:

| Holding | Target weight |
| --- | --- |
| WETH | 50.00 % |
| cbBTC | 50.00 % |
| idle USDC | 0.00 % |

Idle USDC is a deviation, not a position. The vault holds USDC only between a deposit and the next
rebalance that deploys it.

### 2.2 The evaluation instant

The operator evaluates the vault **once per day, at 16:00:00 UTC.** That instant is the *evaluation
instant*; the *evaluation block* is the last Base block whose timestamp is at or before that instant.

Every quantity in §2.3 and §4 is read at the evaluation block and nowhere else. The operator does
not choose when to look.

### 2.3 The measurement

All values are WAD (18 dp). Read from the evaluation block, by `eth_call` at that block:

```
P_W   = ChainlinkOracle.priceWad(WETH)
P_B   = ChainlinkOracle.priceWad(cbBTC)
V_W   = VaultCore.assetBalance(WETH)  * P_W / 1e18
V_B   = VaultCore.assetBalance(cbBTC) * P_B / 1e8
V_U   = VaultCore.idleUsdc() * 1e12
NAV   = V_W + V_B + V_U                       // equals VaultCore.navWad()
```

`NAV` equals `navWad()` exactly. `navWad()` also sums child-vault positions, but vault #1 has no
children — the factory ships `allowSubVaults = false` — so that term is empty. Pending deposits are
excluded from both (`totalPendingUsdc` enters `idleUsdc` only after `OBSERVATION_WINDOW`, 4 hours),
so a deposit made in the last four hours before an evaluation is correctly invisible to it.

`1e18`, `1e8` and `1e12` are `assetUnit[WETH]`, `assetUnit[cbBTC]` and `usdcScalar`, each fixed at
construction from the token's own `decimals()`.

Weights and drift, in basis points, integer arithmetic throughout:

```
w_W = V_W * 10000 / NAV        w_B = V_B * 10000 / NAV        w_U = V_U * 10000 / NAV
drift = max( |w_W - 5000| , |w_B - 5000| , w_U )
```

### 2.4 The trigger — if and only if

> **At each evaluation instant, the operator opens exactly one `Rebalance` proposal if and only if
> `drift >= 500` and none of the suspensions in §2.5 applies. If `drift < 500`, the operator opens
> no proposal.**

The proposal is opened within **60 minutes** of the evaluation instant. A `Proposed` event from the
operator's address whose block timestamp lies outside that hour is a breach, as is the absence of
one when `drift >= 500`.

500 bps is chosen so that a 50/50 basket is not rebalanced into fees by ordinary co-movement of two
correlated majors, and so that a deposit is deployed rather than left idle: on a full 50,000 USDC
vault, 500 bps is 2,500 USDC.

Three ordinary things move `drift`, and the trigger treats them identically because it measures the
vault's state rather than the cause: **prices move**; **a deposit lands** (`idleUsdc` rises once the
4-hour observation window elapses); and **a member exits** — `_settleExit` decrements `assetBalance`
and `idleUsdc` in the member's own proportions, which can leave the remaining vault off-target. An
exit can therefore trigger a rebalance with no price movement at all. That is intended: the rule is
a statement about where the vault stands, never about why.

### 2.5 Suspensions — the five states in which no proposal is opened

Each is a state of the chain at the evaluation block, checkable by the same `eth_call`:

1. **Oracle frozen.** `navWad()` reverts, **or** either `priceWad(WETH)` or `priceWad(cbBTC)`
   reverts, with `StaleOracle`. Both prices are named because `navWad()` skips an asset whose
   balance is zero and so can succeed while one feed is dead — and `executeRebalance` prices *both*
   sides of every leg, so a rebalance needs both feeds regardless. Drift is undefined, no obligation
   arises, and no proposal is opened. See §5.3 for why this is a hard rule and not a preference.
2. **A proposal is already in flight.** `Governance.activeProposalOf(vault)` names a proposal whose
   status is not `Defeated`, `Executed` or `Expired`. The contract refuses a second one
   (`ProposalActive`); the policy states it so a reader is not left to infer it.
3. **Cooldown unexpired.** `block.timestamp < lastProposalAt[vault][operator] + proposalCooldown`.
   At the reference configuration `proposalCooldown` is 21,600 s (6 h) and the evaluation cadence is
   24 h, so this never binds — it is stated because the cadence is policy and the cooldown is the
   chain's, and the reader should not have to trust that they agree.
4. **Operator below the proposal threshold.** `pastVotingEligibleShares(operator, t-1) * 10000 <
   proposalThresholdBps * pastTotalVotingEligibleShares(t-1)`. The operator then *cannot* propose
   (`BelowProposalThreshold`). The operator undertakes to hold at least `proposalThresholdBps` of
   voting-eligible stake — 5 % at the reference configuration, which is also
   `CREATOR_MIN_STAKE_BPS` — and to publish a notice in the §7.2 log within 24 h if it does not (the log, not the §7.1 amendment procedure — this is an operational notice, not a rule change).

5. **Empty vault.** `NAV == 0`. Weights are undefined; there is nothing to rebalance.

In states 1–5 the compliant behaviour is to do nothing and to record the evaluation in the log
(§7.2). Nothing else is a compliant response to any of them.

---

## 3. Cadence and cooldown

- **Evaluation:** daily, 16:00:00 UTC. Every evaluation is logged, including the ones that produce
  no proposal.
- **Maximum proposal rate:** one per evaluation, so at most one per 24 h. `Governance` independently
  caps the operator at one per `proposalCooldown` (21,600 s at the reference configuration) and at
  one live proposal per vault.
- **Minimum proposal rate:** none. If drift never reaches 500 bps, the operator never proposes, and
  that is compliance, not inactivity.

A proposal's own timetable is set by the chain, not by this policy: commit closes at
`createdAt + commitDuration`, reveal at `+ revealDuration`, and on a passing `finalize` the
timelock and execution window run from the finalize block. The operator does not choose any of them.

---

## 4. Order construction

The payload is `abi.encode(address adapter, IExecutionAdapter.SwapOrder[] orders)`, exactly the
tuple `Governance.execute` decodes for a `Rebalance` and passes to `VaultCore.executeRebalance`.

### 4.1 The legs are forced

Because the two targets are equal and weights sum to 10000, **at most one basket asset can be above
its target.** If `V_W > NAV/2` then `V_B + V_U < NAV/2`, so cbBTC is below target — and symmetrically.
So a compliant payload has at most two legs, in exactly one of two shapes:

**Shape A — no asset above target** (`V_W <= NAV/2` and `V_B <= NAV/2`). Deploy idle USDC into both
deficits:

```
D_W_usdc = (NAV/2 - V_W) / 1e12          // floor division
a_W      = min(D_W_usdc, idleUsdc)
a_B      = idleUsdc - a_W
leg 1: USDC -> WETH , amountIn = a_W      (omitted if a_W == 0)
leg 2: USDC -> cbBTC, amountIn = a_B      (omitted if a_B == 0)
```

**Shape B — one asset above target.** Call it `X` (the one with `V_X > NAV/2`) and the other `Y`;
`Y` is necessarily below target. Sell `X`'s excess into USDC, then deploy all USDC into `Y`:

```
E_X  = V_X - NAV/2
x_X  = E_X * unit_X / P_X                 // floor division, X's own token units
leg 1: X    -> USDC, amountIn = x_X
leg 2: USDC -> Y   , amountIn = idleUsdc + minAmountOut(leg 1)
```

Leg 2's `amountIn` is the USDC balance the vault is *guaranteed* to hold when the leg runs: the idle
balance it already has, plus leg 1's enforced floor. Any surplus leg 1 delivers above that floor
stays idle and is measured at the next evaluation. Legs execute in array order and
`executeRebalance` credits each measured output before the next leg is debited, so leg 2 cannot
under-fund.

Legs are emitted in the order shown. A leg with `amountIn == 0` is omitted — the adapter rejects
`amountIn == 0` and `minAmountOut == 0` outright (`BadOrder`).

**Shape A's `a_B` is the remainder, not a second deficit.** Both deficits sum to `V_U` exactly, so
computing `a_B` independently as `(NAV/2 - V_B) / 1e12` would usually agree — but each floor division
loses up to one USDC unit, and the two would then not sum to `idleUsdc`. `a_B = idleUsdc - a_W`
spends the idle balance exactly and is single-valued. A member recomputing `a_B` the other way and
finding a one-unit difference has found rounding, not a breach. `a_W`'s `min()` is a guard that
never binds (`D_W <= V_U` whenever both assets are below target); it is written down so the
expression has one reading rather than two.

### 4.2 Slippage bound

For every leg, with **`K = 100` basis points (1.00 %)**:

```
V_in     = amountIn * P_in / unit_in                         // = VaultCore._valueWad, eval-block price
minAmountOut = V_in * (10000 - K) / 10000 * unit_out / P_out // floor division
```

where `unit_in` / `unit_out` is `1e6` for USDC, `1e18` for WETH, `1e8` for cbBTC; `P_in` / `P_out`
are the `priceWad` values read at the evaluation block, with USDC pinned at `1e18`.

The **contract's** ceiling is `MAX_REBALANCE_SLIPPAGE_BPS = 200` (2 %):
`VaultCore.executeRebalance` reverts `MinOutTooLow` unless
`_valueWad(tokenOut, minAmountOut) * 10000 >= _valueWad(tokenIn, amountIn) * 9800`, computed from
**live** prices at execution. `K` is the operator's commitment inside that ceiling, and it is not a
free parameter: the 2 % is a single budget split between two opposite failures, so the choice of `K`
is an argument, not a preference.

- **Lower `K` means a higher `minAmountOut`.** That leaves more room for the pair's relative price to
  move against the order between the evaluation block and execution before `MinOutTooLow` bites —
  tolerance `1 - 9800/(10000 - K)` — but demands more of the venue.
- **Higher `K` means a lower `minAmountOut`.** That leaves more room for the venue's fee and price
  impact before `SwapSlippage` bites, and less for price movement.

At `K = 100` the two tolerances are roughly equal — about **1.0 %** of adverse relative price
movement, and about **0.9 %** of venue cost above the evaluation-block oracle price — which is the
balanced split of a budget that has to cover both. `K = 100` is half the contract's ceiling, so the
policy binds the operator to twice the discipline the contract enforces. Floor division can cost at
most one output unit, which cannot bridge a 100 bps margin.

The separate `received >= minAmountOut` check inside both `executeRebalance` and the adapter is a
defence against a router that misreports its own fill (EX-3); it is not a slippage bound and this
policy does not treat it as one.

Neither failure is a loss. A leg that can no longer clear its bound reverts, the proposal is never
executed, it expires at `expiresAt`, and the next evaluation measures the vault as it actually
stands. That is the intended failure — see §9 for what it costs while it is pending.

### 4.3 The remaining two fields

- **`deadline`** = `createdAt + commitDuration + revealDuration + timelockDuration +
  executionWindow + 86400`, where `createdAt` is the `Proposed` event's block timestamp and the four
  durations are read from `Governance.configOf(vault)` at that block. The 86,400 s allowance covers
  latency in the permissionless `finalize` call, which fixes the execution window's real start. A
  proposal that cannot execute inside its window cannot execute late.
- **`routeData`** = calldata for exactly this signature, one of the two the adapter allows
  (`contracts/config/base-mainnet.json` · `routerAllowedSignatures`):

  ```
  exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  ```

  The struct's seven fields, in that order, are
  `(tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96)`. SwapRouter02's
  version carries **no** `deadline` field — the order's own `deadline` is enforced by the adapter,
  not by the router. The policy fixes every one of them:

  | Field | Value |
  | --- | --- |
  | `tokenIn`, `tokenOut`, `amountIn` | the order's own fields |
  | `fee` | the tier named in §1 for that pair |
  | `recipient` | the adapter's address — it measures its own balance delta and forwards the proceeds |
  | `amountOutMinimum` | the order's `minAmountOut` |
  | `sqrtPriceLimitX96` | `0` |

  So `routeData` is reproducible byte-for-byte from the order and §1. The adapter pins the router
  immutably and checks `allowedSelector[bytes4(routeData[0:4])]`, so `routeData` cannot choose its
  own target whatever it encodes.

---

## 5. What the operator will not do

These are undertakings, and each is stated so that a violation is visible on-chain.

**5.1 No discretionary trade.** The operator opens no `Rebalance` proposal other than the one §2.4
requires, with the payload §4 determines. There is no "market call" branch in this policy and no
override.

**5.2 No asset outside the basket.** Every leg's `tokenIn` and `tokenOut` is USDC, WETH or cbBTC.
This one is also enforced: `executeRebalance` reverts `BadSwapToken` on anything else, and
`basketAssets` has no setter.

**5.3 No proposal while the oracle is frozen.** This rule is not "the transaction would fail" — it
would not. `Governance.propose` reads only share checkpoints and never touches the oracle, so a
proposal opened during a freeze **succeeds.** The harm is to members: from the moment reveals open,
`hasPendingExecution` is true, so `VaultCore.requestExit` queues a Mode-F exit instead of settling
it, and `settleQueuedExit` reverts while the proposal is pending. Meanwhile `executeRebalance`
cannot run, because its slippage check reads the frozen oracle. A proposal opened into a freeze can
therefore hold every member's exit queued until the execution window lapses, and deliver nothing.
The operator does not do this.

**5.4 No rule changes and no sub-vault proposals.** The operator opens no `RuleChange` and no
`ChildAllocation` proposal. Vault #1 launches with `allowSubVaults = false` at the factory, so no
child can exist; and a `RuleChange` would alter the very configuration this policy binds itself to.
If the governance configuration should change, that is a member-initiated proposal, and this policy
is amended under §7 to match before the operator proposes again.

**5.5 No unannounced rule change.** Every amendment is published under §7, dated, with at least
seven days' notice, and always before the first proposal it authorises.

**5.6 No performance fee is taken on vault #1** — and the precise form matters, because **the
contracts implement no waiver.** `FeeEngine.PERF_FEE_BPS = 1_000` is a `constant` with no per-vault
override, so a 10 % fee on net gains above the high-water mark **is** assessed at each exit
(`onRealize`, `FeeAssessed`) and **is** credited to the operator's payout address
(`onFeeCollected` → `claimableFees[payout][token]`). The waiver is that the operator never withdraws
it. `claimFees(token)` is the only path out of that balance and it emits
`FeesClaimed(operator, token, amount)`.

**The undertaking is: zero `FeesClaimed` events from vault #1's operator payout address, ever.** A
member checks it by looking for that event; the credited-and-unclaimed balance stays visible in
`FeeEngine.claimableFees(payoutAddress, token)`, which is what a waived fee looks like on-chain.

Because `claimableFees` is keyed by **address**, not by vault, this undertaking is only checkable if
that address is never also the payout address of a vault whose fee is taken. Vault #1's operator
payout address is therefore reserved to vault #1. Anything a member reads there belongs to this
vault, and any withdrawal from it is a breach of this policy.

**5.7 No claim to exclusivity, and no promise to execute.** Two facts about `Governance` bound what
this policy can honestly say:

- `propose` gates on **stake**, not identity — `own > 0` and `own * 10000 >= proposalThresholdBps *
  total`. There is no operator-only check. **Any member over the threshold may open a proposal.** A
  proposal this policy does not authorise is not necessarily a breach of it; check
  `Proposed.proposer` first.
- `execute` has **no `msg.sender` check at all.** Anyone may execute a passed proposal after its
  timelock, inside its window, with the exact committed payload. So may anyone call `finalize` or
  `markExpired`. This policy governs **what the operator proposes**. It cannot govern who executes,
  and does not pretend to.

---

## 6. When the policy and the market disagree

The operator follows the policy. That is the whole answer.

If the rules produce a proposal the operator believes is wrong, the operator opens it anyway or
amends the policy first — and an amendment cannot take effect for seven days (§7), so it can never
be used to justify a proposal already made or about to be made under a hunch. If the rules produce
no proposal in a market the operator finds alarming, the operator proposes nothing.

The operator's own remedy is the same one every member has and no better: exit under Mode F. The
creator's exit is additionally gated at `CREATOR_MIN_STAKE_BPS` (5 %) while non-creator members
remain, so the operator cannot quietly leave ahead of them.

A policy that bends when the operator dislikes the outcome is a discretionary fund with extra steps.
The value of this document is precisely that it does not bend.

---

## 7. Amendments and version history

### 7.1 How an amendment is made

1. The amendment is published as a commit to this file in the public repository, adding a row to
   §7.3 and bumping the version.
2. It states an **effective-from** UTC timestamp at least **seven days** after the publishing
   commit's timestamp.
3. Proposals opened before that instant are judged against the previous version; proposals opened at
   or after it, against the new one. No amendment is ever retroactive.
4. `[PER-LAUNCH VARIABLE]` fields are filled in at v1.1 under the same procedure, before the first
   proposal.

A reader establishes which version governed a past proposal by taking that proposal's `Proposed`
event block timestamp and finding the row in §7.3 whose effective-from window contains it. The
commit history of this file is the tamper-evidence: a row cannot be back-dated without rewriting
public git history, and the log in §7.2 pins each proposal to a version at the time it was made.

### 7.2 The proposal log — and why the policy is unusable without it

`Governance.propose` takes an `actionHash`, and `event Proposed` emits that hash. **The orders
themselves are not on-chain until execution**, when they appear as `execute(pid, payload)` calldata;
`VaultCore`'s `RebalanceExecuted(adapter, orderCount)` carries only a count. A member watching the
chain therefore cannot decode a rebalance *before* voting on it.

So the operator publishes, in the same hour it proposes, an entry in
[`agent-policy-log.md`](agent-policy-log.md) containing:

- the evaluation instant and evaluation block number;
- `P_W`, `P_B`, `assetBalance` for both assets, `idleUsdc`, `NAV`, `w_W`, `w_B`, `w_U`, `drift`;
- the full `SwapOrder[]` with every field, and the adapter address;
- the **hex-encoded ABI payload** and its `keccak256`;
- the policy version under which it was constructed.

**Failing to publish that entry is itself a breach of this policy**, and is as checkable as any
other rule: there is a `Proposed` event and no matching log entry.

Evaluations that produce no proposal are logged too, with the drift figure and, where §2.5 applies,
which suspension.

### 7.3 Version history

| Version | Published | Effective from | Change |
| --- | --- | --- | --- |
| 1.0 | `[PER-LAUNCH VARIABLE — publishing commit date]` | `[PER-LAUNCH VARIABLE]` | Initial policy. No proposals may be made under it until v1.1 fills the §1 addresses and the fee tier. |

---

## 8. How a member checks compliance

Everything below uses public view functions, auto-generated getters and event logs. None of it
requires anything from the operator except the §7.2 log entry, whose absence is itself the finding.

**Check 1 — the payload is the one that was published.** Take the `Proposed` event from
`Governance` (topic `Proposed(uint256,address,uint8,address,bytes32)`; `pid`, `vault` and
`proposer` are indexed). Confirm `proposer` is the §1 operator address. Take the hex payload from
the §7.2 log entry, compute `keccak256` of it, and compare to `actionHash` in the event. **If they
match, the published orders are the orders members are voting on** — the contract will refuse to
execute any other bytes (`BadPayload`). If they do not match, stop: nothing else needs checking.

**Check 2 — the trigger was met.** Take the evaluation block from the log entry. Confirm its
timestamp is the last one at or before 16:00:00 UTC, and that the `Proposed` event's block timestamp
is within 60 minutes of it. Then `eth_call` at that block tag:

- `ChainlinkOracle.priceWad(WETH)` and `priceWad(cbBTC)`
- `VaultCore.assetBalance(WETH)`, `assetBalance(cbBTC)`, `idleUsdc()`, `navWad()`

Recompute `V_W`, `V_B`, `V_U`, `NAV`, the three weights and `drift` by §2.3. **`drift >= 500` or the
proposal should not exist.** The figures must equal the log entry's.

**Check 3 — the orders are the ones the rules force.** From the same numbers, recompute the shape
and both legs by §4.1, and each `minAmountOut` by §4.2 with `K = 100`. Every field of every
`SwapOrder` is determined. Compare field by field. Check `deadline` against §4.3 using
`Governance.configOf(vault)` read at the proposal block.

**Check 4 — nothing was proposed that should not have been.** Filter `Proposed` for the vault over
any period. For every event with `proposer ==` the operator address, there is a log entry and it
passes checks 1–3. For every 16:00 UTC instant with no such event, the log entry shows `drift < 500`
or names a §2.5 suspension (1–5) — and you can re-derive that from the chain at that block too.

**Check 5 — the fee was never taken.** Filter `FeeEngine` for `FeesClaimed(address,address,uint256)`
with the operator payout address as the indexed `operator`. **There should be none.** Read
`FeeEngine.claimableFees(payoutAddress, USDC)` to see the credited-and-unclaimed balance.

**Check 6 — the version.** Take the `Proposed` block timestamp, find the governing row in §7.3, and
confirm the log entry names that version. Confirm from the repository history that the row was
published at least seven days before its effective-from instant.

Any check that fails is a finding a member can state publicly with the block number and the
transaction hash attached, and neither the operator nor anyone else can dispute the arithmetic.

---

## 9. Honest limits — what this policy does not promise

**It is a procedure, not a result.** It says what the operator will propose and when. It says
nothing whatever about what the basket will be worth. It is not a forecast, a target, a strategy
claim, or a statement that rebalancing a 50/50 WETH/cbBTC basket is a good idea. A member who wants
that judgement must make it themselves — that is what ratifying each proposal is for.

**It does not promise a gain, protect against a loss, or make anything safe.** The vault holds two
volatile assets. A rebalance can and will sometimes sell the asset that then rises. Nothing here
limits how much the basket can lose.

**It binds one address, not the vault.** `propose` gates on stake, not identity (§5.7), so any
member over `proposalThresholdBps` can put a proposal to the vault that this policy did not
authorise and never contemplated. Members ratify every proposal; this policy only makes the
operator's own proposals predictable.

**The operator cannot execute anything alone.** Every rebalance requires a passing commit-reveal
vote under `Governance.finalize`, and vault #1 launches small — below five members the signer regime
in `finalize` applies rather than pure stake weighting.

**It cannot make the vault work when the oracle stops.** A frozen feed suspends NAV, deposits, exits
and rebalancing alike. The policy's response to a freeze is to do nothing, which is the correct
response and is not a mitigation.

**A proposal that cannot execute still costs members something.** A payload is fixed at proposal
time, but `executeRebalance` re-prices both sides of every leg live, so a proposal can pass and then
fail to execute if the pair's relative price has moved roughly 1 % against it (§4.2). While a passed
proposal is pending, `Governance.hasPendingExecution` is true — from reveal-start until it executes
or `expiresAt` passes — and during that time `VaultCore.requestExit` queues a Mode-F exit rather
than settling it. So an un-executable proposal holds exits queued until its window lapses. This is
the direct cost of the trigger, and it is the reason §2.5's suspensions are absolute rather than
advisory. The policy does not eliminate it; a wider `K` would trade it for a worse fill.

**It is only as good as its publication.** The log entry in §7.2 is an off-chain artifact. The chain
proves that a payload matching the published hash was what members ratified; it does not prove the
operator published on time. That gap is closed by the seven-day amendment notice and by the fact
that a missing or late entry is itself visible and permanent.

**It is not the reference agent.** `docs/REFERENCE-AGENT.md` describes unaudited beta code outside
the audited contract scope. This document is a policy, not that software's configuration.

---

## Links

- [[governance-commit-reveal]] · [[governance]] · [[vaultcore]] · [[two-mode-exits]] ·
  [[nav-and-shares]] · [[fees-and-carry]] · [[feeengine]]
- [[oracle-layer]] · [[chainlinkoracle]] · [[chainlink-direct-pivot]] · [[execution-adapters]]
- [[go-to-market-plan]] · [[launch-readiness-gates]] · [[root-vaults-only]] ·
  [[threat-model-commitments]] · [[operatorregistry]]
- [`LAUNCH-READINESS.md`](../LAUNCH-READINESS.md) §2 (launch parameters) ·
  [`DEPLOYMENT.md`](../DEPLOYMENT.md) §4 (vault creation) ·
  [`agent-policy-log.md`](agent-policy-log.md) (the proposal log this policy requires)
