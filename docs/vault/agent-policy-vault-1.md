# Agent policy, chain 4663

**Policy version 1.0, published 2026-09-13.**

The rule set the operator of the vaults on Robinhood Chain mainnet undertakes to construct
rebalance proposals from. It exists because `Governance.propose` commits only a `bytes32
actionHash` and `event Proposed` emits that hash, so **the orders do not reach the chain until
`execute(pid, payload)`**. A member watching the chain cannot otherwise decode what they are voting
on. This document says what a proposal will contain; [[agent-policy-log]] publishes each specific
pre-image so the member's check is `keccak256(payload) == actionHash` and needs nothing further
from anyone.

> **This is a published commitment, not an enforced constraint, and that distinction is the whole
> of what this document is worth.** Nothing on-chain stops the operator, or any other member, from
> proposing something forbidden below. What the chain provides is evidence rather than enforcement:
> every proposal is permanently attributed to its proposer and its payload is permanently pinned by
> a hash, so a breach is detectable by anyone, forever. Where a rule below **is** additionally
> enforced by the contracts, §2 says so and names the check. Assume the rest is not.

> **What operatorship is.** Operatorship confers no authority to vote, execute, pause, reprice, or
> move member funds. `Governance.propose` gates on stake rather than on operatorship, so the
> operator proposes as a member, over the same `proposalThresholdBps` gate as anyone else, and
> `Governance.execute` has no `msg.sender` check at all. That list is enumerated rather than
> summarised on purpose, because the blanket form would be false: `FeeEngine` credits the vault's
> performance fee to the operator's registered payout address and to nobody else, and `claimFees`
> pays `claimableFees[msg.sender]` out to its caller. That is an economic right nobody else has,
> and it is real (§6).

> **Three rounds ran before this policy existed.** Proposals 1, 2 and 3 on chain 4663 were made
> with no published rule set and no pre-image published in advance. They are reconstructed
> retrospectively in [[agent-policy-log]] from the chain, and they are labelled there as
> reconstruction rather than as compliance. **This policy binds proposals made from its publication
> date onward.** Backdating it would make the log a record of a rule that was not in force, which is
> the opposite of what it is for.

## 1. Scope

**The vault list is read from the chain, not from this page.** A vault created after this was last
edited is in the factory and not here, and the vaults on this chain are being rebuilt from the
creator Safe, which will produce new addresses.

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
FACTORY=0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1
cast call $FACTORY "vaultCount()(uint256)" --rpc-url $RPC
cast call $FACTORY "allVaults(uint256)(address)" 0 --rpc-url $RPC
```

At publication the two vaults are the ones the address book records under `smokeVault` and
`secondVault` in
[`contracts/config/deployments/robinhood-mainnet.json`](../../contracts/config/deployments/robinhood-mainnet.json).
This policy binds proposals the operator makes against **any** vault it operates on chain 4663,
addressed that way rather than by a literal address, so a rebuild does not silently take a vault out
of scope.

| | |
|---|---|
| Settlement asset | USDG, `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals |
| Oracle | `ChainlinkOracle` `0x79279FBa3b6F6736f07cbBFcB7Cf0559466D5bfB`, one genuine Chainlink feed per asset |
| Permitted basket assets | WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, cbBTC `0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4` |
| Execution adapter | `0xc83B9CE8a12B8aca3f5f7d1C20383d60B1ECaA5E`, pinned to Uniswap `SwapRouter02` `0xCaf681a66D020601342297493863E78C959E5cb2` |
| Performance fee | 10% of realised net gains, `FeeEngine.PERF_FEE_BPS` reads 1000 on chain (§6) |

**A vault's basket is a subset of that list, not the whole of it, and it is fixed at construction.**
Read `assetUnit(asset)` on the vault itself: zero means the asset is not in that vault's basket.
At block 62,130,940 the first vault returned `100000000` for cbBTC and the second returned `0`, so
the second vault cannot hold cbBTC and no policy undertaking is needed to keep it out (§2).

