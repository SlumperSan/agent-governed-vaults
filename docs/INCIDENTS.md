# Incident playbook

**Read the first section before any incident. It is the only section that matters under
pressure.**

## 0. What cannot be done — the honest line, first

This protocol is **immutable**: no proxies, no admin keys, no pause switch, no upgrade path, no
parameter that anyone can change after deployment. That was a deliberate trade (THREAT-MODEL,
accepted risks): members never have to trust an operator's key hygiene, because there is no key
whose compromise can move their funds — and the price is that **no incident below has a "fix the
contract" step.** There is nothing to pause, nobody to call who can freeze an attacker, and no
hotfix to ship.

Every incident response therefore reduces to some combination of exactly four levers:

1. **Communication** — telling members what is true, fast, with evidence (tx hashes, `cast`
   commands they can run themselves — the member-facing set is
   [MEMBER-VERIFY.md](MEMBER-VERIFY.md), so link it rather than re-typing a command under
   pressure).
2. **Member self-service** — the exits the contracts already guarantee: `requestExit` (Mode I/F),
   `cancelPending` for unactivated deposits (works even during an oracle freeze — executed live
   in SOAK-REPORT §4), `settleQueuedExit` (callable by anyone). The copy-paste recipes for all
   three, with the freeze reads beside them, are [MEMBER-VERIFY.md](MEMBER-VERIFY.md) §5.
3. **Off-chain remediation** — restarting or re-keying the facilitator, indexer, API, canary;
   these are stateless or restore-from-backup services and hold no member funds.
4. **Stopping the bleeding at the edges** — de-listing a vault from the API/web surface,
   refusing new paid reads, publishing "do not deposit" guidance. The chain does not care, but
   most depositors arrive through the front door.

If a step below is not one of those four, it does not exist. Do not improvise a fifth under
pressure.

**Comms rule for every incident:** first message within 30 minutes of confirmation, even if it
only says what is being investigated. Every claim carries a tx hash or a `cast` command the
reader can run. Never state a recovery time you cannot evidence.

