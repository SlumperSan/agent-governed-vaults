# Reference Agent

A policy-driven autonomous vault member: it reads the metered API and the chain, decides whether to
join, vote, or exit, and describes — or, if explicitly unlocked, sends — the resulting transactions.

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
| `--api=<url>` | metered API base URL |
| `--rpc=<url>` | JSON-RPC for chain reads. **Omitted ⇒ a stub reader**, and every value it produces is marked `[stub-chain]` |
| `--governance=<addr>` `--subvault-registry=<addr>` `--usdc=<addr>` `--chain-id=<n>` | on-chain wiring |
| `--demo-wallet` | generate a throwaway in-memory key used as the x402 payer *and* the agent's identity. Testnet chain ids only. Does **not** enable execute mode |
| `--cap=<usdc>` | per-session x402 spend cap (default `0.25`) |
| `--ticks=<n>` | how many loop passes (default 1) |
| `--config=<path>` | JSON file merged over the defaults |
| `--json` | one JSON record per line instead of prose |

`run.mjs` cannot enter execute mode at all — see [§4](#4-the-dry-runexecute-gate).

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
             registries  operatorOf · stackedPerfFeeBps · stackedExitFeeCapBps

DECIDE     pure functions over that world (policy.mjs) — no clock, no I/O
             join   attested · positive net · capacity · fees · depth · concurrency · NAV readable
             vote   commit / reveal / abstain, via a pluggable evaluator
             exit   drawdown · oracle-freeze · operator net negative
             entry  activate after the window (never skip it)
             settle release Mode-F shares once the rebalance has executed

ACT        intents, risk-ordered:
             reveal → settle → exit → activate → commit → deposit
           dry-run prints each as the exact call it would make; execute sends it
```

The two data sources are not interchangeable. The API is an event projection — it knows share
books, member counts and the leaderboard. Events carry no post-swap balances and no oracle prices,
so NAV, fee schedules, pending-deposit timers, and governance deadlines are **only** knowable by
calling the contracts.

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

### `policy.join` — every gate must pass

| Knob | Default | What it means |
| --- | --- | --- |
| `requireAttestedOperator` | `true` | `operatorId == 0` means unattested. Treated as scam-quarantine. When a registry read is available it **overrides** the API, and a disagreement between the two is itself disqualifying |
| `minOperatorNetRealizedUsdc` | `"0"` | Floor on the operator's leaderboard net (gain − loss). Compared as a BigInt |
| `requireProvenOperator` | `true` | Refuse an operator with no realizations at all — "not yet negative" is not a track record |
| `maxPerfFeeBps` | `1000` | Ceiling on the **stacked** performance fee. Sub-vault fees compound up the parent chain, so 10% is a floor, not the number you pay |
| `maxExitFeeBps` | `100` | Ceiling on the **stacked** exit-fee cap |
| `depositUsdc` | `"25"` | Size of a join |
| `minFreeCapacityUsdc` | `"25"` | Refuse unless this much room remains under the cap. `capacityCapUsdc == 0` means **uncapped**, which is unlimited room, not zero |
| `maxDepth` | `0` | Sub-vault depth ceiling; `0` = top-level vaults only |
| `maxConcurrentVaults` | `3` | Never hold more positions than this |

Two further gates are not configurable because failing them open is never correct: **NAV must be
readable** (an unreadable NAV may mean a stale oracle, and a stale oracle freezes *exits* too), and
the **deposit must clear the vault minimum**. Every unreadable input fails **closed**.

### `policy.exit` — any one trigger is sufficient

| Knob | Default | What it means |
| --- | --- | --- |
| `maxDrawdownBps` | `1000` | Exit if NAV/share is this far below the entry mark |
| `onOracleFreezeWarning` | `true` | Exit on a NAV read failure — see the caveat in [§7](#7-risks-and-honest-limitations) |
| `onOperatorNetNegative` | `true` | Exit if the operator's realized net turns negative |

Exit triggers are OR-ed, not AND-ed: exits are the risk-off direction.

### `policy.vote`

| Knob | Default | What it means |
| --- | --- | --- |
| `evaluator` | `"naive-drift-band"` | Name, or an object implementing `{ evaluate({proposal, chain, config, nowSec}) }` |
| `driftBandBps` | `500` | Below this, a rebalance is churn and fees → **against** |
| `maxDriftBandBps` | `5000` | Above this, it is a mandate change, not a correction → **against** |
| `voteAgainstWhenUnknown` | `false` | Default is to abstain **by not committing** — an uninformed vote is not neutral, it moves the tally |
| `proposalTypes` | `[0]` | Rebalance only. RuleChange and ChildAllocation need a human |
| `requireKnownAction` | *(unset)* | Set with `knownActions` (actionHash ⇒ description) to abstain on any payload you cannot verify |

**The shipped evaluator is a demonstration of the plug point, not a strategy.** It measures the
fraction of NAV sitting idle in USDC rather than deployed into the basket — a signal that is
directly readable on-chain, unlike target weights, which live in a mandate the chain does not
publish. Swap it out by passing your own object.

### `policy.timing`

| Knob | Default | What it means |
| --- | --- | --- |
| `revealSafetyMarginSec` | `1800` | Reveal by this long before the deadline at the latest. The agent actually reveals as soon as the window opens; the margin only drives the `urgent` flag |
| `activateGraceSec` | `60` | Clock-skew tolerance past the observation window's real end |
| `tickIntervalSec` | `60` | Loop interval |

### `danger` — irreversible, opt-in, off

| Knob | Default | What it means |
| --- | --- | --- |
| `allowSkipWindow` | `false` | `skipWindow()` is once-per-agent-per-vault and **cannot be undone** |

The agent **never** calls `skipWindow()` autonomously. Two independent gates enforce it: the
planner will not emit the intent, and the actor refuses it again even if handed one. With the flag
on, it is still an operator's standing config decision, not an agent decision.

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
exactly once. The value must be exactly `yes` — `1`, `true`, `YES` and `y` are all refused.

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
signer to `{ address }`, strips key-shaped fields, and collapses bare 32-byte hex — a test asserts
a key-shaped value cannot survive it. Salts and commitments appear only as `0x78ce1d7e…ba3924d3`:
enough to correlate two log lines, never enough to reconstruct.

The startup banner states the signing scope in the artifact rather than leaving it to this page,
because "dry-run signs nothing" is ambiguous — the agent *does* sign x402 payment authorizations,
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

1. **Pre-call gate** — perception asks before each paid request, so an exhausted budget *skips* the
   read cleanly and the loop still decides on what it has.
2. **Signer backstop** — the SDK runs 402 → sign → retry inside one call, so a check afterwards is
   too late: under EIP-3009 a **signature is the spend**. The wrapped signer reads
   `typedData.message.value` and throws before producing one. A challenge that asks for more than
   expected dies here even if the pre-call gate was told a smaller number.

When the cap is exhausted, missing data is reported as a **named gap** and the join gates fail
closed — no leaderboard means no track record, which means no join.

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

The commitment matches `Governance.sol:292` exactly:

```
keccak256(abi.encode(pid, msg.sender, support, salt))
```

`abi.encode` — four 32-byte words, in that order. A mismatch reverts with `BadReveal`, producing
precisely the forfeiture the scheme exists to prevent, so the test pins it to a vector produced by
`cast`, not by our own implementation:

```bash
cast keccak $(cast abi-encode "f(uint256,address,bool,bytes32)" 7 0x1111111111111111111111111111111111111111 true 0x2222222222222222222222222222222222222222222222222222222222222222)
```

### Recovery after a restart

An outstanding commit is discovered from **chain state**, never from local storage:
`commitOf(pid, voter) != 0 && !revealedOf(pid, voter)`. The agent then re-derives the salt and
tries both support values against the on-chain commitment; exactly one reproduces it, and that is
the recovery — the direction is recovered from the hash, not from memory. It verifies the
reconstruction before spending gas on a call that would otherwise revert.

A reveal it owes therefore outranks every other action in the plan, including a policy that would
no longer cast that vote today.

### Unknown is not "nothing to do"

Everywhere else the agent fails closed, and the reveal path is no exception — but here failing
closed means failing *toward* revealing. An outstanding commit is derived as
`commitment != 0 && revealed !== true`, deliberately **not** `revealed === false`: the latter
requires a *successful* read returning false, so one failed `revealedOf` call would drop the
obligation and forfeit the vote, silently, while the log asserted there was nothing to do. An
unnecessary reveal attempt costs gas and reverts harmlessly; a skipped one costs the vote.

The same applies to `proposals(pid)` and `commitOf`: a read failure is reported as **unknown** and
flagged `degraded`, so the agent says "proposal 42 is active but its state could NOT be read"
rather than "no active proposal on this vault". The next tick retries.

### Voting weight is not the share balance

Commits are gated on `pastVotingEligibleShares(member, proposal.createdAt)` — the measure the
contract counts, and the same one quorum uses. Shares deposited after a proposal opened, still
inside the observation window, or locked behind a Mode-F exit carry **no** vote, so committing on
`sharesOf` would cast votes that can never count. An unreadable weight falls to zero, which blocks
the commit.

### The reproducibility caveat

This works because viem's local accounts sign with **RFC-6979 deterministic ECDSA**: same key, same
message, same signature, always. It is **not guaranteed** for hardware wallets, smart-contract
accounts, or any signer that adds entropy — such a signer would commit successfully and then be
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
`policy` (pure) · `plan` · `act` · `perceive` · `agent` · `log`.

```bash
node --test packages/reference-agent/test/*.test.mjs
```

---

## 7. Risks and honest limitations

**This is a demonstration of protocol integration. It is not financial advice, and it sits outside
the scope of the contract security review.** Do not point it at funds you would mind losing.

### It has run live, and that is the reason to be careful with it

This section previously said the opposite — that the contracts were not deployed, that
[issue #10](https://github.com/SlumperSan/agent-governed-vaults/issues/10) blocked it, and that no
transaction this agent constructs had ever been mined. **All three are false.** Issue #10 is closed,
the protocol has been deployed to Base Sepolia, and the agent ran its full loop there in execute
mode — join, a freeze-safety `cancelPending` detour, activate, commit, reveal, a Mode-F exit it
priced on its own, and settle, every phase with a transaction hash. See
[SOAK-REPORT.md](SOAK-REPORT.md) §5.

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
- The shipped CLI **cannot sign** — `run.mjs` hard-codes dry-run. The soak drill constructed the
  agent directly, and the `AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS` gate is required regardless.

### The oracle-freeze trigger detects, it does not warn

`navPerShareWad()` reverts with `StaleOracle` when a basket price is stale, so a failed NAV read
means the vault is **already frozen** — at which point exits are frozen too (ARCHITECTURE §11) and
`requestExit` will revert as well. The oracle exposes no per-asset freshness view, so a genuine
early warning is not readable on-chain. The trigger is worth keeping — breakers can clear, and an
agent that queues its exit the moment it notices is ahead of one that waits — but it is detection
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
entry mark only makes the exit policy less sensitive — it fails in the conservative direction. Seed
marks in via `entryMarks` if you keep durable history.

### Everything else

- **Forward pricing.** Exiting while a passed-but-unexecuted rebalance exists settles at
  *post*-rebalance NAV, and the shares lock until `settleQueuedExit`. The agent reports this loudly
  but cannot avoid it — the price it gets is not the price it sees.
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
