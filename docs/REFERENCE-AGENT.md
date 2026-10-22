# Reference Agent

A policy-driven autonomous vault member: it reads the metered API and the chain, decides whether to
join, vote, or exit, and describes (or, if explicitly unlocked, sends) the resulting transactions.

**It is dry-run by default and it is a demonstration, not a product.** Read [Risks and honest
limitations](#7-risks-and-honest-limitations) before pointing it at anything that matters.

- Code: [`packages/reference-agent`](../packages/reference-agent)
- Protocol integration surface: [AGENT-QUICKSTART.md](AGENT-QUICKSTART.md)
- Mechanics it depends on: [ARCHITECTURE.md](ARCHITECTURE.md) §5 (observation window), §8
  (commit–reveal), §4.4 (Mode F forward pricing), §11 (oracle breaker)
- The human-facing failure it is built around: [CONSUMER-UX-SPEC.md](design/CONSUMER-UX-SPEC.md)
  risk **S-4**

---

## 1. Run it

```bash
node packages/reference-agent/src/run.mjs --api=http://127.0.0.1:8402 --demo-wallet --chain-id=84532
```

That prints a full `perceive → decide → act` narrative and sends nothing. To reproduce it from a
clean checkout, seed a snapshot and start the real API in front of it:

```bash
node packages/reference-agent/fixtures/seed-snapshot.mjs ./data/demo-snapshot.json
```

```bash
PRICE_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e PRICE_PAYTO=0x000000000000000000000000000000000000beef FACILITATOR=stub STATE_PATH=./data/demo-snapshot.json node apps/api/src/serve.mjs
```

| Flag | Meaning |
| --- | --- |
| `--api=<url>` | metered API base URL. With `--preset` and no `--api` there is no API: see [chain-only discovery](#chain-only-discovery) |
| `--preset=<name>` | fill the chain block (chain id, addresses, RPC list, USDC domain, default deposit) from `presets/<name>.json`; `arc-mainnet` ships. Explicit flags beside it win, except a `--chain-id` that disagrees with the preset, which is refused |
| `--rpc=<url>` | JSON-RPC for chain reads. **Omitted ⇒ a stub reader**, and every value it produces is marked `[stub-chain]` |
| `--governance=<addr>` `--subvault-registry=<addr>` `--usdc=<addr>` `--chain-id=<n>` | on-chain wiring |
| `--demo-wallet` | generate a throwaway in-memory key used as the x402 payer *and* the agent's identity. Testnet chain ids only. Does **not** enable execute mode |
| `--cap=<usdc>` | per-session x402 spend cap (default `0.25`) |
| `--ticks=<n>` | how many loop passes (default 1) |
| `--profile=<name>` | a named join profile; the only one is `unproven-operator`, which lets the agent join a vault whose operator has no track record. Off by default; read [Joining a vault with no track record](#joining-a-vault-with-no-track-record) first |
| `--disclosed=<path>` | a JSON file whose `addresses[].address` entries are left out of the outside-member track record; `docs/seeded-addresses.json` has this shape |
| `--config=<path>` | JSON file merged over the defaults |
| `--json` | one JSON record per line instead of prose |

`run.mjs` cannot enter execute mode at all; see [§4](#4-the-dry-runexecute-gate).

---

## 2. What it does each tick

```
PERCEIVE   metered API (via the agent SDK, under a spend cap)
             /.well-known/x402 · /health          free
             /vaults · /operators/leaderboard · /vaults/{addr}    paid
           direct chain reads
             VaultCore   navPerShareWad · exitFeeBpsOf · pendingDeposit · sharesOf
                         queuedExitShares · idleUsdc · totalAssets · capacityCapUsdc
                         pastVotingEligibleShares (the snapshot measure, NOT sharesOf)
             Governance  hasPendingExecution · activeProposalOf · proposals
                         commitOf · revealedOf
             the chain   latest block timestamp (the crank decides on chain time)
             registries  operatorOf · stackedPerfFeeBps · stackedExitFeeCapBps

DECIDE     pure functions over that world (policy.mjs) — no clock, no I/O
             join   attested · positive net · capacity · fees · depth · concurrency · NAV readable
             vote   commit / reveal / abstain, via a pluggable evaluator
             exit   drawdown · oracle-freeze · operator net negative
             entry  activate after the window (never skip it)
             settle release Mode-F shares once the rebalance has executed
             crank  finalize · execute · markExpired, calls anyone may make to finish a round

ACT        intents, risk-ordered:
             reveal → finalize → settle → execute → exit → activate → mark-expired → commit → deposit
           dry-run prints each as the exact call it would make; execute sends it
```

The two data sources are not interchangeable. The API is an event projection; it knows share
books, member counts and the leaderboard. Events carry no post-swap balances and no oracle prices,
so NAV, fee schedules, pending-deposit timers, and governance deadlines are **only** knowable by
calling the contracts.

### Chain-only discovery

With `--preset` and no `--api` the agent reads no API. The vault list is `VaultFactory.vaultCount`
and `allVaults(i)`, each vault's operator is `OperatorRegistry.operatorOf`, and the operator's record
is `OperatorRegistry.leaderboardEntry`. They are turned into the same rows the policy already reads,
and no x402 payment is signed. Two things differ from the API source:

- `memberCount` is `VaultCore.holderCount`, the addresses holding shares, creator included. The
  API counts members from events.
- The list is a window. The factory's array only grows, so the agent reads the newest
  `discovery.maxVaults` entries (default 25), `discovery.pageSize` at a time (default 10), and
  reports a window smaller than the factory as a perception gap. A vault you hold that falls out of
  the window must be named in `discovery.include`, which is always read, or the agent stops seeing
  it.

The join gates are unchanged. A vault whose operator has no realized gain or loss is listed and then
refused by `requireProvenOperator`, which is what a new vault looks like (the opt-in profile for that
case is [below](#joining-a-vault-with-no-track-record)). A vault whose own
`operatorRegistry` is not the configured one is treated as unattested.

Every policy verdict is returned with its full check list, and the log prints it:

```
0x11111111… join gates:
    ✓ operator-attested: attested, operatorId=1
    ✓ operator-net-positive: net realized $36000 (gain $42000 / loss $6000), floor $0
    ✓ capacity-available: $595000 free of $1000000 cap; need $25 (floor $25)
    ✓ fees-in-bounds: stacked perf 1000bps (max 1000) / exit 100bps (max 100)
```

A verdict an operator cannot audit is a verdict they cannot correct.

---

## 3. Policy knobs

All defaults live in [`src/config.mjs`](../packages/reference-agent/src/config.mjs) and are
deliberately conservative. Pass a JSON file with `--config` to override; merging is deep, so you
only state what you change.

### `policy.join`: every gate must pass

| Knob | Default | What it means |
| --- | --- | --- |
| `requireAttestedOperator` | `true` | `operatorId == 0` means unattested. Treated as scam-quarantine. When a registry read is available it **overrides** the API, and a disagreement between the two is itself disqualifying |
| `minOperatorNetRealizedUsdc` | `"0"` | Floor on the operator's leaderboard net (gain − loss). Compared as a BigInt |
| `requireProvenOperator` | `true` | Refuse an operator with no realizations at all: "not yet negative" is not a track record |
| `maxPerfFeeBps` | `1000` | Ceiling on the **stacked** performance fee. Sub-vault fees compound up the parent chain, so 10% is a floor, not the number you pay |
| `maxExitFeeBps` | `100` | Ceiling on the **stacked** exit-fee cap |
| `depositUsdc` | `"25"` | Size of a join |
| `minFreeCapacityUsdc` | `"25"` | Refuse unless this much room remains under the cap. `capacityCapUsdc == 0` means **uncapped**, which is unlimited room, not zero |
| `maxDepth` | `0` | Sub-vault depth ceiling; `0` = top-level vaults only |
| `maxConcurrentVaults` | `3` | Never hold more positions than this |
| `profile` | `null` | A named override. `"unproven-operator"` is the only one; see [Joining a vault with no track record](#joining-a-vault-with-no-track-record) |
| `disclosedAddresses` | `[]` | Addresses left out of the outside-member track record (the `--disclosed` file fills it). Empty and no profile: the logs are not read |

Two further gates are not configurable because failing them open is never correct: **NAV must be
readable** (an unreadable NAV may mean a stale oracle, and a stale oracle freezes *exits* too), and
the **deposit must clear the vault minimum**. Every unreadable input fails **closed**.

### Joining a vault with no track record

The first vault of an operator with no earlier vault has an operator with no realized gain or loss,
and it stays that way until a member has deposited and exited: `OperatorRegistry.recordRealization` moves the operator's
accumulators only for a gain or a loss above zero, so a flat round trip does not change them. With
the defaults the agent therefore **refuses such a vault** (`requireProvenOperator` is `true`). That
default is unchanged, and it is the right one for an agent nobody has told otherwise.

There is one named, opt-in override. Set `policy.join.profile` to `"unproven-operator"` (or pass
`--profile=unproven-operator`) and the agent:

- sets `requireProvenOperator` to `false`, so an operator with no realizations can be joined;
- deposits exactly the vault's own `minDepositUsdc`, and refuses a
  vault whose minimum is above `depositUsdc`, which stays the most the agent puts into one vault
  because a vault's creator sets its minimum (the `deposit-within-ceiling` check);
- keeps `policy.exit.onOperatorNetNegative` on, and refuses to start with it off, because that exit
  is the way out of an operator who turns out to lose money;
- keeps every other gate: the operator must be attested at the registry, its net must clear the
  floor, and the fee, capacity, depth, NAV and minimum-deposit gates all apply;
- prints the risk below in the dry-run banner, and again beside every join decision with the vault's
  current holder count.

**The risk you accept.** Read from `Governance.finalize`. Below five holders
(`SIGNER_REGIME_BELOW`), whether a Rebalance passes depends on stake and on how many addresses
vote. Quorum is met on a strict majority of the members at creation revealing with the FOR stake
clearing the quorum share, or on FOR stake above half of the snapshot, and a proposal that meets
quorum passes only when its FOR weight is above its AGAINST weight. A depositor who is alone holds
all of that stake, so it holds more than half of eligible stake, and whoever joins first holds the
deciding vote on Rebalance proposals. A RuleChange needs every unit of eligible stake to reveal in favour, so
one holder who does not reveal blocks it. A vault with no holders makes its first depositor that
position.

**What the track record can and cannot say.** The registry's figure adds up every member's
realizations, and nothing on chain marks which of them belong to the team that operates the vault.
A deposit and exit from a team-operated address therefore enters the operator's record like anyone
else's. To keep that visible the agent reads the registry's `RealizationRecorded` logs for the
operator and reports a second figure that leaves out the addresses it was given (`--disclosed`,
for example `docs/seeded-addresses.json`). Two properties of that list matter. It can only remove
realizations from the figure and never adds trust, so using it takes no trust in whoever maintains
it. And an address that is not on it is counted as an outside member, so
the figure is a ceiling on outside activity, not proof of it. While the list is empty (the shipped
`docs/seeded-addresses.json` has no addresses), every member counts as outside and the figure is
the sum over every realization the scan read, from this vault's creation block to the head. That equals
the registry's own figure unless the operator realized before that block, in an older vault, and
then the two differ (the paragraph below says how the check reports it).

The figure is read when the profile is on or the list is not empty, and only for a vault the agent
could still join. It adds one check, `outside-track-record`:

- it **refuses** when the figure could not be read in full, and names why. An unread range is a gap,
  never "zero realizations";
- it refuses when the outside members' net is below `minOperatorNetRealizedUsdc`, which catches
  outside losses that a disclosed address's gains cover in the registry's total;
- while `requireProvenOperator` is on it also requires at least one outside realization, so an
  operator proven only by a listed address is refused. Under the profile a figure with no outside
  realizations is accepted, because that is the state the profile exists for.

**How the logs are read.** The vault's creation block is found by bisecting `eth_getCode`, then
confirmed against the registry's own `VaultAttested` log for that vault in exactly that block. A
node that has pruned state or logs answers confidently and empty, and the confirmation is what stops
that from becoming a scan that starts too late. From there the agent reads `RealizationRecorded`
filtered by operator id, in pages, to the head. Filtering by operator id (not by vault) keeps the
sum comparable to the registry's accumulators; when the window is complete and the two differ, the
check says so, because the operator realized somewhere before this vault existed. That note is
information only and never changes the verdict. Gains and losses are summed per member. The registry emits the event on every call but moves its accumulators only
for a gain or loss above zero, so event counts mean nothing here.

The log-range limits of the two Arc RPCs in the preset, measured on 2026-10-18 with raw
`eth_getLogs` on the OperatorRegistry (the span is `to - from`):

| RPC | Widest span accepted | Refusal | Rate limit |
| --- | --- | --- | --- |
| `https://rpc.mainnet.arc.io` | 9,999 blocks (a page of 10,000) | `-32012 "requested range too large"` | `-32005 "rate limit exceeded"` |
| `https://arc.gateway.tenderly.co` | 100,000 blocks | `-32602 "query exceeds max block range 100000"` | `-32005 "rate limit exceeded"` |

Both served history from the first vault's creation block. Back-to-back requests are rate limited on
both whatever their span: 40 unspaced pages of 10,000 blocks drew the error 31 times on the first and
11 on the second, and 40 spaced 250 ms apart drew it never. That was a burst, and a scan is not one.
Sustained, 160 sequential pages on `rpc.mainnet.arc.io` drew it 44 times at 250 ms spacing (the first
at request 59), 43 times at 500 ms (the first at request 60) and never at 1,000 ms; a full scan of the
first vault, about 420 pages, was served at 250 ms by `arc.gateway.tenderly.co`. So the defaults page
at the smaller limit and pause 1,000 ms between requests, a rate limit is retried with backoff (1, 2,
4, then 8 seconds) and also doubles the pause for the rest of the session (to 8 seconds at most),
and a page a provider still refuses is narrowed.

| `discovery.logs` knob | Default | What it means |
| --- | --- | --- |
| `pageBlocks` | `10000` | Blocks per `eth_getLogs` request |
| `maxPagesPerTick` | `120` | Log requests one tick may spend across all vaults. A scan resumes where it stopped, so a vault as old as the first Arc vault was on 2026-10-18 (about 4.2 million blocks, about 420 pages) takes four ticks or more to read at the default pause, and a join is refused with the gap named until it is complete |
| `maxBlocks` | `20000000` | Never start a scan further than this behind the head; an older vault is a permanent, named gap. Arc made a block every 0.51 s between 2026-09-24 and 2026-10-18, so this is about 117 days, and a vault created at the first Arc vault's block, 22,443,745, passes it near 2027-01-19 |
| `pacingMs` | `1000` | Least pause between requests; a rate limit widens it for the session |

The scan lives in memory for the session, like the entry marks: a restarted agent reads it again.

### `policy.exit`: any one trigger is sufficient

| Knob | Default | What it means |
| --- | --- | --- |
| `maxDrawdownBps` | `1000` | Exit if NAV/share is this far below the entry mark |
| `onOracleFreezeWarning` | `true` | Exit on a NAV read failure; see the caveat in [§7](#7-risks-and-honest-limitations) |
| `onOperatorNetNegative` | `true` | Exit if the operator's realized net turns negative |

Exit triggers are OR-ed, not AND-ed: exits are the risk-off direction.

### `policy.vote`

| Knob | Default | What it means |
| --- | --- | --- |
| `evaluator` | `"naive-drift-band"` | Name, or an object implementing `{ evaluate({proposal, chain, config, nowSec}) }` |
| `driftBandBps` | `500` | Below this, a rebalance is churn and fees → **against** |
| `maxDriftBandBps` | `5000` | Above this, it is a mandate change, not a correction → **against** |
| `voteAgainstWhenUnknown` | `false` | Default is to abstain **by not committing**; an uninformed vote is not neutral, it moves the tally |
| `proposalTypes` | `[0]` | Rebalance only. RuleChange and ChildAllocation need a human |
| `requireKnownAction` | *(unset)* | Set with `knownActions` (actionHash ⇒ description) to abstain on any payload you cannot verify |

**The shipped evaluator is a demonstration of the plug point, not a strategy.** It measures the
fraction of NAV sitting idle in USDC rather than deployed into the basket, a signal that is
directly readable on-chain, unlike target weights, which live in a mandate the chain does not
publish. Swap it out by passing your own object.

### `policy.timing`

| Knob | Default | What it means |
| --- | --- | --- |
| `revealSafetyMarginSec` | `1800` | Reveal by this long before the deadline at the latest. The agent actually reveals as soon as the window opens; the margin only drives the `urgent` flag |
| `activateGraceSec` | `60` | Clock-skew tolerance past the observation window's real end |
| `tickIntervalSec` | `60` | Loop interval |

### `policy.crank`: finishing a round

| Knob | Default | What it means |
| --- | --- | --- |
| `scope` | `"held"` | `held`: only vaults where the agent has shares or a pending deposit. `all`: every vault the agent reads. `off`: no crank, and no block-time read |
| `finalize` | `true` | `finalize(pid)` once the reveal window has ended |
| `execute` | `true` | `execute(pid, payload)` for a passed Rebalance inside its execution window, and only with a payload from `knownPayloads` |
| `markExpired` | `false` | `markExpired(pid)` once the execution window has ended. Bookkeeping only, so it is off until you want a clean status |
| `knownPayloads` | `{}` | `actionHash => payload` (`0x` hex). Each entry is checked against keccak256 on every tick, and one that does not hash to its key is ignored and reported as a perception gap |

See [Cranking a round](#cranking-a-round) for what each call does and what it needs.

### `danger`: irreversible, opt-in, off

| Knob | Default | What it means |
| --- | --- | --- |
| `allowSkipWindow` | `false` | `skipWindow()` is once-per-agent-per-vault and **cannot be undone** |

The agent **never** calls `skipWindow()` autonomously. Two independent gates enforce it: the
planner will not emit the intent, and the actor refuses it again even if handed one. With the flag
on, it is still an operator's standing config decision, not an agent decision.

### Cranking a round

`Governance.finalize`, `execute` and `markExpired` have no sender check: any address may call them,
so an agent can finish a round it did not propose. They differ in what they are worth and what they need.

| Call | When it is allowed (`block.timestamp`) | Needs | Why it matters |
| --- | --- | --- | --- |
| `finalize(pid)` | Active, and `now >= revealDeadline` | the proposal id | Until it runs, every exit on the vault is Mode F and `settleQueuedExit` is blocked, so the agent's own exit waits on it. On Arc the timelock is 0, so the execution window starts when `finalize` is mined |
| `execute(pid, payload)` | Passed, and `executableAt <= now <= expiresAt` | the payload bytes | Does what the vote approved. Once it is mined, `hasPendingExecution` reads false, so queued Mode F exits can settle (`settleQueuedExit`) at post-vote NAV |
| `markExpired(pid)` | Passed, and `now > expiresAt` (strict) | the proposal id | A clean status for interfaces and the indexer. `hasPendingExecution` already reads false past expiry |

Four things to know:

- **`execute` runs only with a payload the agent was handed.** A proposal stores `actionHash`, the
  keccak of its payload, and the chain never stores the payload, so it cannot be read back. List it
  in `policy.crank.knownPayloads`; the actor sends it only when its keccak256 equals the proposal's
  `actionHash` and the proposal is a Rebalance (type 0). A Passed proposal in its window with no
  matching payload is reported with the reason and left alone. `finalize` and `markExpired` need
  only the id.
- **The clock is the chain's.** All three gates compare `block.timestamp`, so each tick reads the
  latest block's timestamp and decides on it, whatever the local clock says. When that read fails
  the local clock stands in, less `policy.timing.activateGraceSec` on the side that would act early.
  The simulation below, not the margin, is what stops a call the chain would refuse.
- **Every crank write is simulated before it is sent.** An `eth_call` of the exact calldata runs
  first, in dry-run too (it signs nothing). A revert, such as `WrongPhase` after someone else
  finalized first, drops the intent with its reason and spends no gas. A simulation that cannot run
  drops it as well.
- **The gas is the agent's.** A crank on a vault the agent holds nothing in spends gas for other
  members' benefit, which is why `scope` defaults to `held`. A held vault outside the discovery
  window is not read at all, so name it in `discovery.include`.

A tick plans from one snapshot, so a `settleQueuedExit` appears on the tick after the `finalize` or
`execute` that releases it is mined.

---

## 4. The dry-run/execute gate

```
dry-run (default)   describes every transaction, signs none
execute             requires BOTH:
                      • an operator-injected viem account object
                      • AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes
```

Missing either condition is a **hard refusal at startup**, never a silent downgrade to dry-run. A
gate that downgraded would teach an operator the env var is optional, and they would be wrong
exactly once. The value must be exactly `yes`; `1`, `true`, `YES` and `y` are all refused.

`run.mjs` deliberately has no path into execute mode. It will not build an account from a private
key found in the environment: an agent that reads `PRIVATE_KEY` from env is one leaked `.env` from
a drained wallet, and one `console.log` from a key in a logfile. To run in execute mode you inject
an account you constructed yourself:

```js
import { privateKeyToAccount } from 'viem/accounts';
import { createAgent } from './packages/reference-agent/src/agent.mjs';

const agent = createAgent({
  config: { ...config, mode: 'execute' },
  account: privateKeyToAccount(process.env.KEY),   // YOUR construction, not the agent's
  walletClient,                                    // YOUR viem wallet client
  chainReader, log, env: process.env,
});
```

### Key handling

The agent takes an **account object** and never key material. It reads `.address`, calls
`signMessage`, and nothing else. Everything log-bound passes through `redact()`, which reduces a
signer to `{ address }`, strips key-shaped fields, and collapses bare 32-byte hex; a test asserts
a key-shaped value cannot survive it. Salts and commitments appear only as `0x78ce1d7e…ba3924d3`:
enough to correlate two log lines, never enough to reconstruct.

The startup banner states the signing scope in the artifact rather than leaving it to this page,
because "dry-run signs nothing" is ambiguous: the agent *does* sign x402 payment authorizations,
since that is how a metered read is paid for:

```
│ x402-vaults reference agent — MODE: DRY-RUN                                    │
│ WILL NOT sign or send any on-chain transaction.                                │
│ WILL sign x402 payment authorizations for metered reads, up to $0.25 this session. │
│ skipWindow (irreversible): disabled.                                           │
```

Note what the banner does **not** claim: that the process holds no key. The agent never sees key
material, but whoever constructed the account object may hold one in the same process.

### The x402 spend cap

Enforced at two layers, because one is not enough:

1. **Pre-call gate**. Perception asks before each paid request, so an exhausted budget *skips* the
   read cleanly and the loop still decides on what it has.
2. **Signer backstop**. The SDK runs 402 → sign → retry inside one call, so a check afterwards is
   too late: under EIP-3009 a **signature is the spend**. The wrapped signer reads
   `typedData.message.value` and throws before producing one. A challenge that asks for more than
   expected dies here even if the pre-call gate was told a smaller number.

When the cap is exhausted, missing data is reported as a **named gap** and the join gates fail
closed: no leaderboard means no track record, which means no join.

---

## 5. The salt scheme (S-4 mitigation)

Commit–reveal voting is two transactions separated by time, and **an unrevealed commit is forfeit
and counted as an abstain** (ARCHITECTURE §8). The UX spec calls this the highest-severity
human-specific failure in the product. It is worse for an autonomous agent, which restarts far
more often than a person changes device.

The agent holds no vote state at all:

```
message = "x402-vaults:reveal-salt:v1:{chainId}:{vault}:{pid}"
salt    = keccak256(account.signMessage(message))
```

Every input is public and recoverable from chain state, so any process holding the same account
derives the same salt forever. Nothing is written to disk; there is nothing to lose.

An account that sets `saltVersion: 'v2'` signs a voter-bound message instead:

```
message = "x402-vaults:reveal-salt:v2:{chainId}:{vault}:{pid}:{voter}"
```

`voter` is `account.address` lowercased, the address that sends `commitVote`. v2 is for agents
whose voting address is not the key that signs, such as a smart account: one signing key serving
several accounts gets a different salt for each, where v1 would give them the same salt and the
first reveal would expose the others' direction. The signing key must be a dedicated salt key, not
a rotating session key, because rotating it would make every outstanding commit unrevealable. v1 is
unchanged and remains the default. Recovery always tries both schemes, the configured one first, so
a commit still reveals after a switch or after a restart without `saltVersion`
(`packages/reference-agent/src/salt.mjs`).

The commitment matches `revealVote` (`Governance.sol:409`) exactly:

```
keccak256(abi.encode(pid, msg.sender, support, salt))
```

`abi.encode`: four 32-byte words, in that order. A mismatch reverts with `BadReveal`, producing
precisely the forfeiture the scheme exists to prevent, so the test pins it to a vector produced by
`cast`, not by our own implementation:

```bash
cast keccak $(cast abi-encode "f(uint256,address,bool,bytes32)" 7 0x1111111111111111111111111111111111111111 true 0x2222222222222222222222222222222222222222222222222222222222222222)
```

### Recovery after a restart

An outstanding commit is discovered from **chain state**, never from local storage:
`commitOf(pid, voter) != 0 && !revealedOf(pid, voter)`. The agent then re-derives the salt (both
schemes, the configured one first) and tries both support values against the on-chain commitment;
exactly one reproduces it, and that is the recovery; the direction is recovered from the hash, not from memory. It verifies the
reconstruction before spending gas on a call that would otherwise revert.

A reveal it owes therefore outranks every other action in the plan, including a policy that would
no longer cast that vote today.

### Unknown is not "nothing to do"

Everywhere else the agent fails closed, and the reveal path is no exception, but here failing
closed means failing *toward* revealing. An outstanding commit is derived as
`commitment != 0 && revealed !== true`, deliberately **not** `revealed === false`: the latter
requires a *successful* read returning false, so one failed `revealedOf` call would drop the
obligation and forfeit the vote, silently, while the log asserted there was nothing to do. An
unnecessary reveal attempt costs gas and reverts harmlessly; a skipped one costs the vote.

The same applies to `proposals(pid)` and `commitOf`: a read failure is reported as **unknown** and
flagged `degraded`, so the agent says "proposal 42 is active but its state could NOT be read"
rather than "no active proposal on this vault". The next tick retries.

### Voting weight is not the share balance

Commits are gated on `pastVotingEligibleShares(member, proposal.createdAt)`, an approximation of the
measure the contract counts: `Governance` weighs each vote at the lesser of
`pastVotingEligibleShares(member, createdAt - 1)` and the member's current `votingEligibleShares`,
and quorum is computed from that same weight. Shares deposited after a proposal opened, still
inside the observation window, or locked behind a Mode-F exit carry **no** vote, so committing on
`sharesOf` would cast votes that can never count. An unreadable weight falls to zero, which blocks
the commit.

### The reproducibility caveat

This works because viem's local accounts sign with **RFC-6979 deterministic ECDSA**: same key, same
message, same signature, always. It is **not guaranteed** for hardware wallets, smart-contract
accounts, or any signer that adds entropy; such a signer would commit successfully and then be
unable to reveal.

`assertDeterministicSigner()` runs once before the first commit of a session and refuses a signer
that fails it, so the problem surfaces before a vote is at risk rather than after. If you vote with
a non-deterministic signer, do it manually.

---

## 6. Extending it

```js
const myEvaluator = {
  name: 'my-strategy',
  evaluate({ proposal, chain, config, nowSec }) {
    return { support: true|false|null, reason: 'why', detail: {} };
  },
};
// config.policy.vote.evaluator = myEvaluator
```

`support: null` means "no view", and the agent then abstains by not committing.

Modules are small and separately testable: `config` · `budget` · `salt` · `chain` · `evaluators` ·
`payloads` · `policy` (pure) · `plan` · `act` · `perceive` · `agent` · `log`.

```bash
node --test packages/reference-agent/test/*.test.mjs
```

---

## 7. Risks and honest limitations

**This is a demonstration of protocol integration. It is not financial advice, and it sits outside
the scope of the contract security review.** Do not point it at funds you would mind losing.

### It has run live, and that is the reason to be careful with it

This section previously said the opposite: that the contracts were not deployed, that
[issue #10](https://github.com/SlumperSan/agent-governed-vaults/issues/10) blocked it, and that no
transaction this agent constructs had ever been mined. The first two are false. Issue #10 is closed
and the protocol has been deployed to Base Sepolia, where the agent ran its full loop in execute
mode: join, a freeze-safety `cancelPending` detour, activate, commit, reveal, a Mode-F exit it
priced on its own, and settle, every phase with a transaction hash. See
[SOAK-REPORT.md](SOAK-REPORT.md) §5. The protocol is deployed on Arc mainnet (chain id 5042) since 2026-09-24
(`contracts/config/deployments/arc-mainnet.json`), so there is a live factory and vault this agent
could be pointed at.

The warning below applies now. The guard below is about the key, not about the vault: a key configured against any mainnet
chain signs whatever it is asked to sign, and on Arc that chain's USDC is both the settlement asset
and the native gas asset, so a compromised key there can drain gas funds as well as vault funds from
one balance. Note the one guard that already exists and its exact limit: `--demo-wallet` is refused
off a known testnet (`TESTNET_CHAIN_IDS` in `packages/reference-agent/src/run.mjs` is
`{84532, 11155111, 31337, 1337}`, and neither Arc's 5042 nor any other mainnet id is in it), so a
throwaway key cannot sign against a mainnet chain, but nothing stops a real key being configured
against one.

**The live run is what makes the warning above stronger, not weaker.** It surfaced two launch-class
bugs that no amount of mock testing had found: `requireProvenOperator: false` was inert, so no
configuration could ever admit a zero-track-record operator; and execute-mode deposits set no ERC-20
allowance, so the agent's headline action reverted `TransferFromFailed` in every possible
configuration, as shipped. Both are fixed with regression tests. Both were found only by running it.

What is still true about the demo path:

- The **API half is real**: the demo seeds a snapshot by folding synthetic events through the
  actual [`projections.mjs`](../packages/indexer/src/projections.mjs) and writing it with the actual
  `store.mjs`, then serves it from the actual `serve.mjs`. The x402 402 → authorize → retry loop,
  the projections, and the route handlers are all genuinely exercised. Only the *events* are
  synthetic.
- The **chain half is stubbed in the demo**. Every value the stub reader produces is marked
  `[stub-chain]` in the narrative. Pass `--rpc` and the same code paths run against a real node.
- The shipped CLI **cannot sign**; `run.mjs` hard-codes dry-run. The soak drill constructed the
  agent directly, and the `AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS` gate is required regardless.

### The oracle-freeze trigger detects, it does not warn

`navPerShareWad()` reverts with `StaleOracle` when a basket price is stale, so a failed NAV read
means the vault is **already frozen**, at which point exits that price a basket asset are frozen
too (ARCHITECTURE §11): an immediate (Mode I) `requestExit` and `settleQueuedExit` will revert as
well, while a Mode F `requestExit` still queues, because queueing reads no price. The oracle exposes no per-asset freshness view, so a genuine
early warning is not readable on-chain. The trigger is worth keeping; breakers can clear, and an
agent that queues its exit the moment it notices is ahead of one that waits, but it is detection
after the fact, not prevention. Do not read "oracle-freeze warning" as protection against being
stranded.

### The vote evaluator cannot see what it is voting on

A proposal commits to `actionHash`, the keccak of an execution payload; the payload is not on-chain
until `execute`. **No evaluator reading only chain state can know what a rebalance actually does.**
The shipped one judges whether the vault *looks like* it needs a rebalance, and says so in every
reason string it emits. If you have an out-of-band payload source, supply `knownActions` and set
`requireKnownAction: true`.

### Entry marks do not survive a restart

The drawdown baseline is in-memory and session-scoped, so a restarted agent re-marks at the restart
price and a pre-restart drawdown becomes invisible to it. This was a deliberate asymmetry: the
reveal obligation is recovered from chain state because losing it forfeits a vote, whereas losing an
entry mark only makes the exit policy less sensitive; it fails in the conservative direction. Seed
marks in via `entryMarks` if you keep durable history.

### Everything else

- **Forward pricing.** Exiting while a pending execution exists (any active proposal past reveal
  start, or a passed one in its window, of any type) settles at *post*-execution NAV, and the
  shares lock until someone calls `settleQueuedExit` (it is not automatic). The agent reports this loudly
  but cannot avoid it; the price it gets is not the price it sees.
- **Non-transferable shares.** Exiting is the only way out. There is no secondary market to sell
  into if the policy is wrong.
- **Naive strategy.** A drift band over idle balance is not a strategy. Anything real needs a real
  evaluator and a real risk model.
- **No gas management.** No balance check, no price ceiling, no nonce management, no retry on a
  reverted transaction beyond logging it.
- **No MEV protection.** Deposits, exits and reveals are sent as plain public transactions.
- **Single process, no persistence.** No leader election. Two instances on the same account will
  race and produce duplicate transactions.
- **The demo wallet is a demo.** `--demo-wallet` mints a throwaway key in memory, refuses any chain
  id that is not a known testnet, and never writes it down. It is for exercising the payment and
  salt paths, nothing else.
