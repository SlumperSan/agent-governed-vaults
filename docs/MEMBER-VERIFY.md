# Verify your own vault

**Member self-service reference — not advice.** Nothing here is an
offer, a solicitation, or financial advice. This page exists so that you can check the state of a
vault you are in, and act on it, without trusting this project's website, this project's API, or
this document.

**What it is for.** Every number the website shows you is a chain read it did on your behalf. This
page gives you the same reads, so you can do them yourself. Where the two disagree, the chain is
right. If the site is down, stale, or you simply do not want to trust it, §5 gets your money in and
out without it.

**Where the addresses come from, and why you should not take them from this page.** The address book
is [`contracts/config/deployments/robinhood-mainnet.json`](../contracts/config/deployments/robinhood-mainnet.json).
Its `singletons` block, its `oracle` block and its `smokeVault` / `secondVault` keys are the record
of what was deployed and read back. But the authoritative list of vaults is the factory itself, and
§1 has you read it rather than copy it. A vault created after this page was last edited will be in
the factory and not here.

**The one thing this page cannot do for you.** It cannot tell you whether a vault is a good idea.
Every command below is a read or a transaction you authorise yourself, and none of it is a judgement
about whether to.

---

## 0. What you need

- **Foundry's `cast`.** `curl -L https://foundry.paradigm.xyz | bash`, then `foundryup`. Every read
  in §1 to §4 needs nothing else: no key, no account, no signature, no permission from anyone.
- **For §5 only, a signer you control.** The recipes there send transactions. They use
  `--account <name>`, a keystore `cast` holds locally. **Nobody from this project will ever ask you
  for a private key, a seed phrase, or a keystore password.** A message that does is not from this
  project, whatever it looks like.
- Nothing here needs the website or the API to be up.

## 1. Set these once

Everything below is written against Robinhood Chain mainnet, chain id 4663. Confirm that first,
because an RPC that answers a different chain id will happily answer every other command too:

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
cast chain-id --rpc-url $RPC          # must print 4663
```

The block explorer is `https://robinhoodchain.blockscout.com`.

```bash
FACTORY=0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1
YOU=<your address>
```

**Now read the vault list out of the factory rather than out of this file:**

```bash
cast call $FACTORY "vaultCount()(uint256)" --rpc-url $RPC
cast call $FACTORY "allVaults(uint256)(address)" 0 --rpc-url $RPC
cast call $FACTORY "allVaults(uint256)(address)" 1 --rpc-url $RPC
```

Set `VAULT` to the one you are in. Then **derive the other three addresses from that vault, not from
this page**, because a vault's oracle, governance module and settlement token are fixed in its own
constructor and are the only ones that can affect it:

```bash
VAULT=<from allVaults above>
ORACLE=$(cast call $VAULT "oracle()(address)" --rpc-url $RPC)
GOV=$(cast call $VAULT "governance()(address)" --rpc-url $RPC)
USDG=$(cast call $VAULT "usdc()(address)" --rpc-url $RPC)
```

Two things worth knowing before the numbers stop making sense:

