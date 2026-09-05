# Consumer UX / IA Spec: Agent-Governed Index Vault Protocol

Product Design (UX/IA) scoping document for the **consumer-facing** front end. This is a
build/design brief, not code. It specs the *real* product that replaces the read-only
[Vault Atlas demo](../../apps/web/index.html).

Companion sources this spec is built against:
[ARCHITECTURE.md](../ARCHITECTURE.md) · [THREAT-MODEL.md](../THREAT-MODEL.md) ·
[`packages/indexer/src/projections.mjs`](../../packages/indexer/src/projections.mjs) ·
[`apps/api/src/x402.mjs`](../../apps/api/src/x402.mjs) ·
[`apps/api/src/server.mjs`](../../apps/api/src/server.mjs) ·
[`apps/web/src/fees.mjs`](../../apps/web/src/fees.mjs).

Mechanics are referenced by their canonical labels (§, C-n, K-n, and threat IDs like K-4, EE-10,
PX-3) so the build team and visual designer can trace every screen back to a contract rule.

---

## 0. The spine: four no-recourse moments

The entire product is organized around **four actions that cannot be undone by support,
governance, retry, or an emergency hatch.** If the UX gets only these four right, it succeeds;
if it gets everything else right and these wrong, users lose money or their voice. Every flow,
state, and disclosure decision below serves this spine.

| # | Moment | What is irreversible | Where in docs |
| --- | --- | --- | --- |
| S-1 | **Oracle breaker trips** | Every NAV-reading path reverts: deposits, activation, exits, execution. No hatch, by design. Capital is frozen until sources are fresh. | K-4, SF-2, §11 |
| S-2 | **Mode-F exit is queued** | Irrevocable; settles later at post-execution NAV; the shares *also* lose voting eligibility at queue time. | §4.4, EE-10 |
| S-3 | **Observation-window skip opt-in** | Permanent, once per agent per vault, cannot be undone. Buys immediate shares, forfeits the 4-hour cancel option forever. | §5, EE-3 |
| S-4 | **Forgotten vote reveal** | Committed-but-unrevealed vote is forfeit (counts as abstain). The single highest-severity *human-specific* failure in the product. | §8, §14.4 |

**Design consequence:** these four get full-screen, high-friction confirmations with explicit
plain-language statements of what becomes irreversible: never a color-only pill, never a
one-line toast. Support-escalation and "emergency withdraw" affordances are **prohibited** on the
frozen state (S-1): they would be lies. The honest message is "nothing moves until the oracle
recovers," plus what the user *can* still do (read positions/history; possibly cancel a pending
deposit: see Open Question OQ-1).

---

## 1. Audience & jobs-to-be-done

Target user: **crypto-literate, not a protocol engineer.** Comfortable with a wallet, USDC,
gas, and the idea of a vault; *not* expected to know what forward pricing, commit-reveal, or a
high-water mark is. The product's core job is to translate agent-governance mechanics into human
decisions without dumbing down the risk.

### Persona A: "Rina," the yield allocator (primary, ~70% of usage)
Holds USDC, wants curated exposure to a crypto index run by a track-recorded operator. Does not
want to run an agent or vote actively.
- **JTBD-A1** Discover vaults and judge which operator to trust (legit vs. scam).
- **JTBD-A2** Understand *before depositing*: fees, capacity, lockups, and the worst case (frozen
  exits).
- **JTBD-A3** Deposit USDC and understand why shares don't appear for 4 hours.
- **JTBD-A4** Monitor position value and exit cleanly when she wants out.
- **Governance posture:** wants to *delegate* or set a standing default and otherwise be left
  alone, but must never silently lose money by ignoring a vote.

### Persona B: "Devin," the active governor (~25%)
Runs meaningful stake, participates in rebalance votes, cares about proposal outcomes.
- **JTBD-B1** See active proposals across their vaults and never miss a reveal deadline (S-4).
- **JTBD-B2** Cast a commit-reveal vote correctly across two steps and two sessions/devices.
- **JTBD-B3** Manage delegation (within the concentration cap, §8) and standing defaults (§8).
- **JTBD-B4** Understand the timelock × forward-pricing interplay (VO-8) when deciding whether to
  exit before a rebalance executes.

