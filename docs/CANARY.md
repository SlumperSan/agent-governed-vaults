# Canary — post-launch monitoring

The canary watches a deployed vault set and **stays silent while healthy**. It prints one line per
signal *transition* (OK→ALERT, ALERT→OK, OK→DEGRADED), so anything it says is worth reading. It is
the runnable form of the signal table in [DEPLOYMENT.md §6](DEPLOYMENT.md).

It is **strictly read-only**: a viem *public* client, `eth_call` / `eth_getLogs` /
`eth_blockNumber` / `eth_getBlockByNumber` and nothing else. There is no wallet client, no account,
and no key anywhere in `packages/canary`. It reads the indexer's snapshot but never writes it — its
own transition state lives at a separate path.

```bash
RPC_URL=… OPERATOR_REGISTRY_ADDRESS=… STATE_PATH=./data/indexer-state.json npm run start:canary
```

---

## 1. What it needs

| Var | Required | Default | Meaning |
|---|---|---|---|
| `RPC_URL` | ✅ | — | Base (or Base Sepolia) HTTP RPC endpoint |
| `STATE_PATH` | | `./data/indexer-state.json` | the indexer snapshot; the vault set is discovered from it |
| `VAULTS` | | — | explicit comma-separated vault list, to run without an indexer |
| `OPERATOR_REGISTRY_ADDRESS` | | — | enables the fee-routing signal |
| `EXTRA_OPERATOR_ADDRESSES` | | — | extra operator addresses to treat as prohibited fee destinations |
| `CANARY_STATE_PATH` | | `./data/canary-state.json` | transition state, so a restart does not re-page |
| `ALERT_WEBHOOK_URL` | | — | POST one JSON body per transition |
| `CANARY_POLL_INTERVAL_MS` | | `30000` | sweep cadence (named apart from the indexer's `POLL_INTERVAL_MS` — compose feeds both one `.env`, and a sweep is heavier than an indexer poll) |
| `CONFIRMATIONS` | | `5` | blocks to lag head, matching the indexer |
| `NAV_DIVERGENCE_BPS` | | `50` | NAV composition bar, 50 = 0.5% |
| `ORACLE_MIN_HEADROOM_BPS` | | `2500` | alert when a feed has this share or less of its heartbeat left (2500 = 25%) |
| `MAX_LOG_SPAN_BLOCKS` | | `2000` | cap on one sweep's `getLogs` range |
| `LOG_LOOKBACK_BLOCKS` | | `0` | cold-start event lookback |
| `HEARTBEAT_MS` | | `0` (off) | periodic "still watching" line, so silence is provably alive |

**Signals (c) and (d) need the indexer projection.** With `VAULTS` alone and no snapshot they report
DEGRADED, not OK — see §4.

---

## 2. Reading the output

```
2026-08-19T04:12:07.881Z ALERT [exit-liveness] EXIT LIVENESS BROKEN on vault 0xa1a1…cafe (H-1
regression): requestExit(1) as member 0x6666…6666 reverts with Reentrancy — a non-gate revert
means members cannot exit (measured Reentrancy, threshold no non-gate revert)
```

Every line carries the **vault**, the **signal**, and **measured vs threshold**. Alerts and
degradations go to stderr, recoveries to stdout, so `2>` gives a pure problem feed. The webhook body
carries the same fields plus the structured `detail` for routing.

Three statuses:

- **ALERT** — measured, out of threshold. Page.
- **RECOVERED** — back within threshold.
- **DEGRADED** — the check could not run at all. Deliberately *not* folded into OK: a sentinel that
  has stopped being able to run is exactly the thing you would otherwise never notice.

A standing problem is reported **once**, not every poll, and the state survives a restart.

---

## 3. The signals

### (a) `oracle-freshness` — headroom to the staleness breaker

**What it watches.** The oracle each vault is pinned to, which since the C-6 pivot is
[`ChainlinkOracle`](../contracts/src/oracle/ChainlinkOracle.sol): **one genuine Chainlink Data Feed
per asset**, no median, no quorum, no per-vault source list. It fans out one result per basket
asset, plus one for the L2 sequencer gate.

> **This signal was blind until 2026-08-30.** It read `assetConfig(address)`, which exists only on
> the *retired* `OracleAggregator`, so against the deployed stack it reverted on every poll, for
> every asset, on every vault, and parked permanently in DEGRADED — silent about oracle freshness
> because it could not see it (found during the gate-7 restore drill,
> [RESTORE-DRILL.md §5](RESTORE-DRILL.md)). Two things now make that class of failure loud: the
> ALERT path depends only on `priceWad`, which every oracle model implements, and
> `packages/canary/test/abis.test.mjs` compares the canary's oracle table against the **compiled**
> `ChainlinkOracle` artifact, so the next divergence fails in CI instead of on a live deployment.

**What it measures**, per basket asset:

| | |
|---|---|
| **The breaker** | `priceWad(asset)`. It never returns 0 and never returns a stale price — it reverts `StaleOracle`. A revert is a **live capital freeze**: every NAV path in the vault reverts with it, exits included. |
| **The headroom** | `heartbeat - (chainNow - feed.updatedAt)` — how much silence the asset's feed has left before the oracle rejects it. Reported in **bps of the heartbeat**, so one bar works across mainnet's 3,600 s bound and testnet's 86,400 s one. |

**Threshold.** ALERT when headroom `<=` `ORACLE_MIN_HEADROOM_BPS` (default 2500 = 25% of the
heartbeat), or when `priceWad` reverts at all.

> The bar is 25% on purpose. A Chainlink feed publishes on a deviation threshold *or* its heartbeat,
> and the configured heartbeat sits at or above the feed's own, so a healthy feed is nowhere near
> the bound: Base Sepolia's ETH/USD was 307 s into an 86,400 s heartbeat at address-book
> verification (99.6% headroom), and Base mainnet ETH/USD publishes at least every 1,200 s against a
> 3,600 s bound (≥66%). 25% never fires in steady state and still gives 15 minutes of warning on
> mainnet. Raising it much further would page forever and get the canary muted — the same mistake as
> being blind, in the other direction.

**`ORACLE_MIN_MARGIN` is gone.** It set a *source-count* margin (`freshSources - quorum`) against an
oracle model the launch tree no longer deploys, so it could not be ported. The canary **refuses to
start** if it is still set, rather than ignoring a value an operator deliberately tuned.

**When the breaker trips, the alert names the cause** — walking `priceWad`'s own reject order, so
"chase the feed operator" is not the reflex response to something else: the feed is *stale past its
heartbeat*; the answer is *non-positive*; the asset is *not listed*; the feed itself *reverts*; or
the price is *outside the oracle's sane-price band* (the depeg / deprecated-clamp defence, where the
feed reads perfectly fresh and chasing it would waste the outage).