**Every duration this policy references is read from `Governance.configOf(vault)`, which is the
authority.** The two vaults differ. Read at block 62,134,720:

| field | first vault | second vault |
|---|---|---|
| `commitDuration` | 3600 | 3600 |
| `revealDuration` | 3600 | 3600 |
| `timelockDuration` | 0 | 0 |
| `executionWindow` | 86400 | 3600 |
| `quorumBps` | 2500 | 2500 |
| `proposalThresholdBps` | 500 | 500 |
| `proposalCooldown` | 21600 | 3600 |

## 2. What the contracts enforce, and what only this policy binds

Four of the rules below are not undertakings at all. They are checks in `VaultCore.executeRebalance`
that a non-compliant proposal cannot get past, whoever proposes it and however the vote goes. They
are listed separately because a reader is entitled to know which promises they can stop trusting and
start checking.

**Enforced.** Each of these reverts:

1. **Only governance may rebalance.** `require(msg.sender == address(governance))`. The operator
   address cannot call `executeRebalance`.
2. **Only a constructor-fixed adapter.** `isAllowedAdapter[adapter]` is written once in the vault's
   constructor and has no setter.
3. **Nothing outside that vault's own basket may be bought.** Every order must have `tokenOut` equal
   to the settlement token or a non-zero `assetUnit`, and every non-settlement `tokenIn` must have
   one too. Anything else reverts `BadSwapToken`.
4. **A 2% oracle-priced slippage floor, per leg.** Each order must satisfy
   `_valueWad(tokenOut, minAmountOut) * 10000 >= _valueWad(tokenIn, amountIn) * 9800`, priced by the
   vault's own oracle, or it reverts `MinOutTooLow`. `MAX_REBALANCE_SLIPPAGE_BPS` is 200.

**A fifth check is frequently mistaken for a slippage bound and is not one.** After the swap the
contract measures its own balance delta and requires `received >= minAmountOut`. That defends
against a router that misreports its fill. The bound on how bad a price may be committed to in the
first place is 4.

**Not enforced, and therefore the actual subject of this document:** which rebalance is proposed at
all, when, and with what `minAmountOut` inside the 2% ceiling. Nothing in the contracts has an
opinion about any of it.

## 3. The rule set

**3.1 Target.** An equal-value split across the assets in that vault's basket. For a two-asset
basket that is 50/50 WETH/cbBTC; for a one-asset basket it is 100% that asset. Idle settlement
balance is a deviation from target, not a position.

**3.2 The evaluation instant.** Once per day at 16:00:00 UTC, evaluated against the first block
whose timestamp is at or after that instant. One instant, one evaluation, logged whether or not it
produces a proposal.

**3.3 The measurement.** For each basket asset, `V = priceWad(asset) * assetBalance(asset) /
assetUnit(asset)`. Idle value is `idleUsdc * 10**12`. `NAV` is their sum, which equals `navWad()`
exactly when the vault has no child vaults, and every vault on this chain does have none:
`allowSubVaults()` on the factory reads false and `parentVault()` on each vault reads the zero
address. Weight is `V / NAV` in basis points. **Drift** is the largest absolute difference between
any asset's weight and its target weight.

**3.4 The trigger, if and only if.** A proposal is opened when, and only when, drift is at least
**500 bps** at the evaluation instant and no suspension in §3.5 applies. The proposal is opened
within 60 minutes of the instant it was computed from, or not at all: a stale measurement is not a
trigger. Below 500 bps the correct action is none, and the log records the evaluation anyway.

**3.5 Suspensions.** No proposal is opened when any of these holds:

1. **The oracle is frozen.** `navWad()` reverts, or `priceWad` reverts for any asset in the basket.
   See §5.3 for why this is a rule and not merely a prediction that it would fail.
2. **A proposal is already in flight.** `Governance.activeProposalOf(vault)` names one whose status
   is not Defeated, Executed or Expired. The contract refuses a second one, `ProposalActive`.
