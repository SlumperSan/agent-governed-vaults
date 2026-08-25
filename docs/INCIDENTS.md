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

---

## 1. Oracle staleness / the K-4 capital freeze

The big one. On a stale oracle (quorum lost for `maxStalenessSeconds`), **every NAV path freezes
— deposits activate, exits settle, rebalances execute: none of them, until freshness returns.**
This is SF-2 working as designed, not a bug: a frozen vault cannot be drained at a wrong price.

- **Detect:** canary `oracle-freshness` → ALERT (margin < 0); confirm on-chain:
  `cast call <aggregator> 'priceWad(address)(uint256)' <asset>` reverting is the breaker's own
  verdict. Check every source's `updatedAt` to identify which class died.
- **Act:** (1) confirm which mechanism class is stale — push feed halted, pull feed unfunded
  keeper, TWAP pool gone quiet — they have different owners and different clocks;
  (2) for a Pyth leg: **push a price update yourself** — it is permissionless and costs gas, and
  restores that leg immediately; (3) for a quiet TWAP pool or halted Chainlink feed: nothing
  on-chain can be done by us — communicate and wait.
- **Comms template:** "Vault pricing for <asset> is frozen because <n> of 3 oracle sources went
  stale at <time> (verify: <cast command>). Funds are not lost and cannot be mispriced — the
  freeze exists to guarantee that. Pending (unactivated) deposits can be reclaimed at any time
  with `cancelPending()`. Exits resume automatically when freshness returns; no action from us
  is possible or needed on-chain."
- **Cannot do:** unfreeze, override the price, extend or shorten the staleness bound. The bound
  is immutable per deployment.

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

- **The contract's own defenses are the response:** proposals bind exact payloads
  (voters approve *those bytes*), adapters are allow-listed at creation, the commit-reveal
  scheme prevents last-block vote sniping, Mode-F pricing removes the exit-front-running edge,
  and the creator stake gate keeps the creator exposed. A hostile *passed* rebalance still
  executes only through allow-listed adapters against the vault's own basket.
- **Act:** publish the proposal analysis **during the reveal window** (it is at least an hour —
  the floors are immutable), so members can reveal AGAINST or queue Mode-F exits with full
  information. That window existing is the design's answer to capture; use it.
- **Cannot do:** veto, delay, or cancel any proposal. Nobody can — that is the point.