**The L2 sequencer gate** (`sequencer` key). `ChainlinkOracle` runs `_requireSequencerUp` **before**
any price is read, so a down — or just-restarted — Base sequencer freezes *every* asset on *every*
vault priced by that oracle. It therefore gets **one** result for the vault, and while it is failing
the per-asset results are DEGRADED and attributed to it: one root cause, one page. Three notes on
polarity, each of which would otherwise manufacture a permanently-red or permanently-blind signal:

- an **unset** feed (`address(0)`, the deliberate Base Sepolia configuration) means the contract
  skips the gate, so the canary reports it **healthy and stays silent**;
- the uptime feed's own `updatedAt` is **not** staleness-checked, matching the contract — it writes
  only on an up↔down transition, so an ancient timestamp is its healthy steady state;
- `GRACE_PERIOD` is **read from the deployed oracle**, never copied into JS.

**When it fires. There is no contract-side remedy** — the breaker is immutable and has no hatch by
design ([SF-2 / K-4](THREAT-MODEL.md)); any exit-during-staleness escape *is* the stale-price exit
the breaker exists to prevent. Restoring the feed is the only fix, which is exactly why the headroom
warning matters: after the heartbeat elapses there is nothing left to do. Meanwhile, pending
(observation-window) capital is **not** trapped — `cancelPending` reads no oracle — so tell members
with un-activated deposits they can still reclaim them. A sequencer-grace alert needs no action at
all: capital unfreezes when the window elapses, and the alert says when.

**Coverage limit, stated rather than hidden.** Against an oracle that is *not* a `ChainlinkOracle`,
the headroom and sequencer checks cannot run. The signal then emits **one** DEGRADED line per vault
(`oracle-model`) saying so, and keeps paging per asset for freezes via `priceWad`. A narrowed check
that announces itself — never a silent one.

Threat-model rows: [SF-1](THREAT-MODEL.md) (source independence), [SF-2](THREAT-MODEL.md) (the
accepted freeze).

### (b) `nav-backing` — is NAV actually backed?