### Persona C: "Sam," the operator-follower / due-diligence user (~5%, high influence)
Evaluating operators before committing size; may manage several positions.
- **JTBD-C1** Compare operators on the leaderboard with **loss history included** (no
  cherry-picking, SF-4/SF-5).
- **JTBD-C2** Distinguish canonical-factory *attested* operators from spoofed/unattested ones
  (PX-3).
- **JTBD-C3** Trace an operator's full vault set, including wound-down vaults (SF-5).

> Out of scope for v1 consumer product: **vault creation** and any **operator/agent admin**
> surface. This front end is for capital allocators and human governors, not vault authors.
> (Creation is permissionless but is an operator tool; see OQ-7.)

---

## 2. Information architecture

### 2.1 Sitemap

```
/                         Discovery / vault explorer  (public, free tier)
  ├─ /vaults              Full searchable/filterable registry
  ├─ /vaults/:addr        Vault detail  (tabs: Overview · Fees · Governance · Risk)
  │     └─ /deposit       Deposit flow (modal/route over vault detail)
  │     └─ /exit          Exit flow    (modal/route; gated on holding shares)
  ├─ /operators           Operator leaderboard (all vaults, loss-inclusive)
  │     └─ /operators/:id Operator profile (vault set incl. wound-down)
  ├─ /portfolio           Signed-in wallet view: positions, pending, queued exits, votes
  │     ├─ /portfolio/pending      Observation-window deposits (cancellable)
  │     └─ /portfolio/activity     History: deposits, exits, votes, realizations
  ├─ /governance          Cross-vault proposal inbox (all vaults user holds)
  │     └─ /governance/:proposalId Proposal detail → commit → reveal
  ├─ /governance/settings Delegation + standing defaults
  └─ /learn               Just-in-time explainers (linked contextually, not a manual)
```

### 2.2 Screen inventory (with data-source tagging)

Every field is tagged so the build team knows what exists vs. what must be built. This is
critical: the demo `index.html` **fabricates** NAV, proposal state, exit-fee params, and operator
display names. An IA written against the demo is unbuildable.

Tags: **[P]** = present in `projections.mjs` today · **[C]** = needs a direct chain read ·
**[X]** = needs a **new indexer projection** (does not exist yet) · **[api]** = served by
existing metered route.

| Screen | Data shown | Source status |
| --- | --- | --- |
| Discovery card | vault addr, memberCount, capacityCap, parent/depth, holders | **[P]** via `/vaults/:addr` **[api]** |
| Discovery card | **NAV, NAVps, operator display name, attested badge** | NAV/NAVps **[C]**; name **[X]** (only `operatorId` **[P]**, `0`=unattested); attested = `operatorId>0` **[P]** |
| Vault detail · Overview | basket composition & weights, idle USDC, NAV history | idleUsdc **[P]**; **basket composition [C]**; history **[X]** |
| Vault detail · Fees | per-level exit fee ceilings, HWM 10% perf, stacked totals | stacked math **[P]** (`fees.mjs`); **per-vault exit-fee params [C]** (immutable at creation) |
| Vault detail · Governance | active proposal, phase, quorum, timelock, mode I/F | **entirely [X]**: no proposal projection exists |
| Vault detail · Risk | capacity %, oracle status, sub-vault chain, non-transferability | capacity **[P]**; **oracle status [C]**; chain **[P]** |
| Deposit flow | capacity headroom, window state, indicative shares | headroom **[P]**; indicative NAV **[C]** |
| Portfolio position | shares held, current value, net-of-fee P&L, HWM carry | shares/holders **[P]**; **value/NAVps [C]**; **HWM carry [X]** (see OQ-3) |
| Portfolio pending | pending deposits in window, activation time, cancel | pendingCount **[P]** (aggregate only); **per-member pending [X]** |
| Portfolio queued exit | Mode-F queued shares, expected settlement trigger | **[X]** |
| Governance inbox | proposals across held vaults, phase, **reveal countdown** | **[X]** |
| Operator leaderboard | net realized, gain, **loss**, fees, vault count | net/gain/loss/fees **[P]** **[api]**; **vaultCount is broken** (always 0, see §3.6/OQ-4) |
| Operator profile | full vault set incl. wound-down, attested status | vault set **[X]**; attested **[P]** |

> **Mandate for the build team:** ship the **new projections** (proposal state, per-member
> position, per-member pending, Mode-F queue, HWM carry, operator display registry) as a
> precondition. The consumer product cannot be built on the current `projections.mjs` surface
> alone. See §3 and Open Questions for the specific gaps.

