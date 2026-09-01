# Canary — post-launch monitoring

The canary watches a deployed vault set and **stays silent while healthy**. It prints one line per
signal *transition* (OK→ALERT, ALERT→OK, OK→DEGRADED), so anything it says is worth reading. It is
the runnable form of the signal table in [DEPLOYMENT.md §6](DEPLOYMENT.md).

"Silent while healthy" is a claim about transition lines specifically. By default the canary also
prints an hourly "still watching" heartbeat line (§5) — a deliberate exception, not a contradiction:
without it a dead canary and a healthy protocol produce the identical observation (nothing), which
is exactly the operational blind spot the dead-man's switch in §5.3 closes.

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
| `CANARY_STATE_PATH` | | `./data/canary-state.json` | transition state, so a restart does not re-page. Also holds the aggregator identities `feed-identity` pins on first sight; see §3(g) |
| `PAGE_WEBHOOK_URL` | | — | POST one JSON body per PAGE-tier transition; see §5.3 |
| `LOG_WEBHOOK_URL` | | — | POST one JSON body per LOG-tier transition; see §5.3 |
| `ALERT_WEBHOOK_URL` | | — | back-compat fallback for whichever of the two above is unset; see §5.3 |
| `DEADMAN_PING_URL` | | — | off-host dead-man's switch, pinged once per successful sweep; see §5.3 |
| `CANARY_TEST_ALERT_ON_START` | | off | `1`/`true`: fire the alert self-test once at startup; see §5.3 |
| `CANARY_POLL_INTERVAL_MS` | | `30000` | sweep cadence (named apart from the indexer's `POLL_INTERVAL_MS` — compose feeds both one `.env`, and a sweep is heavier than an indexer poll) |
| `CONFIRMATIONS` | | `5` | blocks to lag head, matching the indexer |
| `NAV_DIVERGENCE_BPS` | | `50` | NAV composition bar, 50 = 0.5% |
| `ORACLE_MIN_MARGIN` | | `0` | **retired-oracle deployments only** — alert when `freshSources - quorum <= this`. Inert against a `ChainlinkOracle`, which has no quorum |
| `ORACLE_FEED_CADENCE_SECONDS` | | — | **`ChainlinkOracle` deployments only** — `addr:seconds` pairs giving each feed's own publish cadence, sourced from `contracts/config/*.json`'s `feedCadenceSeconds`. Drives the derived early-warning bar below; see §3(a) |
| `ORACLE_STALENESS_WARN_PCT` | | unset (derived) | **`ChainlinkOracle` deployments only** — MANUAL override of the early-warning bar (% of heartbeat), which otherwise alerts once a feed's answer has aged past it, *before* the breaker trips. Unset = DERIVED per asset from `ORACLE_FEED_CADENCE_SECONDS`; see §3(a) |
| `MAX_LOG_SPAN_BLOCKS` | | `2000` | cap on one sweep's `getLogs` range |
| `LOG_LOOKBACK_BLOCKS` | | `0` | cold-start event lookback for `module-events`/`fee-routing`. Set it to cover any expected restart gap — the default scans only one block, so events between shutdown and restart are otherwise never seen (see §4) |
| `HEARTBEAT_MS` | | `3600000` (one hour) | periodic "still watching" line, so silence is provably alive. Non-negotiable per security-ops.md §5.2 — set `0` to explicitly opt out |
| `USDC_USD_FEED_ADDRESS` | | Base mainnet feed on `CHAIN_ID=8453`, else unset | Chainlink USDC/USD reference feed for the `depeg-reference` signal (G4); see §3(i) |

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

Three statuses, rendered as four marks:

- **ALERT** — measured, out of threshold. Page.
- **RECOVERED** — back within threshold.
- **DEGRADED** — the check could not run, because the *system* is in a state it cannot measure (no
  member to probe with, no indexer projection, `navWad` behind a tripped breaker). Deliberately
  *not* folded into OK: a sentinel that has stopped being able to run is exactly the thing you
  would otherwise never notice. Another signal is paging for the real cause.
- **DETECTOR BROKEN** — the check could not run because the **monitor itself is blind**: it cannot
  reach its target, does not understand the contract it is pointed at, or threw. Nothing was
  measured and nobody knows what is being missed.

A standing problem is reported **once**, not every poll, and the state survives a restart.
**DETECTOR BROKEN is the single exception**: it is re-asserted on a doubling backoff — sweeps 1, 2,
4, 8, 16, 32, then every 64 — each line carrying how many consecutive sweeps the check has been
blind, and a restart re-asserts it within two sweeps rather than inheriting silence.

> **Why that one case earns the noise.** Report-once is right for a problem in the *system*: someone
> is already looking at it. It is exactly wrong for a problem in the *monitor*, because silence is
> this canary's healthy state, so a dead detector reads as good news. That is not hypothetical — it
> is what happened here. The pre-pivot oracle signal called `assetConfig` on a `ChainlinkOracle`
> that has no such function, emitted one DEGRADED line at startup, and then said nothing at all
> while the flagship freeze detector was dead. A monitor that fails quietly is worse than no
> monitor, because it manufactures confidence.

---

## 3. The signals

### (a) `oracle-freshness` — is the price good enough to move money at?

One signal, **two implementations**, chosen per vault by probing the deployed oracle. The C-6 pivot
replaced the bespoke multi-source `OracleAggregator` with `ChainlinkOracle` — one genuine Chainlink
Data Feed per asset — so there is no quorum and no margin any more: an asset is either priceable or
frozen. `signals/oracle-health.mjs` measures the live oracle, `signals/oracle-freshness.mjs` still
measures the retired one, and `checkOracleSignals()` dispatches between them. The signal *name*,
and therefore the transition history, is the same across both.

The probe is `sequencerUptimeFeed()` (only `ChainlinkOracle` answers it) then `assetConfig()` (only
the retired aggregator answers it). **An oracle that answers neither is `DETECTOR BROKEN`**, not
healthy — that is the failure this signal was rebuilt around.

#### The live oracle (`ChainlinkOracle`)

**Ground truth is `priceWad(asset)` itself.** The sweep calls it and treats a revert as the
incident, because fail-closed means the revert *is* the freeze. The per-field reads exist only to
**attribute** that revert. Five causes, in the contract's own order:

| Cause | Read | Alert line says |
|---|---|---|
| **Sequencer down** | uptime feed `answer != 0` | `BASE SEQUENCER DOWN` — every asset of every vault on this oracle is frozen |
| **Sequencer grace tail** | `now - startedAt <= GRACE_PERIOD` | `SEQUENCER GRACE PERIOD`, with the exact unix second pricing resumes |
| **Unlisted asset** | `feedOf(asset).feed == address(0)` | the asset is not listed, so `priceWad` reverts permanently |
| **Heartbeat** | `now - updatedAt > heartbeat` | how many seconds past the configured heartbeat it is |
| **Sane-price band** | `answer × scale` outside `[minPriceWad, maxPriceWad]` | the derived price and the band it left |
| *(also)* dead feed, non-positive answer, unset or future `updatedAt` | `latestRoundData()` | named individually |

Two boundaries are copied from the contract deliberately, and the tests pin both: staleness trips at
age **greater than** the heartbeat (age exactly equal is still fresh), and the band is enabled by
`maxPriceWad != 0` **alone** — a zero floor is not the disable switch.

**The sequencer leg reads `answer` and `startedAt`, and ignores `updatedAt`.** The uptime feed is
event-driven: it only writes on an up↔down transition, so a months-old `updatedAt` is its healthy
steady state. Staleness-checking it would report a permanent outage on a perfectly healthy chain —
and `_requireSequencerUp` ignores it for exactly that reason. It gets its own transition key
(`sequencer`), because when it trips it freezes every vault on the oracle at once.

**Threshold.** `priceWad` returns. There is also a pre-trip early-warning bar that alerts while the
vault is still priceable, once the answer has aged past it — and unlike the first cut of this
signal, **that bar is on by default wherever it can be set safely**, not off everywhere.

**The bar is DERIVED per asset, never a flat assumed percentage.** A single number cannot be
calibrated once for every feed: it has to clear the worst age a *healthy* feed ever reaches — which
is close to the feed's own publish cadence, not the wider staleness bound `feedOf` reports — and
still leave real runway before the freeze. No oracle exposes its own cadence on-chain (it is
Chainlink's off-chain publishing config, not contract state), so it has to be **told**, via
`ORACLE_FEED_CADENCE_SECONDS` (address:seconds pairs, sourced from
`contracts/config/*.json`'s `chainlinkOracle.assets[].feedCadenceSeconds`). Given that, the canary
computes the bar as **2× the feed's own cadence** — comfortably above the ~1× worst healthy age —
and **disables it, rather than tightening it**, once that would land past 90% of the configured
heartbeat: past that point the bound is not meaningfully wider than the feed's own cadence, and any
bar at all would page on ordinary heartbeat-cadence updates. That single condition is the answer to
the failure mode the first cut of this bar shipped off by default to avoid.

For the actual launch config — mainnet WETH and cbBTC, cadence 1200s against a 3600s bound (ratio
3) — the derived bar is 2,400s (66.7% of the heartbeat), giving 1,200s of runway before the freeze
and 2× margin over the worst healthy age. Base Sepolia's feeds have "no economic SLA" (see
`heartbeatNote` in the config), so no cadence is configured there and the bar correctly stays off —
there is nothing to derive it from safely, not a gap to fill in.

**`ORACLE_STALENESS_WARN_PCT` still works exactly as a manual override**, and wins outright over the
derivation in both directions: set it to force a specific bar (as a % of heartbeat, as before), or
set it explicitly to `0` to force the warning off even where the derivation would otherwise enable
it — an operator's explicit choice is never silently re-enabled by the derived default. Only an
*unset* env var lets the derivation apply. A healthy result's `detail` always names which mode is
active (`warnBarSource`: `'manual' | 'derived' | 'off'`) and, when off, why
(`warnDisabledReason`) — "no early warning is running for this asset" is a fact the signal states,
not a silence someone has to infer.

Credit where due: the calibration argument that a Chainlink feed's real cadence sits well inside its
configured bound — which is what makes an early-warning bar safe at all — is
[#85](https://github.com/SlumperSan/agent-governed-vaults/pull/85)'s. This sprint derives the bar
from that ratio per feed, rather than assuming one flat percentage is safe for every deployment.

**When it fires.** There is **no contract-side remedy** and, unlike the retired design, no second
source to fail over to: the heartbeat, the band, the feed and the vault's oracle are all immutable
([SF-2 / K-4](THREAT-MODEL.md)). Read `detail` for the cause and follow
[INCIDENTS.md §1](INCIDENTS.md). Pending (observation-window) capital is **not** trapped —
`cancelPending` reads no oracle — so tell members with un-activated deposits they can still reclaim
them, during a grace tail included. For a sequencer grace tail, `detail.resumesAtSec` is the one
honest ETA this protocol can ever publish, because it is a contract constant.

**One thing it still does not watch**, filed as a gap rather than silently absent: a USDC depeg,
which by design freezes nothing at all because the pin is never stale.

The feed's *identity* — `decimals()` / `description()` / `aggregator()` moving behind the proxy —
**is** watched, but by a different signal, because it is a different question. This one asks whether
the price is FRESH; identity asks whether it is RIGHT, and a mis-scaled feed is not stale, not
frozen and not out of band. See **(g) `feed-identity`** below.

#### The retired oracle (`OracleAggregator`)

Kept so a pre-pivot deployment is still monitored, and unchanged. Per basket asset:
`margin = freshSources - quorum`, where a source is fresh iff `latestPrice()` returns `priceWad > 0`
and `updatedAt >= chainNow - maxStaleness`, and a *reverting* source is simply not fresh. ALERT when
`margin <= 0` (`ORACLE_MIN_MARGIN`): `margin < 0` means the breaker is already tripped, `margin == 0`
means any single further failure freezes the vault. The bar is `<= 0` because a vault on the
protocol floor (3 sources, quorum 2) sits at margin 1 when perfectly healthy, and paging on that
would page forever.

In both implementations the clock is **chain time**, never the monitoring host's.

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

### (g) `feed-identity` — is it still the same feed, and still scaled the way the oracle assumed?

**What it measures.** Per basket asset, every sweep: the live `decimals()` and `description()` of the
Chainlink proxy behind that asset, and which aggregator is currently behind it (`aggregator()`,
`phaseId()`).

**The gap it closes.** `ChainlinkOracle`'s constructor proves three things about every feed it lists
— that the feed describes itself as USD-quoted (`_requireUsdQuote`), that it reports 8 decimals, and
that `scale = 10**(18 - decimals)` is therefore correct — and then caches the result in an immutable
`feedOf` entry and never looks again. Chainlink meanwhile swaps the aggregator behind an
`EACAggregatorProxy` as routine operation, and the proxy forwards `decimals()` and `description()` to
whichever aggregator is current. So the contract's construction-time proofs can silently stop being
true on a contract that cannot re-check them. This signal re-checks them.

**Nothing else in the canary can see this.** A mis-scaled feed is not stale, not frozen and not out
of band, so signal (a) reads OK — the price is served, it is just wrong. And `nav-backing` recomputes
NAV through the same `oracle.priceWad(asset)` the vault uses, so a uniform mis-scale cancels exactly
on both sides of its comparison and that signal stays silent through the whole event.

**Ground truth, and why there is no configuration here.** The comparison that matters for decimals is
**live-vs-cached, not live-vs-config** — and the cached value is observable on-chain: `feedOf(asset)`
is a public mapping getter and `scale` *is* `10**(18 - decimals)` as cached at construction. So the
check is

```
10n ** (18n - BigInt(feed.decimals())) === feedOf(asset).scale
```

with **both sides read from the chain**. No pin, no env var, no config file, nothing that can go
stale, and correct on the very first sweep after a cold start — which matters, because a swap that
happened while the canary was down must still be caught when it comes back. The denomination leg is
the same shape: it re-runs the constructor's own `_requireUsdQuote` predicate (ends in `USD` as a
whole word, separator and all) against the description the proxy reports now.

Only the **identity** leg needs a remembered value, and it is the leg that carries no harm on its
own. It is pinned on first sight into `CANARY_STATE_PATH`. Rejected alternatives:

| Where the pin could come from | Rejected because |
|---|---|
| `contracts/config/*.json`'s `aggregatorPin` | `.dockerignore` excludes `contracts/` from the runtime image, so the canary cannot read it — the same finding that shaped `ORACLE_FEED_CADENCE_SECONDS` |
| a new env var, told like the cadence map | It must be hand-edited after every routine Chainlink swap or the signal alerts forever. A standing alert that needs a config deploy to silence is the strongest possible muting pressure, and it buys nothing the harm legs do not already cover pin-free |
| first sight, in the canary's own state | **Chosen.** No config surface, no maintenance. Residual, stated in the signal's own message: a swap during canary downtime is adopted silently and never narrated — `scripts/verify-chainlink-oracle.mjs` compares against the config's git-tracked `aggregatorPin`, which is the half that survives a restart |

**Severity, and why the two findings are not calibrated the same.** A Chainlink aggregator swap is
routine and legitimate — `phaseId` exists to count them. A `decimals()` change is not routine and is
the one that silently mis-scales every price. So:

| Finding | Status | Behaviour |
|---|---|---|
| decimals no longer match the cached `scale` (including a value > 18, which no `scale` can express) | **ALERT** | **Latches.** The oracle's config is immutable, so there is no operator action that repairs it — the vault stays not-OK until it is evacuated or the oracle replaced |
| the description no longer ends in `USD` as a whole word | **ALERT** | **Latches**, same reason |
| the aggregator behind the proxy changed, decimals and denomination still check out | **ALERT** | **Clears itself next sweep**, because the runner re-pins. A notification ("go read Chainlink's announcement"), not a standing incident |

The self-clear is the calibration, not a softening. Latching a benign swap would park a permanent
not-OK row in the heartbeat summary and in `ops-check` with no action that clears it — which is the
muting pressure `ORACLE_MIN_MARGIN` and `ORACLE_STALENESS_WARN_PCT` were both calibrated against. And
alerting at all is safe here for a reason the flat staleness bar could not claim: an aggregator is
swapped on the order of **once or twice a year**, not dozens of times a day.

Critically the self-clear is **gated on the harm legs**: the swap alert only clears because decimals
and denomination passed against the *new* aggregator on the same sweep. A swap that also moves
decimals leaves the harm leg alerting and the vault not-OK. Two adjacent tests in
`test/feed-identity.test.mjs` pin that conjunction.

**Conviction rules for the identity leg** mirror `scripts/verify-chainlink-oracle.mjs` rather than
inventing a second argument: `phaseId` increments on every swap so it convicts on its own; a changed
`aggregator()` convicts only when both sides are readable, because an `aggregator()` read coming back
empty is network noise, not evidence (observed against a live proxy on 2026-08-30).

**When it fires.** There is no on-chain remedy — `feedOf` is immutable. For a decimals or
denomination finding, treat every price served since the change as wrong (`detail` carries the
cached scale, the live decimals and the factor the price is off by) and follow the de-listing /
evacuation path, not the freeze path: the vault is not frozen, it is *transacting at a wrong price*,
which is worse. For a swap notice, verify it against Chainlink's announcement — that is the moment a
deprecation is still recoverable, because on-chain a deprecation looks like ordinary staleness only
*after* the response window has closed.

**Silent on a retired-oracle deployment**, and deliberately so: `OracleAggregator` has no Chainlink
proxy anywhere, so feed identity is not a capability that exists to be blind about there.

### (h) `operator-power` — is the operator about to lose the right to propose, or to exit?

**What it measures.** Per vault, every sweep: `sharesOf(creator) * 10000 / totalShares` — the
operator's own proportional stake — against **two independent gates**, both read from the chain:

1. Governance's `configOf(vault).proposalThresholdBps` (default 500 bps at launch, but configurable
   per vault, and can even be 0 — see M-6 below), which gates the operator's own next `propose()`
   call.
2. VaultCore's `CREATOR_MIN_STAKE_BPS` (a protocol **constant**, 500 bps everywhere), which gates the
   operator's own voluntary **exit** while non-creator members remain (`_checkCreatorGate`). Only
   live once `nonCreatorMemberCount > 0`.

**The gap it closes (G1).** Nothing on-chain computes this ratio against either threshold. Ordinary
member deposits dilute the vault, and the operator's stake falls passively — with no action on
anyone's part — until the operator's next `propose()` reverts `BelowProposalThreshold`, potentially
weeks or months after the crossing, or their own exit reverts `CreatorStakeGate`. This signal exists
to surface the *approach*, not just the crossing.

**This is dilution by design, not a bug.** `Governance._validateConfig` enforces **no floor** on
`proposalThresholdBps` (M-6) — a floor was implemented and then deliberately reverted; see
`contracts/test/audit/AuditProposalThresholdFloor.t.sol`. The operator's stake is real capital at
risk: staying above either gate requires the operator to deposit alongside members, exactly like
anyone else. This signal never claims the operator's capital is free, safe, or guaranteed anything —
it reports a share of voting stake against a configured threshold, nothing else.

**Bars.** WARN at operator power **<= 1.5x** the binding threshold, ALERT at **<= 1.1x**. Both map to
this package's `alert()` status (there is no fourth status) and are distinguished by `detail.level`
and the message wording — the same shape as signal (a)'s pre-trip early-warning bar living under the
freeze ALERT. The **worse** of the two gates decides the vault's status; both are always reported in
`detail.thresholds`, and `detail.thresholdsDiffer` says whether they disagree on this vault.

**Headroom.** `detail.thresholds[].depositHeadroomUsdc` estimates how much further **non-operator**
deposit (native USDC units) would dilute the operator down to exactly that gate's `bps`, holding the
operator's own shares and the current NAV-per-share fixed — solved from `VaultCore._mintShares`'s own
formula. It is informational, not a quote: a real deposit moves NAV-per-share as it lands, so a large
single deposit crosses sooner than a naive read of this number suggests. `0` means the vault is
already at or past that gate.

**The capacity trap.** If the vault is at `capacityCapUsdc`, the operator has no top-up path either —
depositing more to rebuild the margin is impossible, because the vault cannot accept the deposit at
all. An ALERT at capacity says so literally: **"no top-up path — decision needed now"**.

**Degrades gracefully, on two axes.** A tripped oracle breaker (`navWad` reverting `StaleOracle`)
never blinds the WARN/ALERT verdict — dilution is plain share accounting, unrelated to price, and is
exactly as visible during a freeze as any other time. It only means the headroom estimate cannot be
computed this sweep (`detail.navAvailable: false`, said in the message). Separately, an unregistered
vault, a zero/unreadable `governance()`, or a `proposalThresholdBps` of 0 all drop the Governance leg
alone — the VaultCore exit-gate leg still applies on its own — and if **neither** gate is live the
signal reports `skipped` ("no binding threshold is active"), not a false OK.

**When it fires.** There is no on-chain remedy that repairs the ratio directly: the operator either
deposits more (if capacity allows) or accepts the consequence — losing the ability to `propose()`, or
to voluntarily exit below the gate while members remain. Neither is a freeze; the vault keeps
operating normally for everyone else.

### (i) `depeg-reference` — a USDC/USD reference read, purely informational

**What it measures.** A Chainlink USDC/USD Data Feed on Base, read every sweep, independent of any
vault's own oracle. ALERTs outside **0.995 .. 1.005** (inclusive at both bounds).

**The gap it closes (G4).** Both oracle flavors **pin** USDC at $1.00 rather than measuring it —
deposits, exits and NAV all price USDC at par unconditionally. A sustained depeg produces no freeze
and no staleness anywhere else in this package: `nav-backing` recomputes NAV through the same pin, so
a depeg cancels on both sides of that comparison exactly the way a mis-scaled feed does in signal (g).
The event is externally loud, but nothing of ours measured it or triggered the de-list decision this
protocol depends on a human making — until now.

**Purely informational, always.** Every message — ALERT or OK — says explicitly that the contract
keeps pricing USDC at exactly $1.00 regardless of this reading, by design, and will keep doing so
until a human relists or unwinds the vault. There is no freeze, no staleness attribution, and no
on-chain consequence tied to this signal at all; it exists solely to feed the human de-list decision.

**The feed address, and why there is no guessed testnet default.** The mainnet feed
(`0x7e860098F58bBFC8648a4311b374B1D669a2bc6B`) is `contracts/config/base-mainnet.json`'s
`usdcReferenceFeeds.chainlinkUsdcUsd`, verified on-chain 2026-08-24 — the same file calls it "the
off-chain monitoring inputs for that residual (a canary signal, not an on-chain input)", which is
what this file is. `USDC_USD_FEED_ADDRESS` defaults to that address **only** when `CHAIN_ID` is 8453;
no equivalent is documented anywhere for Base Sepolia, so none is invented — the signal reports
`skipped` (a configuration fact, not a blind detector) on any other chain until one is supplied.

**When it fires.** Nothing on-chain needs fixing — the contract will not react. Treat it as the
trigger to start the human de-list/unwind decision this protocol's design depends on: verify the
reading against an independent source, and act off-chain.

---

## 4. Signals that cannot run

A DEGRADED line is not a false alarm to be tuned away — it means a check is **not covering** the
vault. The cases:

| Line | Cause | Fix |
|---|---|---|
| `exit-liveness sentinel CANNOT RUN … no member holding shares` | the projection lists no holder to probe with | wait for the first deposit, or check the indexer is caught up |
| `… not in the indexer projection` | the vault is in `VAULTS` but not in the snapshot | point `STATE_PATH` at a caught-up indexer, or set `START_BLOCK` to the factory deploy block so the vault is discovered |
| `… reverts StaleOracle` (NAV, exit liveness) | the oracle breaker is tripped | signal (a) is paging for the real cause; coverage resumes when the breaker clears |
| `sequencer gate not configured … sequencerUptimeFeed is address(0)` | the oracle has no uptime feed | correct off a sequencer L2 (Base Sepolia leaves it `address(0)` by design, so expect exactly one line per vault on testnet). **On Base mainnet it means the deployment shipped with no sequencer guard at all** |
| `no vaults to watch` | empty watch set | set `VAULTS`, or point `STATE_PATH` at a snapshot that has seen a `VaultCreated` |
| `feed identity cannot be checked … feedOf() lists no feed for it` | the asset is unlisted, or it is the oracle's pinned USDC leg | if unlisted, signal (a) is already paging (`priceWad` reverts permanently); if it is the pin, there is no aggregator behind it and nothing to drift |
| `operator power measured but no binding threshold is active` | the vault is unregistered with Governance (or `proposalThresholdBps` is 0) **and** no non-creator member has joined yet | not a fault — neither gate can bind yet; coverage begins the moment either condition changes |
| `operator power cannot be measured … totalShares is 0` | no deposit has activated yet | wait for the first deposit |
| `USDC depeg reference not configured for vault … no known Chainlink USDC/USD feed is documented for this chain` | `USDC_USD_FEED_ADDRESS` is unset and `CHAIN_ID` is not 8453 | set `USDC_USD_FEED_ADDRESS` if this chain has a real USDC/USD feed; the vault's own pricing is unaffected either way |

An empty watch set is reported loudly rather than read as a clean bill of health.

**DETECTOR BROKEN lines are a different class** — the monitor is blind, not the vault. They
re-assert on a backoff until fixed:

| Line | Cause | Fix |
|---|---|---|
| `ORACLE DETECTOR BLIND … answers neither ChainlinkOracle.sequencerUptimeFeed() nor OracleAggregator.assetConfig()` | the vault's oracle is a flavor this canary does not know | the canary needs a new oracle implementation before this vault is monitored at all — do not treat the vault as healthy |
| `vault … is unreadable` | wrong address, wrong chain, or the RPC is failing | check `RPC_URL`/`CHAIN_ID` and the address. **Every** signal for that vault is suspended |
| `… check ERRORED on vault … and measured nothing` | the signal threw (usually an RPC fault) | read the error in `detail`; the vault is unmonitored for that signal until it clears |
| `FEED IDENTITY DETECTOR BLIND … did not answer description() / decimals()` | the proxy stopped answering the two reads the harm checks compare against | the asset is unmonitored for aggregator-swap drift. A feed that has stopped answering the calls `ChainlinkOracle`'s own constructor made has itself changed shape — check it against Chainlink's feed registry |
| `FEED IDENTITY DETECTOR BLIND … answered neither aggregator() nor phaseId()` | the feed is not an `EACAggregatorProxy`, or both reads are failing | the harm checks (decimals, denomination) **did** run and passed; it is the swap *notice* that is blind |
| `OPERATOR POWER DETECTOR BLIND … totalShares/sharesOf/nonCreatorMemberCount/CREATOR_MIN_STAKE_BPS unreadable` | plain vault accounting state is unreadable | check `RPC_URL`/the vault address; operator dilution (G1) is unmonitored for this vault until it clears. Unrelated to the oracle — this never fires just because the price breaker is tripped |
| `USDC DEPEG REFERENCE BLIND … did not answer latestRoundData() / decimals()` | the reference feed is unreachable, wrong, or has no code on this chain | check `USDC_USD_FEED_ADDRESS` against the chain it is pointed at; the vault's own oracle still pins USDC at $1.00 unconditionally and is unaffected |

**These damp against RPC noise, and most of the others do not.** Every blind branch in
`feed-identity` and in `depeg-reference` is triggered by an `eth_call` coming back empty, and one
empty return is noise while three consecutive is the feed — so they carry `minConsecutive: 3` and
only escalate on the third sweep. The exception is the very first sighting, which reports
immediately: a monitor that has never once succeeded must not be indistinguishable from silence.
`oracle-freshness` and `operator-power` need no such damping, because their blind branches are
structural (an oracle answering an ABI it does not have; plain vault state that flatly reverts), not
a transient read.

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

- **Silence is the healthy state**, which makes "is it alive?" a fair question. `HEARTBEAT_MS`
  defaults to `3600000` (one hour) precisely so this question always has an answer — without it, a
  dead canary and a healthy protocol are the same observation (nothing). Set `HEARTBEAT_MS=0` to opt
  back out. The heartbeat line is a "still watching" summary of vault count, signals tracked, and
  how many are not OK; it always goes to stdout via the console sink, never to a webhook, and is
  unrelated to the dead-man's switch below (which is off-host and pings something you do not
  control the uptime of).