Two independently-keyed legs.

**`composition`** recomputes `navWad()` from the vault's own component getters and compares. The
recompute mirrors `VaultCore.navWad()` exactly, including the SV-7 look-through: descendants are
valued from their *internal* `assetBalance`, priced through **this** vault's oracle and
`assetUnit`/`usdcScalar`, recursing to `MAX_LOOKTHROUGH_DEPTH = 3`, multiply-then-divide so the
truncation matches. Every read is pinned to one block height, so a healthy vault diverges by
**exactly 0** — this is an invariant check, not an estimate.

- **Threshold.** ALERT above `NAV_DIVERGENCE_BPS` (default 50 = 0.5%). Any nonzero divergence below
  the bar still appears in `detail.divergenceBps` and is worth a look.
- **What it catches.** A look-through that drops descendant value from the root (the shape of S6
  Finding 1), a basket asset the oracle cannot price, a child whose share accounting moved under its
  parent, an `assetUnit` that does not match a token's real decimals.

**`custody`** compares internal accounting against the token balances the vault actually holds:
`balanceOf(vault) >= idleUsdc + totalPendingUsdc` for USDC, and `balanceOf(vault) >= assetBalance[a]`
per basket asset. **One-sided on purpose.** A *surplus* never alerts — donations, EE-6 escrowed
in-kind slices, and EE-1 observation-window capital all sit in the token balance without being in
NAV. A **shortfall** alerts: the vault believes it owns more than it holds.

**When composition fires.** Compare `detail.navWad` against `detail.recomputedWad`. If the recompute
is *higher*, value is being dropped from the reported NAV (look-through or pricing). If reported is
higher, NAV is overstated and every `navPerShareWad` consumer — deposits minting shares, exits
paying out — is mispricing. Treat an overstatement as capital-affecting: stop directing new deposits
at the vault and reconcile before anything else.

**When custody fires.** This is the serious one. Reconcile `detail.shortfalls` — token, `owed`
(internal accounting), `held` (actual balance). A USDC shortfall on a vault whose address has been
blacklisted is [PX-1](THREAT-MODEL.md), documented and accepted, not a bug; anything else means
tokens left the vault without the accounting following.

Threat-model rows: [EE-1](THREAT-MODEL.md), [SV-7](THREAT-MODEL.md), [PX-1](THREAT-MODEL.md).

### (c) `share-conservation` — indexer vs chain

**What it measures.** Against one chain read of `totalShares()`: the projection's folded
`totalShares`, and the sum of its per-member share book. Either disagreeing alerts.

**Threshold.** Exactly 0. Shares are conserved or they are not.

**The height problem, and how it is handled.** The indexer lags head by `CONFIRMATIONS`, so comparing
it against a `latest` read would false-alarm on every deposit in the confirmation window. The chain
read is therefore **pinned to the snapshot's own `lastBlock`**. If the RPC cannot serve state at that
height (a pruned, non-archive node) the check falls back to `latest`, marks itself `pinned: false`,
and asks the runner for **two consecutive** observations before paging — alive on a pruned node
rather than silently dead, without paging on ordinary lag.

**When it fires.** Check `detail.pinned` first. If false, the mismatch may still be lag on a busy
chain — point `RPC_URL` at an archive node for a definitive answer. If pinned, one of two things is
true: the **indexer** missed or double-counted a `DepositActivated`/`ExitSettled` (re-index from the
factory deploy block and see if it reconciles), or the **chain** state is genuinely inconsistent with
its own event history, which is a contract-level finding and escalates immediately.

### (d) `exit-liveness` — the H-1 regression sentinel

**What it measures.** Static-calls `requestExit(shares)` **as a real member** and classifies the
revert. The member comes from the indexer's share book (a non-creator holder preferred, since the
creator hits the CM-1 stake gate); the amount is clamped to their balance.

Why "as a real member" is load-bearing: `requestExit` reverts `ZeroAmount` on 0 shares and
`InsufficientShares` unless the caller holds them. **Probing from an arbitrary address would revert
with a gate error every time and the sentinel would report healthy forever while exits were
bricked.** That is the failure mode this signal is designed against, and `test/exit-liveness.test.mjs`
pins it.

Three-way classification:

| Revert | Status | Why |
|---|---|---|
| `ZeroAmount`, `InsufficientShares`, `ExitAlreadyQueued`, `CreatorStakeGate`, `ExitNeedsChildSettlement`, `ChildSettlementPending` | **OK** | gates on the caller's own position — expected |
| `StaleOracle` | **DEGRADED** | the SF-2/K-4 breaker. By design, but it *is* a live capital freeze, so it never reads as OK. Attributed to the oracle signal, which pages for it — one root cause, one page |
| anything else — `Reentrancy`, `Panic`, `Error(string)`, an unrecognized selector, or **empty returndata** | **ALERT** | a non-gate revert means members cannot exit |

Empty returndata is the actual H-1 signature — a creator-chosen module that ran out of its 300k gas
cap or bombed returndata. There is deliberately **no** "could not classify, assume healthy" branch.

**Threshold.** No non-gate revert.

**When it fires.** Members cannot leave. Check the `module-events` signal on the same vault: a
concurrent `ModuleCallFailed` names the module that broke. `VaultCore` gas-caps module calls and
falls back to Mode I on governance failure ([MO-1](THREAT-MODEL.md)), so a non-gate revert here
means a mitigation has regressed — this is an escalate-now finding, not a watch item. There is no
upgrade path on a deployed vault; the remedy is a contract fix on the *next* deployment plus getting
members out of this one however the surviving paths allow.

Threat-model row: [MO-1](THREAT-MODEL.md) (review H-1).

### (e) `module-events` — ModuleCallFailed + SliceEscrowed

**What it measures.** Both events over the poll window. Neither is folded by the indexer's
projection, so the canary reads them itself.

- `ModuleCallFailed(module, member)` — a creator-chosen bookkeeping module misbehaved on the exit
  path. The exit still settled (the mitigation working) but the module's bookkeeping was
  **forfeited**; for the `feeEngine.*` paths that means an operator's fee accounting silently did not
  happen. It is also the leading indicator for signal (d).
- `SliceEscrowed(member, asset, amount)` — an in-kind transfer failed, so that asset's slice was set
  aside as `claimable` rather than reverting the whole redemption (EE-6 / MO-2). Also the mitigation
  working — and also worth knowing, because a token that keeps failing transfers leaves members
  holding claims instead of assets.

**Threshold.** 0 events per window.

**Shape.** This is an *occurrence* signal, not a level. One burst produces exactly two lines: the
alert naming the events, then a recovery on the next quiet window. The recovery means "no further
failures in the following window", **not** "the earlier failure was resolved."

**When it fires.** `detail.moduleCallFailed[].module` is the decoded label
(`feeEngine.onRealize`, `feeEngine.onFeeCollected`, `feeEngine.onFeeCollectedAsset`). Repeated
failures on one module mean that module is broken for this vault — reconcile the operator's fee
accounting by hand, and treat it as a strong hint to re-check signal (d). Repeated `SliceEscrowed`
for one asset means that token is failing transfers; tell affected members to `claimEscrowed`.

Threat-model rows: [MO-1](THREAT-MODEL.md), [MO-2](THREAT-MODEL.md), [EE-6](THREAT-MODEL.md).

### (f) `fee-routing` — USDC straight to an operator

**What it measures.** USDC `Transfer` logs with `from = vault` and `to` = a **registered operator
address** (`operatorAddressOf(operatorOf(vault))`, plus `EXTRA_OPERATOR_ADDRESSES`).

The invariant ([EE-9](THREAT-MODEL.md) / [MO-4](THREAT-MODEL.md)): performance fees reach the
operator **only** through the FeeEngine — vault transfers to the engine, engine credits
`claimableFees[operator]`, operator calls `claimFees`. Exit fees never route to the operator at all;
they accrue to remaining members through the share price.

**Operator-as-member is legitimate and is excused.** EE-9 says so explicitly: an operator who is also
a member receives their pro-rata share like anyone else, because the prohibition is on *routing*, not
identity. A transfer to the operator address is only a violation if there is no
`ExitSettled(member=operator)` or `PendingCancelled(member=operator)` **in the same block**. Without
that discriminator this signal would page every time an honest operator exited their own position.

**Threshold.** 0 unexcused direct transfers.

**Why this is the narrow check.** An inverse allowlist — alert on any destination that is not the
engine, a member, a child, or an adapter — would fire on ordinary exit payouts to members the indexer
has not projected yet, on rebalance transfers to adapters, and on `cancelPending` refunds. That
signal cries wolf and gets muted, which is worse than not having it. This one alerts on exactly the
destination the threat model prohibits. If you want the broad sweep, run it as a separate
informational feed, not as the pager.

