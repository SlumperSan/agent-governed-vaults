# Agent policy log, chain 4663

The append-only evaluation and proposal log required by [[agent-policy-vault-1]] §7 and §8.

## Why it exists

`Governance.propose` commits only a `bytes32 actionHash`, and `event Proposed` emits that hash. The
orders themselves do not reach the chain until `execute(pid, payload)` is called, and
`VaultCore`'s `RebalanceExecuted` carries only an adapter and a count. **A member watching the chain
therefore cannot decode a rebalance before voting on it.** This file is where the pre-image is
published, so the member's check is `keccak256(payload) == actionHash` and needs nothing further
from the operator.

`Governance.execute` requires that equality itself, so the check is not a courtesy: the contract
will refuse any other bytes with `BadPayload`. What the contract cannot do is show them to you
first.

## Rules

- One entry per evaluation instant, **including evaluations that produced no proposal**. A log of
  only the entries that flatter the operator is the failure mode this rule exists against.
- An entry for a proposal is published in the same hour the proposal is opened, and before the
  commit phase closes. An entry published after the reveal deadline has not done its job.
- Entries are appended, never edited. A correction is a new entry naming the one it corrects.
- Each entry names the policy version it was constructed under ([[agent-policy-vault-1]] §9).
- **A `Proposed` event from the operator's address with no matching entry is a breach of the
  policy**, and is detectable by anyone, permanently, without the operator's cooperation.

## Entry template

```
### <n> — <evaluation instant, UTC> — <PROPOSED pid=<n> | NO PROPOSAL>

policy version : 1.x
eval block     : <number>  (timestamp <unix>, <UTC>)

priceWad(<asset>)     : <wad>
assetBalance(<asset>) : <units>
idleUsdc              : <units>
NAV (wad)             : <wad>
weights (bps)         : <asset>=<..> ... idle=<..>
drift (bps)           : <..>

outcome        : <drift < 500 | suspension §3.5(<n>) | proposal opened>

-- when a proposal was opened --
proposal tx    : <hash>   proposed block : <number> (timestamp <unix>)
adapter        : <address>
orders         : [ { tokenIn, tokenOut, amountIn, minAmountOut, deadline, routeData }, ... ]
payload (hex)  : 0x...
keccak256      : 0x...   (must equal actionHash in the Proposed event)
```

## Entries

### Retrospective reconstruction, R1 to R3

**These three rounds predate this policy and are not claimed to comply with it.** They ran with no
published rule set and no pre-image published in advance, which is the gap the policy exists to
close, and backdating them into compliance would make this log a record of a rule that was not in
force. They are here because the pre-images are recoverable and a member is better served by having
them than by a note saying they once existed.

**How they were recovered, so the method is reusable rather than taken on trust.** The proposal set
was enumerated from the chain and not from any runner log: `eth_getLogs` on Governance
`0x790A308f1ac06FeD4C79884BAD25d0C721C5B125` over the full range from the deploy block to head
returns three `Proposed` events and two `Executed` events, so the set below is complete by
construction. For each executed proposal the payload was read out of its own execute transaction's
calldata and hashed. All reads performed 2026-09-13.

The evaluation-instant fields the template calls for are **absent**, not omitted for brevity: no
evaluation was logged at the time, and reconstructing what the operator measured before proposing is
not something the chain records. That is precisely what an entry written in advance supplies and a
reconstruction cannot.

---

### R1 — no logged evaluation instant — PROPOSED pid=1

```
policy version : none in force
vault          : the first vault (address book `smokeVault.address`)
proposal tx    : 0xaa65d5b90ac1a1de2d6e77008309eb067559dcf078400e51802a0859e070bbda
proposed block : 59164717   gas 274,587
execute tx     : 0xdc72948795aca79e0e12b46532afc4036aed23cae14f17065129fc9db2adcf1e
executed block : 59239524   gas 46,356
status         : proposals(1) reads 4 = Executed
snapshotTotal  : 20000000000000000000    revealedWeight 20000000000000000000
forWeight      : 20000000000000000000    revealedVoterCount 1    memberCount 1

adapter        : 0xc83B9CE8a12B8aca3f5f7d1C20383d60B1ECaA5E
orders         : []                       <- EMPTY. A no-op rebalance.

payload (hex)  : 0x000000000000000000000000c83b9ce8a12b8aca3f5f7d1c20383d60b1ecaa5e
                   0000000000000000000000000000000000000000000000000000000000000040
                   0000000000000000000000000000000000000000000000000000000000000000
keccak256      : 0x5c33178ab655f450324f624e38fc7874bf4e808afdfbe5e8d474d83ccde2e8c6
actionHash     : 0x5c33178ab655f450324f624e38fc7874bf4e808afdfbe5e8d474d83ccde2e8c6   MATCH
```