- **Restarts do not re-page.** Transition state persists to `CANARY_STATE_PATH` (atomic
  write-temp-then-rename, same discipline as the indexer snapshot). Delete that file to force a fresh
  report of everything currently wrong. That file also holds the aggregator identities `feed-identity`
  pinned on first sight, so deleting it re-pins from whatever is live and a swap that happened while
  the canary was down is never narrated. The decimals and denomination checks in that signal need no
  pin and are unaffected. `node packages/canary/src/canary-runner.mjs verify` prints the pin count.
- **A paging outage is not a monitoring outage.** A webhook that throws, times out, or returns 500 is
  logged and stepped over; the sweep continues. §5.3 below is what stops that fact from being
  discovered for the first time during a real incident.
- **One broken vault does not blind the others.** A signal that errors becomes a DEGRADED result for
  that vault and the sweep carries on.

### 5.3 Sinks, severity tiers, and the dead-man's switch

Closes the Monitoring Gap Analysis' G6: "no paging tiers, no off-host dead-man's switch. Undetected:
a dead host, overnight (~8h)." `sinks.mjs` used to be console + one generic webhook — every
transition, same channel, no severity — and `ops-check` (`packages/oplog`), the thing that notices a
dead canary, runs **on the same host as the canary**, so host death silenced both the watcher and the
watcher's watcher. This section is the fix in three parts.