---

## 3. Key user flows

Notation for the payment/signing boundary. This is the single most important architectural fact
in the product:

- **[SIGN]** = an on-chain wallet signature / transaction (deposit, activate, cancel, commit,
  reveal, exit). Costs gas. **This is where all money and all governance happen.**
- **[x402]** = an off-chain USDC micro-payment for *metered data reads only* (§9). **x402 never
  appears in deposit, vote, or exit.** See §3.0.

### 3.0 Where x402 appears (and where it must not)

Per §9 and `server.mjs`, x402 gates *read* routes; the contract layer has **zero** x402
coupling. A consumer will not sign an EIP-3009 authorization per page view. **Recommendation
(opinionated, not a question):**

1. **Discovery, vault detail, leaderboard, and portfolio reads are a FREE public tier.** The web
   app pays x402 **server-side** on the user's behalf from a session read-budget, or serves a
   cached free projection. The end user never sees a 402 while browsing.
2. **x402 appears in the consumer UI only for genuinely premium reads**: signal feeds, deep
   historical analytics, CSV/PDF exports. There it surfaces as a clear "unlock for $X USDC"
   micro-purchase with the [x402] treatment, and even then it is one wallet interaction, not
   per-call.
3. **No x402 anywhere in deposit / vote / exit.** Those are [SIGN] only. Say this in the UI's
   trust copy so users don't fear a hidden paywall on their own funds.

### 3.1 First deposit (incl. observation window + skip opt-in)

The hard part: a first-time depositor's money is "locked with no shares" for 4 hours (§5), and
the shares they eventually receive are **unknowable at deposit time** because minting is
forward-priced at *activation* NAV (§4.3). The UX must set this expectation up front, not surprise
them.

```
Step 1  Choose amount
        • Show capacity headroom [P]; block/deposit-caps above cap (SF-3).
        • Show an INDICATIVE share estimate, explicitly labeled "estimate — final
          shares set at activation." NEVER render "you will receive X shares" (§4.1/§4.3).
        • Surface exit-fee-today vs. exit-fee-after-decay widget here (see §4.3 below).

Step 2  Understand entry mode  ← the decision point
        ┌─ Default: OBSERVATION WINDOW (recommended)
        │    "Your USDC is escrowed for 4 hours. It earns nothing and mints no shares
        │     yet. You can CANCEL any time in this window and get 100% back. After 4h,
        │     anyone can 'activate' and your shares mint at that moment's price."
        │    Why it exists: a social observation period; forward pricing on entry means
        │    you never mint against a stale valuation you saw 4 hours ago (§4.3).
        └─ Opt: SKIP THE WINDOW  ← S-3, permanent
             "Mint shares immediately. This opt-in is PERMANENT for this vault and
              cannot be undone — you give up the 4-hour cancel option forever."
             Requires a second, typed/explicit confirm. Do NOT make this the default;
             resist the conversion instinct (EE-3).

Step 3  [SIGN] Deposit transaction
        • Wallet signs a plain on-chain USDC transfer (§9 — no x402).
        • If window: state becomes "Pending — activates in 4:00:00" (see §6 state).
        • If skip: shares mint now; go straight to portfolio position.

Step 4  Activation (window path only)
        • A countdown in portfolio + a notification at 0:00.
        • [SIGN] "Activate" — mints shares at activation NAV (forward-priced).
          Copy: "anyone can call this; we'll do it for you at T+4h, or activate now
          if you're ready." (activation is permissionless per §5.)
        • Confirmation shows ACTUAL shares minted (now known).
```

Decision points: **amount → window-vs-skip → sign**. Confirmations: standard for deposit; **hard
(typed) confirm for skip (S-3)**. Payment: [SIGN] only.

### 3.2 Casting a commit-reveal vote (two steps, S-4 is the danger)

The hard part: voting is two on-chain steps separated by time, and **forgetting the second step
forfeits the vote** (§8, §14.4: Kleros abandoned commit-reveal because voters *forget*, not
grief). The UX's job is to make the reveal impossible to forget and impossible to lose across
devices.