An empty order list moves no funds, so NAV and idle did not change across the execute, which is the
invariant a no-op has to hold. It exercised the governance machinery and not the strategy. The
execute cost 46,356 gas, and comparing that with R3's 307,069 is the cheapest way to tell a no-op
from a fill without decoding anything.

### R2 — no logged evaluation instant — PROPOSED pid=2, NEVER EXECUTED

```
policy version : none in force
vault          : the first vault
proposal tx    : 0xe5942edfaa628e087b5d5b09fb6a7d96a39f68cb7993109cafcbddeffd626372
proposed block : 59567501
finalize tx    : 0x1ea86aa41327fc8f2f80848d6c7dcd49c4e4906e4233208cda3f361a781bb255  block 61480072
execute tx     : none. There is no Executed log for pid 2.
status         : proposals(2) reads 2 = Passed, expiresAt 1789340584, which is in the past

actionHash     : 0x42713d32f69bff7c2406d89b389ea5e14fbe750c522518de27fdffc865eec181
payload        : NOT RECOVERABLE
```

**This entry is the argument for the whole file.** The pre-image of proposal 2 is not on the chain
and cannot be put there. `propose` committed the hash, the proposal passed, and it was never
executed, so the only artefact of what members approved is 32 bytes that nobody can invert. Had an
entry been published before the vote, it would still be readable; because none was, it is gone.

The stored status is also a trap worth naming: it reads `2` (Passed) and its `expiresAt` has
elapsed. `markExpired` was never called and `_refreshStatus` runs lazily, so the status is stale
rather than wrong. **A reader must not take `status == 2` here as still-executable.**

### R3 — no logged evaluation instant — PROPOSED pid=3

```
policy version : none in force
vault          : the second vault (address book `secondVault.address`)
proposal tx    : 0xd515d38ff24602134a1b3a2cc942c4e34346547753b332f678b4feacb1f8bb2c
proposed block : 61483266   gas 257,484
execute tx     : 0x0c8799d2e3aa742e2d8674f6c0b86b81ea71704ae1a084f0ca2c9ee1dcc29198
executed block : 61554418   gas 307,069
status         : proposals(3) reads 4 = Executed
snapshotTotal  : 5000000000000000000     revealedWeight 5000000000000000000
forWeight      : 5000000000000000000     revealedVoterCount 1    memberCount 1

adapter        : 0xc83B9CE8a12B8aca3f5f7d1C20383d60B1ECaA5E
orders         : [ { tokenIn      : 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168  (USDG)
                     tokenOut     : 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73  (WETH)
                     amountIn     : 5000000                  (5 USDG)
                     minAmountOut : 1966530337330907         (wei WETH)
                     deadline     : 1789268903
                     routeData    : 0x04e45aaf... exactInputSingle, fee tier 100 } ]

keccak256      : 0xb20ea0c30140233fa4786409c98758713a3850447aeb7b10fd472802902c8aee
actionHash     : 0xb20ea0c30140233fa4786409c98758713a3850447aeb7b10fd472802902c8aee   MATCH
```

**The fill.** The vault received `1980483895862031` wei of WETH, which is above the committed
`minAmountOut`, so the measured-delta check ([[agent-policy-vault-1]] §2) passed with room. This is
the first rebalance on chain 4663 that moved funds.

**Checking the slippage floor on this order, as a worked example of §2 rule 4.**
`_valueWad(USDG, 5000000)` is `5000000 * 10**12 = 5000000000000000000`.
`_valueWad(WETH, 1966530337330907)` is `priceWad(WETH) * 1966530337330907 / 1e18`. The floor is
`_valueWad(tokenOut, minAmountOut) * 10000 >= _valueWad(tokenIn, amountIn) * 9800`, so it holds for
any `priceWad(WETH)` at or above `2491698148247524157496`, which is about 2491.70. At block
62,130,940 `priceWad(WETH)` read `2502713400000000000000`, so the floor holds at that price with
about 0.4% to spare. The check that mattered was the one at execution, and the execute transaction
succeeding is the proof it passed then.

**What this round does not establish.** `minAmountOut` here is about 98.4% of the oracle-implied
output at the price above, which is inside the contract's 2% ceiling but **outside** the 1%
commitment this policy makes in §4.2. That is not a breach, because the policy did not exist; it is
recorded so the first entry made under v1.0 can be compared against it rather than against nothing.

---

### Entries under policy v1.0

*None yet. The first will be the first evaluation instant after 2026-09-13, whether or not it
produces a proposal.*

## Links

- [[agent-policy-vault-1]] · [[governance-commit-reveal]] · [[governance]] · [[vaultcore]]
- Member self-service: [`docs/MEMBER-VERIFY.md`](../MEMBER-VERIFY.md) §7 has the commands
- Transaction-level record: `governanceActivityNote` and `proposalPreImageNote` in
  [`contracts/config/deployments/robinhood-mainnet.json`](../../contracts/config/deployments/robinhood-mainnet.json)