**Tiered webhooks.** `PAGE_WEBHOOK_URL` receives only ALERT transitions on the signals Operations'
Severity Ladder rates SEV-1/2 and worth waking a human for: `nav-backing`, `share-conservation`,
`fee-routing`, `exit-liveness`, `oracle-freshness` (this is the "oracle-v2"/"oracle-health" the
Monitoring Gap Analysis' §3 item 4 refers to — `signals/oracle-health.mjs`'s `SIGNAL` constant is
still `'oracle-freshness'`, unchanged across the post-pivot rename). `LOG_WEBHOOK_URL` receives every
other transition: recoveries, every DEGRADED / DETECTOR BROKEN line, and `feed-identity` — that
signal can ALERT (§3(g)) but is deliberately not in the PAGE list: a benign aggregator-swap ALERT
there self-clears the next sweep by design, and escalating that list further is Operations' call, not
inferred here. `ALERT_WEBHOOK_URL` remains the backwards-compatible fallback used for whichever of
the two is unset — set only that one and every transition reaches the one configured URL exactly
once per transition, same as before tiering existed. The webhook body also carries a `tier: 'page'|
'log'` field, so a receiver on a single shared URL can still route without re-deriving the map.

**Off-host dead-man's switch.** `DEADMAN_PING_URL` is pinged (plain `GET`) once per **successful**
sweep — the same condition that gates the `ops-check` heartbeat file, so a canary that cannot reach
the RPC neither claims to be watching nor pings as if it were. Point it at an external
heartbeat-monitoring check — e.g. a Healthchecks.io-style URL (`https://hc-ping.com/<uuid>`) — so a
dead host is noticed by something that is not itself on that host. Off by default when unset; a
failed ping is logged, never fatal — the ping's whole purpose is to be noticed from outside this
process, so a delivery failure here must not be the thing that crashes the last line of defence.
**Provisioning the external account is a human task**, not something this package can do (no key, no
signup flow, by design); this is only the code path that pings whatever URL you give it.