- **The settlement token is USDG, not Circle USDC.** Every getter says `Usdc` because that is what
  the contract calls the settlement asset. On this chain it resolves to
  `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, which returned `"USDG"` and `6` when those two
  getters were read at block 62,156,146. Read them yourself rather than taking it from here:

```bash
cast call $USDG "symbol()(string)" --rpc-url $RPC
cast call $USDG "decimals()(uint8)" --rpc-url $RPC
```
- **A vault's basket is its own.** The two vaults on this chain do not carry the same assets. Read
  §2 step 8 rather than assuming.

## 2. Read your position

**1. Your shares, and the total.**

```bash
cast call $VAULT "sharesOf(address)(uint256)" $YOU --rpc-url $RPC
cast call $VAULT "totalShares()(uint256)" --rpc-url $RPC
```

Shares are WAD, so 18 decimals. `totalShares()` of `20000000000000000000` is 20 shares.

**2. Anything you have queued to exit.** Non-zero means an exit is already locked in and those
shares no longer vote (§4).

```bash
cast call $VAULT "queuedExitShares(address)(uint256)" $YOU --rpc-url $RPC
```

**3. Any deposit still in its observation window.** Returns the escrowed amount and the timestamp it
becomes activatable.

```bash
cast call $VAULT "pendingDeposit(address)(uint256,uint64)" $YOU --rpc-url $RPC
```

**4. What the vault is worth, and what one share is worth.**

```bash
cast call $VAULT "navWad()(uint256)" --rpc-url $RPC
cast call $VAULT "navPerShareWad()(uint256)" --rpc-url $RPC
```

**5. Your exit fee rate.**

```bash
cast call $VAULT "exitFeeBpsOf(address)(uint256)" $YOU --rpc-url $RPC
```

**This is the rate, and settlement does not always charge it.** `exitFeeBpsOf` returns a fee that
decays from `exitFeeMaxBps()` to zero over `exitFeeDecayPeriod()` seconds. **The clock it decays
against is your last deposit, not your first.** `_exitFeeBps` measures
`block.timestamp - lastDepositTime[member]`, and `lastDepositTime` is rewritten on every mint, so a
top-up puts you back at the full `exitFeeMaxBps()` and starts the decay again. Read the number, do
not assume it from how long you have been in.

Settlement charges zero if you hold every share of the vault, whatever this read says. The
comparison that decides it is `sharesOf(YOU)` against `totalShares()`: equal means the rate above
is not the charge. Both vaults on this chain are in exactly that state today, so a first reader is
the case this applies to.

**Why the waiver exists, stated exactly, because the obvious guess is wrong.** The exit fee is not
paid to anyone. It is a fraction of your own payout that **stays in the vault**, which is what makes
NAV per share non-decreasing for the members who remain. A sole holder has no such members, so the
fee would come out of their payout and stay in a vault they entirely own: it would route to
themselves and protect nobody. `VaultCore`'s own comment on the waiver puts it flatly, that the fee
**can never route to the operator**. That is a different flow entirely: the operator's 10%
performance fee is paid out to `feeEngine` and credited to the operator's registered payout address
through `FeeEngine.onFeeCollected`. Do not read your exit fee as anything the operator receives.

**6. The parameters that cannot change.** These are set in the vault's constructor and have no
setter.

```bash
cast call $VAULT "minDepositUsdc()(uint256)"     --rpc-url $RPC
cast call $VAULT "capacityCapUsdc()(uint256)"    --rpc-url $RPC
cast call $VAULT "exitFeeMaxBps()(uint256)"      --rpc-url $RPC
cast call $VAULT "exitFeeDecayPeriod()(uint256)" --rpc-url $RPC
cast call $VAULT "creator()(address)"            --rpc-url $RPC
```

A capacity cap is per vault and is not a protocol-wide limit. `creator()` is permanent: it is the
address the factory attested as this vault's operator, and no transaction can repoint it.

**7. How many members there are.** This decides which quorum rule a vote runs under, so it is worth
reading before you assume anything about how a vote is weighted.

```bash
cast call $VAULT "holderCount()(uint256)" --rpc-url $RPC
cast call $VAULT "nonCreatorMemberCount()(uint256)" --rpc-url $RPC
```

`Governance.finalize` has three regimes. A `RuleChange` needs full consensus. Below five members it
passes on `headMajorityWithStake || forStakeMajority`. It is stake-weighted at five or more members
and not before, so if `holderCount()` reads below five, the short description does not apply to you.

**8. The basket, and reproducing the NAV yourself.**

```bash
cast call $VAULT "basketLength()(uint256)" --rpc-url $RPC
cast call $VAULT "basketAssets(uint256)(address)" 0 --rpc-url $RPC
cast call $VAULT "assetBalance(address)(uint256)" <asset> --rpc-url $RPC
cast call $VAULT "assetUnit(address)(uint256)" <asset> --rpc-url $RPC
cast call $VAULT "idleUsdc()(uint256)" --rpc-url $RPC
cast call $ORACLE "priceWad(address)(uint256)" <asset> --rpc-url $RPC
```

`navWad()` is idle settlement value plus every basket asset priced by the vault's own oracle:

```
navWad = idleUsdc * 10**(18 - 6)
       + sum over basket assets of  priceWad(asset) * assetBalance(asset) / assetUnit(asset)