```
Phase 1  COMMIT  [SIGN]
         • User picks For / Against / Abstain on the proposal.
         • Client generates a SALT. CRITICAL DESIGN DECISION: derive the salt
           DETERMINISTICALLY from a wallet signature over a fixed message
           (e.g. sign "reveal-salt:{vault}:{proposalId}"), NOT random-and-stored.
           Rationale: a wallet-derived salt is recoverable on ANY device from the
           same wallet. Random-and-stored means clearing browser storage, or
           committing on mobile and revealing on desktop, PERMANENTLY loses the vote.
           (See OQ-2 — confirm the contract hashes support+salt in a way compatible
           with a derived salt.)
         • [SIGN] submit commit hash. Tally stays hidden.
         • Immediately: schedule reveal reminders (see below).

         ── between phases: commit deadline passes ──

Phase 2  REVEAL  [SIGN]  ← the forfeit risk
         • Reconstruct salt from the wallet signature (portable — no stored secret).
         • [SIGN] reveal(support, salt). Unrevealed = abstain, forfeit (§8).
         • Note: the running tally IS publicly readable mid-reveal (VO-7), but the
           commit binds direction, so a late revealer cannot change their vote based
           on the partial tally — present the visible tally honestly; do not imply it
           can be gamed.
```

**Anti-forfeit design (this is the product's most important governance feature):**
- Reveal-deadline **countdown surfaced everywhere the user looks**: portfolio header, governance
  inbox badge, and OS/email notifications, not only on the proposal page (S-4).
- Escalating reminders: at reveal-open, at 50% elapsed, at T-1h, at T-15m.
- A persistent "1 vote awaiting reveal" banner until revealed or deadline.
- Because the salt is wallet-derived, the reveal CTA works from any device with the wallet.
  Document this to the user ("you can reveal from any device").
- Standing defaults (§8) and delegation (§3.4) are the *opt-out* path for Persona A who does not
  want two-step voting at all: surface them prominently to reduce the population exposed to S-4.

### 3.3 Exit: Mode I (instant) and Mode F (forward-priced)

The hard part: whether an exit settles instantly or *later at a different price* depends on
whether the vault has a pending execution (§4.4), `Governance.hasPendingExecution`, true from the
active proposal's reveal start and for any proposal type, which the user did not cause and may not
know about. And the default payout is **a basket of tokens, not USDC** (§4.5).

```
Entry (both modes)
  • Precondition copy on vault detail AND exit: "Shares are NON-TRANSFERABLE (EE-7).
    Exiting is the only way out." A crypto user will assume they can sell shares —
    correct this loudly, not in a footnote.
  • Exit flow first resolves the mode from chain state:

MODE I — instant (common path)
  • Condition: no pending execution — hasPendingExecution is false (§4.4).
  • Preview an ITEMIZED "what you'll receive": in-kind pro-rata slice of EVERY basket
    asset + share of idle USDC, MINUS the exit fee (§4.5). Show per-asset amounts.
  • Exit-fee line: current fee = feeMax·max(0,1 − tenure/decay) (§4.6). Show the exact
    number AND "fee accrues to REMAINING members, not the operator" (§4.6) — this is a
    trust-positive fact that reads as a scam if unexplained.
  • [SIGN] exit → settles in the same transaction at current NAV. Shares burn at
    settlement. Done.

MODE F — forward-priced  ← S-2, irreversible
  • Condition: the vault has a pending execution — hasPendingExecution is true, i.e. the active
    proposal is past its reveal start (of ANY type, not only a rebalance) (§4.4).
  • The confirm must carry TWO distinct warnings in one screen:
      (1) "This exit is QUEUED and IRREVOCABLE. It settles LATER — not in the execution
           transaction; someone must call settleQueuedExit once execution is no longer
           pending — at a price we cannot show you now (post-execution NAV). You will
           bear the outcome." (§4.4, VO-8)
      (2) "Your shares LOSE VOTING ELIGIBILITY the moment you queue (§4.4/EE-10).
           You cannot vote on or influence the rebalance you're exiting ahead of."
  • Offer the honest alternative: "Or wait until after execution to exit in Mode I at a
    known price" — help the user choose deliberately (VO-8 is the subtlest economic
    seam; the UX must not hide it).
  • [SIGN] queue exit. State becomes "Exit queued — settleable once execution clears" in portfolio.
  • Settlement is NOT automatic: once hasPendingExecution goes false (the proposal executed, was
    defeated, or expired), anyone may call settleQueuedExit(member) and it settles at then-current
    NAV (EE-10). The UI should offer the user that call and not imply it happens on its own —
    reflect every outcome in the queued-exit state copy.

Cash-redemption note
  • A USDC-cash exit path "may be offered later" (§4.5) and is the ONLY path subject to
    swing pricing (§4.7). Until it ships, DO NOT warn about swing pricing on the default
    in-kind path — it does not fire there, and over-warning discloses a fee that can't
    apply. If/when cash exit ships, swing-haircut disclosure attaches to that path only.

Sub-vault exit edge (named error state)
  • A sub-vault exit can revert `ExitNeedsChildSettlement` if the only child holding the
    needed value is mid-rebalance and idle can't cover (Sprint 6 E4/E5). Present as a
    non-scary "retry after the child settles" state, bounded by the child's timelock —
    NOT a generic failure. Show which child and its expected settlement time.
```

Decision points: **mode is resolved for the user (they don't choose it)** → in Mode F, the real
decision is **queue now vs. wait for Mode I**. Confirmations: standard for Mode I; **hard confirm
with the two-warning screen for Mode F (S-2)**. Payment: [SIGN] only.

---

## 4. Risk & fee disclosure UX (progressive disclosure)

Principle: **disclose by decision proximity, not all at once.** Three tiers. Never dump the whole
threat model on a card; never bury a fund-losing risk behind a hover.

### Tier 1: Ambient (always visible, glanceable, on cards & headers)
- **Attested badge** (canonical-factory attested vs. unattested): see §5.
- **Mode I / Mode F** status with **text + icon shape**, never color alone (fixes the demo's
  color-only pill, WCAG 1.4.1).
- **Oracle status** dot with a text label ("Live" / "Frozen").
- **Capacity %** bar with numeric label.
- **Stacked effective fee** headline for sub-vaults ("19.00% effective perf across 2 levels").

### Tier 2: On-decision (expanded inline at the deposit/exit moment)
- **Exit-fee decay widget**: the single best fee disclosure available. A small chart/readout:
  "Exit today: 1.00% · in 30 days: 0.50% · after decay: 0.00%," driven by
  `feeMax·max(0,1 − tenure/decay)` (§4.6). Show that the fee **goes to remaining members**.
- **HWM performance fee**: "10% of realized profit, charged only when you exit in profit, and
  only above your high-water mark" (§6, §7). If per-member HWM carry is available (OQ-3), show
  "you currently owe fee on $X of gains"; if not, show the *rule* and flag the number as
  unavailable. Do not fabricate it.
- **Stacked sub-vault fees**: reuse the `fees.mjs` model exactly (contract-mirrored): perf
  compounds on net-of-fee value (19% at depth 2, *not* 20%), exit-fee ceiling sums across the
  chain (§10). Render the per-level breakdown table (as the demo's fee-stack does) with real
  `<th scope>` headers.
- **Capacity cap**: headroom and what happens at the cap (deposit reverts, SF-3).
- **In-kind payout preview**: the itemized basket you'll receive on exit (§4.5).

### Tier 3: Deep (Risk tab + /learn, linked contextually)
- **Oracle-freeze-traps-exits (K-4/SF-2)**: the headline systemic risk. Plain language:
  "Each asset is priced from ONE Chainlink feed with no fallback. If that feed goes past its
  heartbeat, prices outside its sane band, or the Base sequencer is down, the vault FREEZES:
  deposits, exits, and rebalances all stop until it recovers. There is no emergency withdrawal, by
  design. Your capital is trapped for the whole of that period, and permanently if the feed is
  retired rather than merely late." (Pre-C-6 this paragraph said "loses enough trusted sources" and
  "temporarily trapped"; there is no source set to lose any more, and a deprecation is permanent:
  see LAUNCH-READINESS §4 rows 12/13.) Link from the Risk tab and from any deposit confirm. This
  is the one risk that must be *acknowledged* (checkbox) before a first deposit.
- **Forward-pricing / timelock interplay (VO-8)**: explainer for why a mid-vote exit settles
  later.
- **Non-transferability (EE-7)**, **near-immutability of rules (K-2/CM-8)**, **USDC blacklist
  risk (PX-1)**, **creator withdrawal gate (CM-2)**.

**Disclosure gating rules:**
- First deposit into any vault → **must acknowledge oracle-freeze risk** (checkbox, Tier 3
  surfaced inline).
- Skip opt-in (S-3), Mode-F queue (S-2) → **typed/explicit hard confirm**.
- Depositing into an **unattested** vault → **interstitial** (see §5).
- Everything else → progressive, no forced modals.

---

## 5. Trust & safety: legit operators vs. scam vaults

Permissionless creation means scam vaults exist (PX-3). The **registry is the signal**, and it is
machine-checkable. This is the key insight the UI must exploit.

**The hard discriminator:** in `projections.mjs`, `operatorId` is set only by the `VaultAttested`
event. Therefore **`operatorId === 0` means the vault is *unattested* by the canonical factory.**
That is a binary, non-spoofable trust bit. Display metadata (names, logos) is spoofable (PX-3);
registry identity is not.

Design rules:
1. **Registry identity is primary; display name is secondary.** Show the operator's registry ID /
   attested identity as the authoritative label; render the human name beneath it, clearly marked
   as self-declared. Never let a spoofed name impersonate a reputable operator visually.
2. **Attested badge** on every card and the vault header. Attested = a hard, earned badge.
   Unattested = a visible warning treatment.
3. **Quarantine unattested vaults.** They are a separate, clearly-labeled section in discovery
   (not interleaved with attested vaults), carry **no leaderboard presence** (leaderboard
   aggregates canonical-factory vaults only, CM-5/SF-4), and trigger a **full interstitial before
   deposit** ("This vault is NOT attested by the canonical registry. Its operator's track record
   cannot be verified and may be spoofing a known name. Proceed only if you know exactly what
   you're doing.").
4. **Leaderboard shows losses, not just wins (SF-4/SF-5).** Surface `lifetimeLossUsdc` alongside
   gains with equal visual weight; net realized is gain − loss. Provide **TVL-weighted and
   member-count-weighted** views so dust/wash vaults can't top the board (SF-4 requires both).
5. **No cherry-picking, and say so.** Wound-down/closed vaults stay in the operator's aggregate
   permanently (SF-5). The operator profile shows the **full** vault set including closed ones,
   labeled, and a short UI note explains *why* ("operators can't hide their losers"). This is a
   trust feature; make it legible, not just correct.
6. **Fee routing transparency.** Prominently state that exit fees go to remaining members and
   performance fees follow HWM: the protocol's operator-can't-skim posture is a selling point
   (§4.6, EE-9).

---

## 6. States: empty / loading / error / special

Every screen needs the standard trio plus the protocol-specific states below. The two
non-negotiable custom states are **oracle-frozen** and **observation-window**.

### Global / cross-cutting states
- **Wallet-disconnected**: discovery and reads work (free tier, §3.0); deposit/vote/exit CTAs
  prompt connect.
- **Loading**: skeletons for cards/tables; never block discovery on a paid read.
- **Read-budget exhausted** (if server-side x402 budget is used, §3.0): degrade to cached data
  with a "data may be delayed" note, never a 402 in the user's face.

### Oracle-FROZEN state (S-1 / K-4 / SF-2): highest priority
- **Trigger:** breaker tripped; NAV-reading paths revert.
- **Treatment:** a persistent, unmistakable banner on affected vaults and any open deposit/exit
  flow. Deposit/exit/activate/vote-execute CTAs are **disabled with an explanation**, not hidden.
- **Copy (must be true):** "This vault is FROZEN. Its price oracle has lost too many trusted
  sources, so all deposits, exits, and rebalances are paused until the sources recover. There is
  no emergency withdrawal: this is a deliberate safety design (it prevents anyone exiting at a
  manipulated price). Your positions and history remain visible below."
- **Still available:** viewing positions and history; **possibly** cancelling a pending deposit
  (OQ-1: engineering must confirm `cancelPending()` doesn't read NAV; if it doesn't, this is the
  *one* action offered in the frozen state and the copy changes materially).
- **Prohibited:** any "contact support," "request withdrawal," or "emergency exit" affordance.
- **Source detail (progressive):** show per-source freshness so a technical user understands
  *why* it's frozen and roughly when it might clear.

### Observation-window state (§5): "your deposit is pending"
- **Trigger:** first deposit escrowed, shares not yet minted.
- **Treatment:** a distinct "Pending" position card in `/portfolio/pending` with a **live
  countdown to activation**, "0 shares yet: this is expected," and two CTAs: **Cancel** (100%
  refund, available for the whole window) and, at/after T+4h, **Activate**.
- Make clear the money is escrowed and earning nothing, and that cancel is free and instant.

### Per-screen states
| Screen | Empty | Error / special |
| --- | --- | --- |
| Discovery | "No vaults match" | Registry read failed → cached + stale note |
| Vault detail | — | Frozen banner; unattested warning; capacity-full ("deposits closed at cap") |
| Deposit | — | Above capacity (blocked); frozen (blocked); pending-exists |
| Portfolio | "No positions yet" → link to discovery | Frozen vault held; **queued Mode-F exit**; **creator-withdrawals-frozen** (if user is a creator below 5%, CM-2: likely rare in consumer app, note in OQ-7) |
| Pending | "No pending deposits" | Window elapsed, awaiting activate |
| Governance inbox | "No proposals in your vaults" | **Vote committed, awaiting reveal** (persistent); **reveal window closing** (urgent); **reveal missed** (forfeited, past tense) |
| Proposal detail | — | Commit phase / reveal phase / timelock / executed / expired-unexecuted |
| Exit | — | Mode-F (queued); `ExitNeedsChildSettlement` (retry-after-child); frozen (blocked); last-member (fee waived, §4.6) |
| Leaderboard | "No operators yet" | vaultCount broken (§3.6) → hide the column until OQ-4 fixed |

---

## 7. Responsive / mobile + accessibility (WCAG 2.2 AA)

### Responsive / mobile
- **Money-moment confirmations are full-screen sheets on mobile, and resumable.** The four
  spine actions (S-1..S-4) must not be a cramped modal. Resumability ties to the wallet-derived
  salt (§3.2): a user can commit on desktop and reveal on mobile.
- Discovery cards → single column; fee-stack and leaderboard tables → horizontal scroll inside a
  bounded container (the demo already does `.tablescroll`, keep it, and make the whole page never
  scroll horizontally).
- Countdowns and the "awaiting reveal" / "pending activation" banners must be reachable in one tap
  from anywhere (persistent header affordance).

### Accessibility: specifics, not boilerplate
- **1.4.1 (color alone):** Mode I/F, oracle status, attested/unattested, and P&L sign must all
  carry **text + shape/icon**, not just the demo's green/amber pills. This is a real fix, not a
  nicety.
- **4.1.3 / live regions:** the observation-window and reveal-deadline countdowns use
  `aria-live="polite"` announced **at thresholds** (open, 50%, T-1h, T-15m, close), **not per
  second**, which would flood a screen reader.
- **2.2.1 (timing):** these countdowns are **protocol deadlines** (block-timestamp driven) and
  qualify for the real-time exception. **Document that** rather than offering an extend/dismiss
  control the protocol cannot honor. A false "extend" would be worse than none.
- **1.3.1 / tables:** fee-stack and leaderboard tables need real `<th scope="col/row">`;
  numeric cells keep `tabular-nums`.
- **Forms & confirms:** the typed hard-confirms (S-2, S-3) need programmatic
  label/description association and an accessible error if the typed string doesn't match.
- **Focus management:** full-screen confirm sheets trap focus and restore it on close; the frozen
  banner is announced when it appears.
- **Contrast:** verify the demo's `--muted`/`--faint` on `--surface` meet 4.5:1 in both themes
  before reuse. Several are borderline for body text.

---

## 8. Open questions / recommendations (product decisions needed before build)

Ordered by how hard they block the build.

- **OQ-1 (blocks frozen-state design): Does `cancelPending()` revert under a tripped breaker?**
  §5 says pending deposits are excluded from NAV and cancellable before activation, implying
  cancel may not read NAV. If it doesn't, "cancel your pending deposit" is the *one* action
  available in the frozen state and the frozen-state screen changes materially. Two-branch spec;
  engineering must confirm.
- **OQ-2 (blocks vote flow): Is a wallet-derived (deterministic) salt compatible with the
  commit hash?** The anti-forfeit design (§3.2) depends on reconstructing the salt from a wallet
  signature on any device. Confirm the contract's `commit = hash(support, salt)` accepts a
  client-chosen salt with no server-stored randomness, and that the derivation message is
  domain-separated per (vault, proposal).
- **OQ-3 (blocks net-of-fee P&L): There is no HWM-carry projection.** "What performance fee will
  I pay?" is unanswerable today: HWM is a per-`(member, operator)` USDC loss carryforward (§7)
  with no indexer projection behind it. Decide whether v1 shows true net-of-fee returns (needs a
  new projection) or shows gross + the fee *rule* only. This gates whether the portfolio can even
  display net returns.
- **OQ-4 (leaderboard correctness): `operators[].vaultCount` is always 0.** It's initialized to
  0 and never incremented (`VaultAttested` sets `operatorId` but nothing bumps `vaultCount`;
  `projections.mjs` §OperatorRegistered/VaultAttested). Either fix the projection or hide the
  column. Ship-blocker for the leaderboard's credibility.
- **OQ-5 (x402 product model): Confirm the free-tier / server-side-payment model (§3.0).** The
  strong recommendation is: free public discovery + server-side x402 read budget, with consumer
  x402 only for premium reads, and **never** in deposit/vote/exit. Needs sign-off because it
  affects API auth, cost, and rate-limiting design. (Recommended, not open, but it needs an
  owner's yes.)
- **OQ-6 (new projections): Prioritize the missing indexer projections.** Consumer product
  requires, minimally: proposal/governance state, per-member position + value, per-member pending
  deposit, Mode-F queue state, operator display-name registry, and NAV/NAVps + basket
  composition. Sequence these against sprint plan; the IA (§2.2) tags each.
- **OQ-7 (scope confirmation): Vault creation and creator-gate states.** Creation is out of v1
  consumer scope (operator tool). But if any consumer can also be a creator, the
  **creator-withdrawals-frozen** portfolio state (CM-2: redemptions revert below 5% while members
  remain) needs a home. Decide whether to handle it minimally or defer with a clear message.
- **OQ-8 (notifications infra): The anti-forfeit reveal reminders (§3.2) need a delivery
  channel.** In-app is insufficient for S-4 (users leave). Decide: email opt-in, push, wallet-
  based messaging, or a watcher the user runs. Without out-of-app reminders, S-4 forfeitures will
  happen.
- **OQ-9 (delegation/standing-default UX depth): How much governance tooling in v1?** Persona A
  wants to *never* two-step vote. Delegation (concentration-capped, §8) and standing defaults
  (routine-rebalance only, 72h expiry, §8) are the escape hatch. Decide whether v1 ships both or
  just delegation.

---

## Executive summary: recommended consumer product shape

1. **Build the whole product around four irreversible moments**: oracle freeze (K-4), Mode-F
   queued exit (§4.4), permanent window-skip opt-in (§5), and forgotten vote-reveal (§8). These
   get full-screen, plain-language, high-friction confirmations; everything else is progressive
   disclosure.
2. **Keep x402 out of the user's money path entirely.** Deposits, votes, and exits are on-chain
   wallet signatures only; discovery/portfolio reads are a free public tier (the web app absorbs
   x402 server-side); consumer-visible x402 is reserved for premium data reads.
3. **Make the observation window humane, not alarming:** default to the 4-hour window with a live
   countdown and a free cancel, frame skip as a permanent forfeit behind a hard confirm, and never
   promise exact shares before activation (forward pricing, §4.3).
4. **Engineer the vote reveal to be un-forgettable and device-portable:** wallet-derived salt (no
   stored secret), reveal countdowns everywhere, out-of-app reminders, and push Persona A toward
   delegation/standing defaults so most users never two-step vote at all.
5. **Turn the registry into the trust layer:** attested (`operatorId>0`) vs. unattested is the
   non-spoofable scam discriminator: quarantine unattested vaults, lead with registry identity
   over display names, and show operator losses and wound-down vaults (no cherry-picking).
6. **Disclose fees where the decision is made:** an exit-fee decay widget, an itemized in-kind
   payout preview, and the contract-mirrored stacked sub-vault math, with the trust-positive
   truth that exit fees accrue to members, not the operator.
7. **The current data layer cannot back this product.** New indexer projections (proposal state,
   per-member position/pending, Mode-F queue, HWM carry, NAV/basket, operator names) are a
   precondition, and `vaultCount` is currently broken. These are ship-blockers, not polish.
8. **Net:** a calm, disclosure-forward allocator app for crypto-literate humans that makes
   agent-governance mechanics legible and honest, refusing the dark-pattern shortcuts exactly
   where the protocol's irreversibility makes them dangerous.
