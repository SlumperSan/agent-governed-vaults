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
   commands they can run themselves).
2. **Member self-service** — the exits the contracts already guarantee: `requestExit` (Mode I/F),
   `cancelPending` for unactivated deposits (works even during an oracle freeze — executed live
   in SOAK-REPORT §4), `settleQueuedExit` (callable by anyone).
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

The big one. When the oracle cannot price a basket asset, **every NAV path freezes — deposits
activate, exits settle, rebalances execute: none of them, until pricing returns.** This is SF-2
working as designed, not a bug: a frozen vault cannot be drained at a wrong price.

The launch oracle is [`ChainlinkOracle`](../contracts/src/oracle/ChainlinkOracle.sol) (C-6): **one
Chainlink Data Feed per asset**, plus the L2 sequencer uptime gate. There is no quorum to lose and
no source set to re-form — a single feed is inside its heartbeat or it is not.

- **Detect:** canary `oracle-freshness`. The ALERT arrives in one of three shapes, and they have
  different responses: **headroom** (the feed is inside the last 25% of its heartbeat — *not yet
  frozen, act now*), **breaker TRIPPED** (`priceWad` reverts `StaleOracle` — frozen, and the alert
  names the cause), or the **`sequencer` key** (Base itself is down or inside its restart grace).
  Confirm on-chain: `cast call <oracle> 'priceWad(address)(uint256)' <asset>` reverting is the
  breaker's own verdict, and `cast call <feed> 'latestRoundData()(uint80,int256,uint256,uint256,uint80)'`
  gives the feed's `updatedAt` directly.
- **Act,** by the cause the alert names:
  1. **Stale past the heartbeat** — the feed stopped publishing. Nothing on-chain can be done by
     us: the feed is Chainlink's, and the staleness bound is immutable. Communicate and wait.
  2. **Outside the sane-price band** — the feed is fresh but reporting a price the oracle refuses
     (a depeg, or a deprecated min/maxAnswer clamp). Do **not** chase the feed operator; this is the
     defence working. Verify the real market price before telling anyone the feed is broken.
  3. **Sequencer down / inside grace** — nothing to do at any layer. Capital unfreezes on its own
     when the sequencer is back and the grace period (`GRACE_PERIOD`, read from the oracle) elapses;
     the alert says how long that is.
  4. **Non-positive answer, unset round, or a reverting feed** — a broken or deprecated feed. Same
     posture as (1), plus check whether Chainlink has announced a deprecation for that pair: an
     asset whose feed is retired is frozen permanently in existing vaults
     ([LAUNCH-READINESS.md](LAUNCH-READINESS.md) row 12 prices that outcome — there is no rotation
     lever, and one would not have rescued a stuck dollar).
- **Comms template:** "Vault pricing for <asset> is frozen because <cause from the alert> at <time>
  (verify: <cast command>). Funds are not lost and cannot be mispriced — the freeze exists to
  guarantee that. Pending (unactivated) deposits can be reclaimed at any time with `cancelPending()`.
  Exits resume automatically when pricing returns; no action from us is possible or needed on-chain."
- **Cannot do:** unfreeze, override the price, swap the feed, or extend or shorten the staleness
  bound. The oracle's config is immutable per deployment and `VaultCore.oracle` is immutable per
  vault.

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