3. **The cooldown has not elapsed.** `block.timestamp < lastProposalAt[vault][operator] +
   proposalCooldown`, which §1 records as 21600 and 3600 seconds respectively.
4. **The operator is below the proposal threshold**, `proposalThresholdBps` of 500, measured on the
   checkpointed stake `propose` itself reads. The contract refuses, and this is listed so the log
   has a reason to record rather than a silence to explain.
5. **The vault is empty.** `totalShares()` is zero, so there is nothing to rebalance.

## 4. Order construction

**4.1 The legs are forced.** For each asset above target, one leg selling the excess to the
settlement asset; for each asset below target, one leg buying the shortfall from it. Legs are
ordered sells first, so the settlement balance funding the buys exists before they run. Rounding
remainders stay as idle settlement balance and are not redistributed.

**4.2 Slippage.** `minAmountOut` is computed as **99%** of the oracle-implied output:

```
minAmountOut = amountIn_value_wad * 9900 / 10000 * assetUnit(tokenOut) / priceWad(tokenOut)
```

This is an operator commitment strictly inside the contract's 2% ceiling (§2 rule 4), and it is
tighter on purpose: the ceiling is a bound on what may be committed, not a target to price at. A
tighter bound trades a higher chance of a leg failing to fill against a lower worst-case fill, and
that trade is stated rather than left implicit. A failed fill costs a round; a bad fill costs money.

**4.3 The remaining fields.** `deadline` is the evaluation instant plus 4 hours. `routeData` is a
single-hop `exactInputSingle` call on the pinned router.

**The adapter admits exactly one selector, and the record's own list is wider than what the chain
accepts.** `execution.routerAllowedSignatures` in the address book names both `exactInputSingle` and
`exactInput`. Read at block 62,130,940, the deployed adapter's `allowedSelector` returns **true** for
`0x04e45aaf` (`exactInputSingle`) and **false** for `0xb858183f` (`exactInput`):

```bash
cast call 0xc83B9CE8a12B8aca3f5f7d1C20383d60B1ECaA5E "allowedSelector(bytes4)(bool)" 0x04e45aaf --rpc-url $RPC
cast call 0xc83B9CE8a12B8aca3f5f7d1C20383d60B1ECaA5E "allowedSelector(bytes4)(bool)" 0xb858183f --rpc-url $RPC
```

So multi-hop routing is not available on this chain regardless of what this policy undertakes, and
a policy promising single-hop routing here is promising something the adapter already enforces.
**What this record does not establish**, and nobody should read into it: which source that adapter
was built from, whether it is this repository's `AggregationRouterAdapter`, or whether it has been
reviewed. The address book says the same, under `execution.adapterNoteOvertaken`.

## 5. What the operator will not do

**5.1 No discretionary trade.** Every proposal is the output of §3 and §4 applied to the chain state
at a logged evaluation instant. There is no view, no signal and no override.

**5.2 No asset outside the vault's basket.** Also enforced (§2 rule 3), which is the ideal case: the
undertaking and the check agree, and the member can rely on the check.

**5.3 No proposal while the oracle is frozen.** This is a real undertaking and not a restatement of
a revert, because the revert comes too late. From the moment reveals open, `hasPendingExecution` is
true, so `VaultCore.requestExit` **queues** exits instead of settling them, and a queued exit cannot
be cancelled. A proposal opened against a frozen oracle would therefore trap every member who tried
to leave during it, and only then fail at execution when the slippage check reads the same frozen
oracle. The cost lands on members before the failure does.

**5.4 No `RuleChange` and no `ChildAllocation` proposals.** Rebalance only. This does not rest on
sub-vaults being unavailable, though on this chain they are: `factory.allowSubVaults()` reads false
and the factory is immutable, so the flag cannot be changed on this deployment.

**5.5 No unannounced rule change.** §7.