**When it fires.** `detail.transfers[]` gives tx hash, block, and amount. Fees leaving to the
operator outside the claim flow is a value-extraction finding: reconcile against `FeeCredited` /
`FeesClaimed` on the FeeEngine for the same period, and treat the vault as compromised until the
transfers are explained.

---

## 4. Signals that cannot run

A DEGRADED line is not a false alarm to be tuned away — it means a check is **not covering** the
vault. The cases:

| Line | Cause | Fix |
|---|---|---|
| `exit-liveness sentinel CANNOT RUN … no member holding shares` | the projection lists no holder to probe with | wait for the first deposit, or check the indexer is caught up |
| `… not in the indexer projection` | the vault is in `VAULTS` but not in the snapshot | point `STATE_PATH` at a caught-up indexer, or set `START_BLOCK` to the factory deploy block so the vault is discovered |
| `… reverts StaleOracle` (NAV, exit liveness) | the oracle breaker is tripped | signal (a) is paging for the real cause; coverage resumes when the breaker clears |
| `vault … is unreadable` | wrong address, wrong chain, or the RPC is failing | check `RPC_URL`/`CHAIN_ID` and the address |
| `no vaults to watch` | empty watch set | set `VAULTS`, or point `STATE_PATH` at a snapshot that has seen a `VaultCreated` |

An empty watch set is reported loudly rather than read as a clean bill of health.

**Event scan gaps.** If the canary is down long enough that the backlog exceeds
`MAX_LOG_SPAN_BLOCKS`, it scans the most recent window and moves on — the older blocks are never
scanned for `ModuleCallFailed`, `SliceEscrowed`, or fee outflows. It says so explicitly:

```
canary: event scan gap — blocks 996-1984 (989 blocks) were NOT scanned for
ModuleCallFailed/SliceEscrowed/fee outflows. The backlog exceeded MAX_LOG_SPAN_BLOCKS=10;
raise it or scan that range manually.
```

The level signals (a–d) read current state and are unaffected. Only the two window-scoped event
signals have the hole. Raise `MAX_LOG_SPAN_BLOCKS` or sweep the range by hand.

---

## 5. Operating notes

- **Silence is the healthy state**, which makes "is it alive?" a fair question. Set `HEARTBEAT_MS`
  (e.g. `3600000`) for an hourly one-line summary of vault count, signals tracked, and how many are
  not OK.
- **Restarts do not re-page.** Transition state persists to `CANARY_STATE_PATH` (atomic
  write-temp-then-rename, same discipline as the indexer snapshot). Delete that file to force a fresh
  report of everything currently wrong.
- **A paging outage is not a monitoring outage.** A webhook that throws, times out, or returns 500 is
  logged and stepped over; the sweep continues.
- **One broken vault does not blind the others.** A signal that errors becomes a DEGRADED result for
  that vault and the sweep carries on.
- **Cold start sees no history.** With the default `LOG_LOOKBACK_BLOCKS=0`, the first sweep scans a
  single block, so `ModuleCallFailed`, `SliceEscrowed`, and fee outflows from *before* the canary
  started are never reported. That is deliberate — starting a monitor should not replay a backlog as
  fresh pages — but if you are standing the canary up after a vault has been live for a while, set
  `LOG_LOOKBACK_BLOCKS` to cover the gap for the first run. The level signals (a–d) read current
  state and are complete from the first sweep regardless.
- **Sizing.** A sweep is `O(vaults × basket assets × oracle sources)` reads. The default 30s cadence
  is comfortable for a handful of vaults on a normal RPC; raise `CANARY_POLL_INTERVAL_MS` before
  raising your rate limit.

## 6. Tests

`npm run test:backend` includes `packages/canary/test/*.test.mjs` — 113 tests, every one with a
mocked client. **No live RPC in CI.** Both a healthy and an alerting fixture exist for every signal.

Two guards worth knowing about:

- `test/abis.test.mjs` recomputes every embedded 4-byte selector with viem and cross-checks the
  watched events, the views, and the gate errors against the **compiled** `VaultCore` ABI. A stale
  gate selector would file a live fault as a benign gate and silence the H-1 sentinel, so this is not
  optional bookkeeping. It skips gracefully when `contracts/out` or viem is absent.
- `test/reader.test.mjs` asserts the chain reader exposes no send/sign/write surface, and
  `test/abis.test.mjs` asserts the ABI table declares no non-`view` function. The read-only claim is
  enforced, not just documented.