**Alert self-test.** security-ops.md §5.3: "a webhook that 500s is logged and skipped, by design.
Something must test the alert path end-to-end on a schedule, or the first real page is also the
first test." `CANARY_TEST_ALERT_ON_START=1` fires one synthetic PAGE-tier and one synthetic LOG-tier
transition through the exact sinks a real sweep uses, right after startup and before the sweep loop
begins. On demand, without starting anything: `node packages/canary/src/canary-runner.mjs test-alert`
(mirrors the existing `verify` subcommand — same env, no sweep). Both paths bypass the transition
tracker entirely, so a self-test can never plant fake state in `CANARY_STATE_PATH` that would
suppress a real future transition on a colliding id.
- **Cold start sees no history.** With the default `LOG_LOOKBACK_BLOCKS=0`, the first sweep scans a
  single block, so `ModuleCallFailed`, `SliceEscrowed`, and fee outflows from *before* the canary
  started are never reported. That is deliberate — starting a monitor should not replay a backlog as
  fresh pages — but if you are standing the canary up after a vault has been live for a while, set
  `LOG_LOOKBACK_BLOCKS` to cover the gap for the first run. The level signals (a–d) read current
  state and are complete from the first sweep regardless.
- **Sizing.** A sweep is `O(vaults × basket assets)` reads against a `ChainlinkOracle` (roughly eight
  per asset — `feedOf`, `priceWad`, `latestRoundData` for signal (a), then a second `feedOf` plus
  `description`, `decimals`, `aggregator`, `phaseId` for signal (g), which are issued in one batch —
  plus four fixed per vault). The two oracle signals deliberately do **not** share their `feedOf`
  read: each is a pure function of the reader, which is what lets every one of them be tested against
  a plain mock, and one duplicate `eth_call` per asset is a cheaper price than coupling them. Against
  the retired aggregator a sweep is
  `O(vaults × basket assets × oracle sources)`, and signal (g) does not run at all. Signal (h) adds
  roughly five fixed reads per vault (plus two more against Governance when it applies) and signal
  (i) adds two reads **against the SAME reference feed address for every vault**, deliberately not
  shared across vaults for the same testability-over-one-fewer-`eth_call` reason signal (g) does not
  share `feedOf` with signal (a). The default 30s cadence is comfortable for a handful of vaults on a
  normal RPC; raise `CANARY_POLL_INTERVAL_MS` before raising your rate limit.