```

**Worked, so you can see it close.** Vault `0x03E121e18c68B48B84a60D8F93BcD7D5be31ee38` at block
62,130,940 read `idleUsdc()` 0, one basket asset (WETH), `assetBalance` 1980483895862031,
`assetUnit` 1000000000000000000 and `priceWad` 2502713400000000000000. That gives
`2502713400000000000000 * 1980483895862031 / 1e18 = 4956583584658109534`, and `navWad()` at the same
block returned `4956583584658109534`. Exactly.

**Those five numbers move every block.** They are stamped with a block because they are an example
of the arithmetic, not a current statement of what the vault holds. Run the commands.

**9. An `assetUnit` of zero means the asset is not in that vault's basket**, and that is worth
knowing because it is also what the contract checks. `assetUnit(cbBTC)` reads `100000000` on
`0x9b0229FF0613EaD59e41Eec556e03b5ED228e2b4` and `0` on
`0x03E121e18c68B48B84a60D8F93BcD7D5be31ee38`: the second vault cannot hold cbBTC, and §6 shows why
that is enforced rather than intended.

## 3. Read the price, and recognise a freeze

**1. The price the vault uses.** Not a market price from anywhere else: this is the only price that
enters its NAV.

```bash
cast call $ORACLE "priceWad(address)(uint256)" <asset> --rpc-url $RPC
```

**2. A freeze looks like a revert, not a zero.** If the feed is stale past its configured bound, or
outside its sanity band, `priceWad` reverts. So does `navWad()`, and so does anything that has to
price the basket. A reverting `priceWad` is the vault telling you it does not currently know what it
is worth, and the correct reading is to wait, not to retry harder.

**3. The feed configuration behind that.**

```bash
cast call $ORACLE "feedOf(address)(address,uint32,uint64,uint128,uint128)" <asset> --rpc-url $RPC
```

That returns the Chainlink feed address, its heartbeat, the scale, and the minimum and maximum
prices the oracle will accept. Read at block 62,171,205, **both** basket assets return a heartbeat
of `86400`: WETH is feed `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` and cbBTC is
`0x0009cD492adf8167f9eEBf1293556A673530a21a`. 86,400 seconds is exactly `MAX_HEARTBEAT`, the widest
the oracle will accept (`contracts/src/oracle/ChainlinkOracle.sol:98`), so on this chain a price up
to a full day old is a price the vault will use.

**4. The sequencer gate does not run on this chain, and you should confirm that rather than take
it.**

```bash
cast call $ORACLE "sequencerUptimeFeed()(address)" --rpc-url $RPC
```

It returns the zero address. On chains where a sequencer uptime feed is wired, the oracle refuses
every price while the sequencer is down and for `GRACE_PERIOD()` seconds after it restarts. Here
there is no such feed, because Chainlink does not publish one for 4663, so that protection is not
running. That is a deliberate exemption recorded in the deployment record, and it is a real
difference from a Base-style deployment rather than a formality.

## 4. Read the exit mode before you exit

Exits settle one of two ways and **you do not choose which**. The contract chooses, from whether
governance has an execution pending, at the instant your transaction lands.

```bash
cast call $GOV "hasPendingExecution(address)(bool)" $VAULT --rpc-url $RPC
```

- **`false` is Mode I.** `requestExit` settles immediately, at current NAV, less the exit fee, or
  zero if you hold every share (§2 step 5). You get your pro-rata slice and it is done.
- **`true` is Mode F.** `requestExit` does not settle. It **queues** your exit, locks those shares
  out of voting, and leaves them locked until someone calls `settleQueuedExit` after the pending
  execution clears. You cannot cancel a queued exit. This is forward pricing: you will settle at
  whatever NAV is after the rebalance you are exiting ahead of, not at the one you can see now.

**Do not use the proposal id as the mode read:**

```bash
cast call $GOV "activeProposalOf(address)(uint256)" $VAULT --rpc-url $RPC
```

A non-zero proposal id is not Mode F. `activeProposalOf` is set when a proposal opens and is never
zeroed afterwards, so it stays non-zero through the commit phase, when exits still settle
immediately, and it stays non-zero after a proposal has long settled. `hasPendingExecution` is the
read that answers the question.

**Dry-running it will not tell you the mode either.** You can simulate:

```bash
cast call $VAULT "requestExit(uint256)" <shares> --from $YOU --rpc-url $RPC
```

`0x` tells you only that **the call would not revert**. `requestExit`
returns no data, so `0x` is what a successful simulation looks like in **both** modes: it is the
same answer whether the contract is about to hand you your money or about to lock your shares into a
queue you cannot leave. Treat it as a check that your share count and your balance are valid, and as
nothing else.

**Re-read `hasPendingExecution` in the same breath as you send.** A proposal reaching reveal between
your read and your transaction flips the mode under you, and the queue it puts you in is
irrevocable.

## 5. Act without the website: direct-to-contract recipes

These **send transactions**. Every one uses a signer you control. To dry-run any of them first,
change `cast send` to `cast call` and add `--from $YOU`, remembering what §4 says about what a
successful simulation does and does not prove.

### A. Deposit

1. Check the floor. A deposit below it reverts `BelowMinDeposit`.

```bash
cast call $VAULT "minDepositUsdc()(uint256)" --rpc-url $RPC
```

2. Approve, then deposit. Amounts are in USDG units, 6 decimals, so `1000000` is 1 USDG.

```bash
cast send $USDG "approve(address,uint256)" $VAULT 1000000 --account member --rpc-url $RPC
cast send $VAULT "deposit(uint256)" 1000000 --account member --rpc-url $RPC
```

3. **A first deposit does not mint shares.** It is escrowed for `OBSERVATION_WINDOW`, which is 4
   hours, and prices at activation rather than at deposit. Read §2 step 3 to see it sitting there.
   If you already hold shares, or have cleared the window before, the deposit mints immediately, and
   the two-argument form lets you bound that:

```bash
cast send $VAULT "deposit(uint256,uint256)" 1000000 <minSharesOut> --account member --rpc-url $RPC
```

`minSharesOut` applies only on the immediate path. Passing 0 opts out.

4. Activate once the window has elapsed. Anyone may call this for you.

```bash
cast send $VAULT "activate(address)" $YOU --account member --rpc-url $RPC
```

### B. Reclaim a pending deposit

This is the one action that keeps working while the oracle is frozen, because it touches no price.

```bash
cast send $VAULT "cancelPending()" --account member --rpc-url $RPC
```

**The refund has two branches and only one of them is a transfer.** The contract attempts a bounded
transfer back to you; if that attempt fails for any reason, it does not revert and it does not
strand your money. It credits `claimable` instead and emits `SliceEscrowed`. That branch exists so
that a member whose address stopped being able to receive the token still has a path out, and it
means a successful `cancelPending` is not by itself proof you have been paid. Check, and claim:

```bash
cast call $VAULT "claimable(address,address)(uint256)" $YOU $USDG --rpc-url $RPC
cast send $VAULT "claimEscrowed(address)" $USDG --account member --rpc-url $RPC
```

A non-zero `claimable` is your money waiting for you to pull it, and `claimEscrowed(address)` is how.

### C. Exit

1. Read the mode (§4), then request. Shares are WAD.

```bash
cast send $VAULT "requestExit(uint256)" <shares> --account member --rpc-url $RPC
```

2. **A settled exit can escrow too**, per asset, for the same reason as §5-B. After a Mode-I
   settlement, check each asset you expected a slice of, the settlement token included:

```bash
cast call $VAULT "claimable(address,address)(uint256)" $YOU <asset> --rpc-url $RPC
cast send $VAULT "claimEscrowed(address)" <asset> --account member --rpc-url $RPC
```

3. If you queued in Mode F, settle once the pending execution has cleared. Anyone may call it.

```bash
cast send $VAULT "settleQueuedExit(address)" $YOU --account member --rpc-url $RPC
```

## 6. What the contracts enforce, and what they do not

The difference matters more than any single command above, because it tells you which promises you
can check and which you have to trust.

**Enforced by `VaultCore.executeRebalance`, checkable by reading the source:**

- **Only governance can rebalance.** It opens `require(msg.sender == address(governance))`. The
  operator address cannot call it.
- **Only an adapter fixed at construction.** `isAllowedAdapter` is set in the constructor and has no
  setter, so the venue a vault can trade through is fixed for its life.
- **Nothing outside the basket can be bought.** Every order must have `tokenOut` equal to the
  settlement token or a non-zero `assetUnit`, which is what §2 step 9 has you read.
- **A 2% oracle-priced slippage floor on every leg.** Each order must satisfy
  `_valueWad(tokenOut, minAmountOut) * 10000 >= _valueWad(tokenIn, amountIn) * 9800`, valued at the
  vault's own oracle. A separate measured-delta check, that what actually arrived is at least
  `minAmountOut`, defends against a router that misreports its fill; it is not the slippage bound.

**Not enforced anywhere, and worth naming rather than leaving to be assumed:**

- **Which rebalance gets proposed.** `Governance.propose` commits only a hash. What that hash is a
  hash *of* does not reach the chain until execution. That is the gap
  [`docs/vault/agent-policy-vault-1.md`](vault/agent-policy-vault-1.md) and its log exist to close,
  and §7 is how you check them.
- **Operatorship.** `Governance.propose` gates on stake, not on operatorship, and `Governance.sol`
  contains no occurrence of the word. Operatorship confers no authority to vote, execute, pause,
  reprice, or move member funds. It does confer one thing, and a page like this has to say so: the
  vault's 10% performance fee is credited through `FeeEngine` to the operator's registered payout
  address and claimable by that address alone.

## 7. Check a rebalance before you vote on it

A proposal commits a `bytes32 actionHash` and nothing else, so the orders are not readable from the
chain until they execute. To decide before that, you need the pre-image, and the check that it is
the right one is yours to run.

**1. Read the proposal.**

```bash
cast call $GOV "proposals(uint256)(address,uint8,address,uint64,uint64,uint64,uint64,uint64,uint8,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)" <pid> --rpc-url $RPC
```

The tenth value is the `actionHash`. The ninth is the status: 0 None, 1 Active, 2 Passed, 3
Defeated, 4 Executed, 5 Expired.

**2. Take the published pre-image** from [`docs/vault/agent-policy-log.md`](vault/agent-policy-log.md)
and hash it:

```bash
cast keccak <payload hex>
```

**If that does not equal the `actionHash` you just read, the published orders are not the orders
being voted on.** There is no interpretation of a mismatch that is safe to vote for.

**3. After execution, the pre-image is on the chain and you can skip the log entirely:**

```bash
cast tx <execute tx hash> input --rpc-url $RPC
cast decode-calldata "execute(uint256,bytes)" <that input>
```

The second value is the payload, and its keccak is the `actionHash`. This is what makes the log
checkable after the fact rather than merely believable: an entry that never matched is exposed the
moment the proposal executes.

## 8. Where this page comes from

Every function name used above exists in `contracts/src` at the commit this page was written
against: `VaultCore.sol`, `Governance.sol` and `ChainlinkOracle.sol`. Every address is either read
from the chain by a command on this page or recorded in
[`contracts/config/deployments/robinhood-mainnet.json`](../contracts/config/deployments/robinhood-mainnet.json).
The two worked examples in §2 were run against `https://rpc.mainnet.chain.robinhood.com` at the
blocks they name.

The three claims on this page that a test pins in both directions, because each one was an
overstatement that would have cost a reader money, are in
`scripts/test/claims-member-verify.test.mjs`: the dry-run in §4, the refund branch in §5-B, and the
fee rate in §2. Adding a correction below a wrong sentence does not satisfy that test; the wrong
sentence has to go.