**5.6 No claim to exclusivity.** `propose` gates on stake and `execute` has no sender check, so any
member over the threshold may propose and anyone may execute a passed proposal. This policy binds
what the operator proposes and can bind nothing else.

## 6. The performance fee

`FeeEngine.PERF_FEE_BPS` is a `constant` of 1000, which is 10%, applied on realised net gains. It is
read back from the chain at `0x221D09326DBf6CDb708E7aBEdC9B117d64Ac4232` and returns 1000. **There
is no per-vault override, no setter and no waiver function**, so a fee waiver is not something this
policy is able to undertake.

It is credited to the operator's registered payout address and claimable by that address alone.
`claimableFees` is keyed by address rather than by vault, so an operator running two vaults through
one payout address pools their fees into one balance.

**Nothing has been assessed on this chain.** Realisation happens only on exit, no exit has settled
here, and `claimableFees` for the current operator address in USDG reads `0` at block 62,134,720.
The address book records that `FeeEngine` has emitted no logs at all. Note also that the current
operator address is the same address that holds every share of both vaults, so a first fee would be
that address paying itself; there is no protocol treasury in these contracts.

## 7. Amendments

An amendment is a commit to this file that increments the version in the header and adds a row to
§9. **It takes effect no sooner than 7 days after that commit**, and it is never retroactive: a
proposal is judged against the version in force at its evaluation instant, which is why every log
entry names one. A proposal made under an amendment published less than 7 days earlier is a breach
of this section even if it complies with the amendment.

## 8. How a member checks

1. **The payload matches the hash.** Take the entry from [[agent-policy-log]], `cast keccak` its
   payload, compare with `proposals(pid)`'s `actionHash`. A mismatch means the published orders are
   not the orders being voted on, and there is no safe reading of that.
2. **The trigger was real.** Recompute §3.3 at the logged evaluation block and check drift against
   500 bps.
3. **The orders are the forced ones.** Recompute §4.1 and §4.2 from the same numbers.
4. **Nothing was proposed that should not have been.** Every `Proposed` event from the operator's
   address must have a log entry. One without is a breach, and this is the check that a log of only
   the flattering entries fails.
5. **The version.** The entry's stated policy version must be the one in force at its instant (§7).

`docs/MEMBER-VERIFY.md` §7 has the exact commands for 1, including how to recover a pre-image from
an execute transaction after the fact.

## 9. Honest limits

- **This is not a forecast and not a result.** An equal-weight rule with a 500 bps band is a
  discipline, not an edge. It does not prevent loss and is not designed to.
- **It binds one address, not the vault.** Any member over the threshold may propose anything the
  contracts allow, and this document has no purchase on them.
- **A member who does not vote is not neutral.** Under the sub-five-member regime the vault is in,
  `Governance.finalize` passes on `headMajorityWithStake || forStakeMajority`; it is stake-weighted
  at five or more members and not before. Not voting moves the quorum rather than abstaining from
  it, which is what makes the log a precondition for participating rather than a nicety.
- **A proposal that fails at execution still costs members**, because exits queued during it were
  queued for nothing (§5.3).
- **The log is off-chain.** It is only as good as its publication, and §8 check 4 is the only thing
  that makes a selective one detectable.
- **This is not the reference agent.** [`docs/REFERENCE-AGENT.md`](../REFERENCE-AGENT.md) describes
  unaudited beta code outside the audited contract scope. This document describes a rule set, not an
  implementation.

### Version history

| version | date | change |
|---|---|---|
| 1.0 | 2026-09-13 | Initial policy, published against chain 4663. Binds proposals from this date; proposals 1 to 3 predate it and are reconstructed in the log. |

## Links

- [[agent-policy-log]] · [[governance-commit-reveal]] · [[governance]] · [[vaultcore]] · [[feeengine]]
- Member self-service: [`docs/MEMBER-VERIFY.md`](../MEMBER-VERIFY.md)
- Address book: [`contracts/config/deployments/robinhood-mainnet.json`](../../contracts/config/deployments/robinhood-mainnet.json)