> **Pre-remediation caveat — this playbook describes the intended posture, and the tree does not
> yet fully meet it.** A remediation pass on 2026-08-27 closed twelve findings, including
> **C-3 (#31) and C-5 (#34)**, and removed C-4 (#32)'s trigger. **C-1
> ([#33](https://github.com/SlumperSan/agent-governed-vaults/issues/33)) is still open**, as are
> four Highs, and no external audit has happened — so the protocol remains **NO-GO for mainnet**
> ([LAUNCH-READINESS.md](LAUNCH-READINESS.md) gates 0 and 1).
>
> §8 still carries its own warning: its defences are now materially stronger, but not complete.
> Read it before relying on any "the contract's own defences are the response" line here.

---

## 1. Oracle staleness / the K-4 capital freeze

The big one. When the oracle cannot produce a trustworthy price for an asset, **every NAV path
freezes — deposits activate, exits settle, rebalances execute: none of them, until the price is
good again.** This is SF-2 working as designed, not a bug: a frozen vault cannot be drained at a
wrong price.

> **Post-C-6 pivot — there is no quorum any more.** The launch oracle is `ChainlinkOracle`: **one
> genuine Chainlink Data Feed per asset**, no median, no source set. A freeze now has exactly four
> causes, and none of them is "n of 3 sources went stale". Earlier revisions of this runbook told
> you to push a Pyth update or check a TWAP pool; those legs do not exist on a launch vault.

- **Detect:** confirm on-chain — `cast call <oracle> 'priceWad(address)(uint256)' <asset>`
  reverting `StaleOracle(asset)` is the breaker's own verdict. Then identify **which** of the four
  causes it is:
  1. **Sequencer** — read the Base L2 sequencer uptime feed
     (`cast call <oracle> 'sequencerUptimeFeed()(address)'`, then `latestRoundData` on it). Answer
     `1` means down; answer `0` with `block.timestamp - startedAt < 3600` means it is up but inside
     the one-hour grace period. **Grace is anchored on `startedAt`, not `updatedAt`** — do not
     recompute it against `updatedAt`, which can sit months past `startedAt` on a long-lived round.
  2. **Heartbeat** — `latestRoundData().updatedAt` on the asset's feed is older than the
     configured heartbeat (`cast call <oracle> 'feedOf(address)' <asset>`).
  3. **Sane-price band** — the answer is outside `minPriceWad`/`maxPriceWad` for that asset. This
     is the deliberate defence against a feed reporting a deprecated min/maxAnswer clamp during a
     depeg or flash crash.
  4. **Feed dead or unlisted** — the feed reverts, answers non-positive, or the asset was never
     listed on this oracle.
- **Act:** for (1) sequencer — wait; the grace period is protocol-imposed and correct. For (2),
  (3) and (4) — **nothing on-chain can be done by us.** There is no second source to fail over to,
  the oracle's config is immutable, and a vault's oracle is immutable too, so there is no rotation
  lever. Communicate and wait for Chainlink. If a feed is permanently deprecated, that asset's
  vaults stay frozen: this is gate 5's named residual, and it is a known, accepted consequence of
  the single-provider design.
- **Comms template:** "Vault pricing for \<asset\> is frozen because its Chainlink price feed
  \<went stale past its heartbeat / reported a price outside the configured sane band / the Base
  sequencer is recovering\> at \<time\> (verify: \<cast command\>). Funds are not lost and cannot
  be mispriced — the freeze exists to guarantee that. Pending (unactivated) deposits can be
  reclaimed at any time with `cancelPending()`. Exits resume automatically once the feed is healthy;
  no action from us is possible or needed on-chain." The "verify" slot is
  [MEMBER-VERIFY.md](MEMBER-VERIFY.md) §3 — it shows what the revert looks like, and §5-B is the
  `cancelPending` recipe.
- **Cannot do:** unfreeze, override the price, retune the heartbeat or band, or repoint the feed.
  All of it is immutable per deployment.
- **Canary:** the `oracle-freshness` signal measures this oracle directly — it calls
  `priceWad(asset)` and treats the revert as the incident, then attributes it to the sequencer,
  the heartbeat, the band, an unlisted asset or a dead feed. A sequencer grace tail carries
  `detail.resumesAtSec`, the exact second pricing resumes. A freeze it cannot attribute is still
  paged, with the gap named. See [CANARY.md](CANARY.md) §3(a).

## 1a. Aggregator-swap drift — a silent MISPRICING, with no freeze to warn you

The opposite failure to §1, and the more dangerous one, because nothing reverts. Chainlink swaps
the aggregator behind a configured `EACAggregatorProxy` as routine operation and the new aggregator
reports a different `decimals()`. `ChainlinkOracle` read decimals **once**, in its constructor, and
cached `scale = 10**(18 - decimals)`. Every price for that asset is then wrong by a power of ten,
permanently, and every NAV path keeps answering. Accepted as residual register **row 14** in
[LAUNCH-READINESS.md](LAUNCH-READINESS.md) §4 — read that row before acting, especially its
"what would invalidate this row".

- **Detect:** the canary's `feed-identity` signal (`docs/CANARY.md` §3(g), shipped in #103) is the
  first thing that fires: every sweep it compares the feed's live `decimals()` against the cached
  `scale` in `feedOf(asset)`, so a drifted swap is a latching ALERT before any price is wrong.
  **This incident pages** (since #121): `feed-identity` routes on a predicate rather than on its
  name — `CONDITIONAL_PAGE` in `packages/canary/src/sinks.mjs` pages when `detail.harm` is
  `'decimals'` or `'denomination'`, and logs when it is `null`. A decimals mismatch is exactly the
  `'decimals'` case, so it reaches `PAGE_WEBHOOK_URL`. **A `DRIFT` notice alone does not page** —
  a bare aggregator swap carries `harm === null` and goes to `LOG_WEBHOOK_URL`, which is the
  intended asymmetry, not a gap. (If only `ALERT_WEBHOOK_URL` is set, both land on that one URL.)
  See `docs/CANARY.md` §4. The weekly
  `node scripts/verify-chainlink-oracle.mjs --strict` reporting **FAIL** on `decimals() == 8` is
  the second, git-tracked line. Nothing on-chain detects this. Do not expect
  the other signals to help: `oracle-freshness` asks whether the price is FRESH, not whether it is
  RIGHT (`docs/CANARY.md` §3(a) says so and points at §3(g)), and `nav-backing` recomputes NAV
  through the same `priceWad`, so a uniform mis-scale cancels exactly and that signal stays silent.
  **A `DRIFT` notice with a passing decimals check is the benign case**: the aggregator moved and
  re-checked clean. Update the `aggregatorPin` in the chain config and move on.
- **Confirm before acting**, because a FAIL is also what a broken RPC looks like. Re-run against a
  second provider, then read the feed directly:
  `cast call <feed> "decimals()(uint8)"` and `cast call <feed> "aggregator()(address)"`.
- **Act:** there is **no on-chain lever.** The oracle's config is immutable, `VaultCore.oracle` is
  immutable, `Governance` has no oracle surface, and the factory allowlist gates creation only
  (row 12). Tell members to exit, and say plainly that the vault is still *quoting* prices — this
  is the incident where "the canary is quiet" and "the protocol is fine" come apart.
- **Exits under drift:** on a vault with **no sub-vaults** — the launch shape, since `Deploy.s.sol`
  sets `allowSubVaults = false` — a member still exits whole. `_settleExit` sizes the in-kind slice
  pro-rata from `assetBalance` and only *values* it through the oracle
  (`test_harmModel_driftDoesNotRobAnExitingMember`). **With children present this is unproven**:
  `childValTotalWad` is oracle-derived and enters the *sizing* of the cash leg. Do not tell a
  member with a sub-vault parent that their exit is unaffected.
- **The dangerous direction is the one that does not freeze.** An under-statement mints excess
  shares to a new depositor (C-4's shape). So the first action is to stop directing new deposits at
  the vault, before any comms go out.
- **Comms template:** "The Chainlink price feed for \<asset\> changed its reported precision at
  \<time\> (verify: \<cast command\>). The vault's pricing for that asset is wrong by a factor of
  \<n\> and cannot be corrected on-chain — the configuration is immutable by design. Deposits to
  this vault should stop immediately. Existing members can exit; the payout is sized from the
  vault's own holdings, not from the price. Pending (unactivated) deposits can be reclaimed at any
  time with `cancelPending()`."
- **Cannot do:** re-scale, repoint the feed, pause, or re-deploy the oracle for an existing vault.

## 2. `nav-backing` divergence (composition or custody)

The canary's NAV recomputation disagrees with the vault's own `navWad`, or token balances
disagree with internal accounting.

- **Detect:** canary `nav-backing` ALERT. **Treat as a potential critical contract bug until
  proven otherwise** — this is the one signal that should never fire.
- **Act:** (1) reproduce by hand from raw chain reads (balances × `priceWad` ÷ units + idle);
  (2) rule out the innocent causes first: an RPC serving stale state (read the same values
  through a second endpoint — the soak found *three distinct* bug classes caused by
  load-balanced RPC lag, SOAK-REPORT §7), a canary bug, an unpriced donation sitting in the
  vault (EE-1: donations are moot for internal accounting); (3) if the divergence is real and
  on-chain: file the issue publicly with the reproduction, advise members that exiting is their
  decision with exact numbers, and de-list the vault from the front door.
- **Cannot do:** correct NAV, freeze the vault, block exits at the wrong price. If the
  accounting is wrong on-chain, it is wrong permanently; the response is transparency speed.

## 3. `share-conservation` violation

Total shares disagree with the sum of members' shares, or shares changed without a
corresponding event.

- Same posture as §2: potential critical bug, never expected, reproduce → rule out
  observation-layer causes → publish. This is an audit-scope invariant (the invariant suites
  fuzz it); a live violation means the audit missed something.

## 4. `exit-liveness` DEGRADED or SKIPPED

The canary's probe cannot demonstrate that an exit would currently succeed.

- **Detect/interpret:** `skipped` with zero members is **normal** (nothing to probe — the soak
  ended two vaults that way, SOAK-REPORT §6). `degraded` with members and a fresh oracle is the
  real case.
- **Act:** static-call the exact exit as the affected member (`cast call <vault>
  'requestExit(uint256)' <shares> --from <member>`) to get the revert reason; the likely causes
  are an oracle freeze (→ §1), a pending execution making exits Mode-F (→ normal, they queue —
  explain it, the K-1 seam is working), or a stuck Passed-but-unexecuted proposal (→ anyone may
  call `markExpired` after the window; the smoke test's stranded-proposal recovery is scripted
  in `scripts/proposal-recovery.mjs`).
- **Cannot do:** force-settle an exit the contract refuses.

## 5. `fee-routing` / `module-events` anomalies

Fees claimed to an unexpected address, or module events that match no known cause.

- **Act:** reconcile against the FeeEngine walkthrough's expected flows; every canary transition
  in the soak reconciled to a specific drill action (SOAK-REPORT §6) — an unattributable event
  is itself the finding. Publish what is known; fee flows touch operator money, not member
  principal (fees are taken from realized gains at claim time).

## 6. Facilitator outage (x402 settlement down)

- **Symptom:** paid reads fail at settlement; API returns 402s that cannot be satisfied.
  **Member funds are not involved** — the facilitator holds only its own gas key.
- **Act:** restart it (stateless; the consent gate and domain self-check run at boot). If the
  key is compromised: it can broadcast *held* authorizations (each names its recipient and
  amount — the fail-closed price re-check refuses anything not matching a posted challenge) and
  drain its own gas; rotate by generating a new keystore, funding it, restarting. Nothing else
  is exposed.
- **Comms:** only needed if the API is a paid product surface; reads are down, funds are fine.

## 7. Indexer stall / API serving stale state

- **Symptom:** ops-check heartbeat stale, or `/vaults` lagging the chain. The chain is the
  source of truth; this is a display-layer incident.
- **Act:** restart from the last snapshot (it re-folds from `lastBlock`); if state is corrupt,
  restore from the backup ring (`verify` subcommand first — and note Sprint 13's heartbeat
  gotcha: the beat ties to poll-cycle completion, so a cold-start catch-up looks unhealthy
  while it works). Keep the canary running throughout — it reads the chain directly and does
  not depend on the indexer.
- **Comms:** banner on the web surface: "displayed balances may lag the chain by N blocks;
  on-chain state is unaffected."

## 8. Compromised operator or governance capture of a vault

An operator key signs bad proposals, or a member accumulates quorum and passes a hostile
rebalance.

> ### ⚠ Read first: SUB-VAULTS ARE DISABLED AT LAUNCH (C-1 remediation, "root vaults only")
>
> **Update 2026-08-28 (Phase 2):** the operational rule at the bottom of this box — "do not create
> sub-vaults, do not allocate parent capital into a child" — is now an **enforced contract
> invariant**, not an operator instruction. `VaultFactory` ships with `allowSubVaults = false`:
> `createChildVault` reverts `SubVaultsDisabled` and every deployed vault is wired root-only, so no
> funded child can exist and the C-1 capture below has no target. C-1 is thereby **closed as a
> class at launch** (together with the sub-vault-only Highs H-5/H-6/H-7/H-9). The rest of this box
> describes the sub-vault risk that applies **only** to a future release that re-enables sub-vaults
> with the parent-casts-child-vote mechanism; on a launch (root-only) deployment it is dormant.
>
> This section was written against the *intended* design. The 2026-08-27 remediation closed two
> of the three holes below. **C-5 is FIXED** — voting weight no longer survives an exit, so
> "the creator stake gate keeps the creator exposed" and the commit-reveal anti-sniping story
> now hold as written. **The unbounded-loss hole is FIXED** — `executeRebalance` bounds every
> leg against the vault's own oracle at 2% (H-4), so an allow-listed adapter can no longer be
> driven to an arbitrary fill. And **L-1 is FIXED** — only the parent's creator may attach a
> child, so an attacker can no longer create the child, own its GovConfig, and set
> `timelockDuration = 0`.
>
> What remains true, and what an operator must not be reassured out of:
>
> - **C-1 ([#33](https://github.com/SlumperSan/agent-governed-vaults/issues/33)) is STILL OPEN —
>   a funded sub-vault has an empty electorate.** The paragraph below assumes an attacker must
>   *accumulate quorum*. In a child whose only capital is its parent's allocation, `_snapshot`
>   excludes the parent (GA-1), leaving `pastHolderCount == 0`. One minimum deposit makes an
>   attacker the sole eligible voter. There is nothing to accumulate. The report's suggested fix
>   was implemented and **found to be wrong** (it breaks legitimate parent+1-member children
>   while barely raising attacker cost — see LAUNCH-READINESS §6), so this is open on a design
>   decision rather than on effort.
> - **The "Act" step below still presupposes an electorate.** Publishing analysis during the
>   reveal window lets members "reveal AGAINST" — in the C-1 case the attacker is the *only*
>   eligible voter, so there is nobody to reach and the window is not a defence.
> - **The parent's escape hatch is NOT reliable.** The natural response — the parent's own
>   governance calls `redeemFromChild` to pull capital out — is broken independently by **H-6**,
>   whose exploit tests still pass: the shortfall loop sizes its request GROSS and the child
>   repays NET, so a residual always survives and `ExitNeedsChildSettlement` reverts. Do not plan
>   an incident response around withdrawing from a captured child.
>
> **Net position for a captured sub-vault: the bleed is now BOUNDED but not stopped, and the
> exit may not work.** H-4 caps each rebalance leg at 2% against the oracle, and one proposal at
> a time with a commit phase of at least an hour bounds the rate — so this is a slow bleed at
> governance cadence rather than an instant drain. That is a large improvement and it is not a
> fix. Levers 1 and 4 in §0 remain the response: communicate with evidence, de-list from the
> front door, and — because the rate is now bounded — there is genuinely time to do both.
>
> **Operational consequence, unchanged and still the cheapest thing in this document:** do not
> create sub-vaults, and do not allocate parent capital into a child, on any live deployment
> until [#33](https://github.com/SlumperSan/agent-governed-vaults/issues/33) and H-6 are closed
> and re-reviewed.
> This is cheap to honour — a single-level launch needs no children — and it removes the entire
> C-1 attack surface without waiting on anything else.
>
> The rest of this section is retained because it describes the posture the protocol should have
> **after** remediation, and it is accurate for a **root** vault with a real electorate.

- **The contract's own defenses are the response:** proposals bind exact payloads
  (voters approve *those bytes*), adapters are allow-listed at creation, the commit-reveal
  scheme prevents last-block vote sniping, Mode-F pricing removes the exit-front-running edge,
  and the creator stake gate keeps the creator exposed. A hostile *passed* rebalance still
  executes only through allow-listed adapters against the vault's own basket.
- **Act:** publish the proposal analysis **during the reveal window** (it is at least an hour —
  the floors are immutable), so members can reveal AGAINST or queue Mode-F exits with full
  information. That window existing is the design's answer to capture; use it.
- **Cannot do:** veto, delay, or cancel any proposal. Nobody can — that is the point.