## 6. Tests

`npm run test:backend` includes `packages/canary/test/*.test.mjs` — 247 tests, every one with a
mocked client. **No live RPC in CI.** Both a healthy and an alerting fixture exist for every signal,
and for both oracle flavors.

Five guards worth knowing about:

- `test/abis.test.mjs` recomputes every embedded 4-byte selector with viem and cross-checks the
  watched events, the views, and the gate errors against the **compiled** `VaultCore` ABI. A stale
  gate selector would file a live fault as a benign gate and silence the H-1 sentinel, so this is not
  optional bookkeeping. It skips gracefully when `contracts/out` or viem is absent.
- The same file now cross-checks every `ChainlinkOracle` view — name, `view`-ness and return shape —
  against the **compiled** `ChainlinkOracle` ABI, and asserts that `assetConfig`/`sourcesFor` are
  *not* on it (the flavor probe depends on that absence). **This guard is the direct answer to how
  the pivot broke this signal:** the oracle table was previously checked only against itself, so
  nothing in CI could see that the signal was calling functions the deployed contract does not have.
- The same file cross-checks `feed-identity`'s two **harm** legs (`decimals()`, `description()`)
  against the compiled `IAggregatorV3` / `IAggregatorV3Description` — the interfaces
  `ChainlinkOracle`'s own constructor reads them through. `aggregator()` and `phaseId()` belong to
  Chainlink's `EACAggregatorProxy`, which is not in this tree, so they are **not** pinned that way and
  the test says so rather than pretending; their runtime failure is covered instead, by a
  DETECTOR BROKEN result.
- `test/reader.test.mjs` asserts the chain reader exposes no send/sign/write surface, and
  `test/abis.test.mjs` asserts the ABI table declares no non-`view` function. The read-only claim is
  enforced, not just documented.
- The same file also cross-checks `GOVERNANCE_VIEWS.configOf`'s output shape — field ORDER included —
  against the **compiled** `Governance` ABI, since `operator-power.mjs` reads `proposalThresholdBps`
  out of that tuple by position, not by name.
