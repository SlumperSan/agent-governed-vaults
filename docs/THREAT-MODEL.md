# Threat Model — Agent-Governed Index Vault Protocol

Sprint 1 artifact 1.2. Pass criterion: **traceability** — every mechanic in the brief has a row,
including rows where the honest answer is "no vector identified." Companion:
[ARCHITECTURE.md](ARCHITECTURE.md) (§ references below).

Severity: **H** = loss of funds / permanent capital lockup, **M** = value extraction or
governance distortion, **L** = griefing / nuisance. Status: **Mitigated** (design defends),
**Accepted** (known tradeoff, deliberate), **Deferred(Sn)** (defense lands in sprint n),
**None found** (examined, no vector identified — challenge these in Sprint 6).

---

## EX — Execution / adapters

| ID | Mechanic | Attack vector | Sev | Mitigation / status |
| --- | --- | --- | --- | --- |
| EX-1 | Adapter abstraction, no venue dependency | Malicious or compromised adapter drains vault via arbitrary swap calldata (approval draining, self-dealing routes) | H | Deferred(S4): adapters allow-listed per vault at creation; adapter enforces `minOut` and deadline itself, never trusting router calldata; approvals granted per-swap and revoked after (defi-amm-security: slippage + approval hygiene) |
| EX-2 | Base DEX aggregation (0x/1inch-style) | Sandwich/MEV on rebalance execution; router upgrade changes semantics under an old approval | M | Deferred(S4): minOut bound from oracle median ± tolerance; approvals to immutable adapter only, adapter pins router address; private-mempool submission is an off-chain agent concern, documented for operators |
| EX-3 | Off-chain-generated route calldata | Route generator (agent or API) injects a route ending at attacker-controlled pool with fake token | H | Deferred(S4): adapter verifies output token identity and balance delta ≥ minOut on the vault's own accounting, not the router's return value |
| EX-4 | Chain-agnostic design | Deploying to a chain where an assumed primitive differs (timestamp granularity, reorg depth) misprices windows/timelocks | L | Mitigated: `block.timestamp` only, no block-count arithmetic (§3); per-chain deployment checklist added in Sprint 9 |

EX-1..EX-3 are not hypothetical: the SwapNet/Aperture exploit (Jan 2026, ~$13–17M) and the
Dexible / Unizen / LI.FI incidents all follow the exact arbitrary-calldata pattern EX-1/EX-3
describe (see [RESEARCH-SPRINT1.md](RESEARCH-SPRINT1.md)).

## CM — Core mechanics

| ID | Mechanic | Attack vector | Sev | Mitigation / status |
| --- | --- | --- | --- | --- |
| CM-1 | Creator ≥5% stake lock | Creator escapes lock by exit-and-reenter, or by Sybil second identity holding the "creator" stake | M | Mitigated(S1): withdrawal gate keyed to creator address, checked on every creator redemption while members remain (§6); identity-level evasion lands with OperatorRegistry (S3) |
| CM-2 | Creator 5% measured against supply | Members' deposits passively dilute creator below 5%, then argue vault is in violation to force unwind | L | Mitigated(S1): gate is on creator *action*, not a solvency condition; passive dilution only freezes creator withdrawals (§6, K-composition) |
| CM-3 | Performance fee on realized profit only | Operator forces realization events (churn rebalances) to crystallize fees early | M | Deferred(S3): fee crystallizes only on *member* redemption, never on rebalance — realization is member-initiated by construction |
| CM-4 | Per-member HWM, marks follow operator | Operator abandons loss-carrying identity, mints fresh identity to reset marks | H | Deferred(S3): registry identity is the fee recipient; fresh identity = zero track record on the aggregate leaderboard (SF-4), making reset visible and costly. Residual risk accepted: reputation, not funds, is the enforcement |
| CM-5 | HWM as USDC loss carryforward across vaults (§7) | Member self-deals losses in a throwaway vault under operator X to build carryforward, then farms fee-free gains in the real vault | M | Deferred(S3): carryforward accrues only from vaults deployed by the canonical factory against the canonical registry; economic analysis of residual self-dealing in Sprint 6 |
| CM-6 | Proposal rights scale with stake | Whale member reaches proposal monopoly; spam-proposals to exhaust voters | M | Deferred(S2): per-member active-proposal cap and proposal cooldown; commit-reveal cost asymmetric to proposer |
| CM-7 | <5 members → absolute signer counts | Boundary gaming: Sybil to 5 to switch regimes, or engineered exit to 4 to flip to signer mode mid-proposal | M | Deferred(S2): regime is snapshotted per proposal at creation; membership changes never alter an in-flight proposal's rules |
| CM-8 | Rules immutable except full consensus + timelock | One permanently offline member freezes rule changes forever | L | **Accepted (K-2)**: near-immutability is the intent; documented so no future sprint "fixes" it with a bypass that becomes the actual attack surface |

## VO — Voting

| ID | Mechanic | Attack vector | Sev | Mitigation / status |
| --- | --- | --- | --- | --- |
| VO-1 | Offline agents auto-abstain | Targeted DoS of specific agents' infrastructure to force abstention and swing outcomes | M | Deferred(S2): commit window long enough to recover; standing defaults give a bounded fallback for routine rebalances only. Residual risk accepted — availability is the agent's responsibility (llm-trading-agent-security: operational hardening documented for agent operators) |
| VO-2 | Standing defaults count in tally, never quorum | Attacker times proposals for when live participation is low, letting defaults dominate the tally once quorum barely clears | M | Deferred(S2): quorum floor (25%) is measured against *live* participation precisely to bound this; defaults expire in 72 h; routine-rebalance tag is contract-checked, not proposer-asserted |
| VO-3 | Standing defaults expire after 72 h | Griefing by proposing just after mass default expiry to catch the vault voiceless | L | **Accepted (K-3)**: liveness floor is intentional — a vault of pure defaults should not be able to pass anything |
| VO-4 | Routine-rebalance-only scope for defaults | Proposer disguises a non-routine action (adapter change, fee change) as a routine rebalance to harvest defaults | H | Deferred(S2): proposal types are structurally distinct on-chain (target/selector allow-list per type); defaults apply only to the rebalance type |
| VO-5 | Delegation, concentration-capped | Delegate accumulates weight just under cap across colluding delegators; cap checked at delegation but stake grows after | M | Deferred(S2): cap re-checked at vote tally time against snapshot, not only at delegation time |
| VO-6 | Commit-reveal | Non-revealers grief outcomes by committing then withholding reveal to starve quorum | M | Deferred(S2): unrevealed commits are forfeit (abstain) and count as participation for quorum denominator purposes only if revealed — non-reveal costs the committer their voice, not the vault its quorum (§8) |
| VO-7 | Commit-reveal | Vote buying is *harder* under commit-reveal, but reveal-phase last-mover advantage: late revealers see partial tallies | L | **Documented residual (S6 re-review)**: the running tally IS readable mid-reveal (public getter + cleartext Revealed events) — the originally-envisioned tally-view gating was not built. BUT the commit binds `support`, so a late revealer cannot change direction on the partial tally; no new exploit beyond ordinary reveal-order visibility. Full closure needs encrypted reveals, a deliberate v1 non-goal |
| VO-8 | Post-vote timelock ≤30 d | Timelocked malicious proposal passes while members inattentive; timelock exists so members can exit — but exits during this window are forward-priced (K-1 interplay) | H | Mitigated(S1/S2): Mode-F queueing starts at vote *passage* (§8), so exit-before-execution is always available; forward pricing means exiters bear the rebalance outcome — Sprint 6 must adversarially test this interplay, it is the subtlest economic seam in the design |
| VO-9 | Proposal snapshot | Flash-deposit (or flash-loan) stake to swing a vote, exit after | H | Deferred(S2): voting power snapshotted at proposal creation; pending deposits (§5) and Mode-F-locked shares excluded from eligible stake |

## EE — Entry / exit

| ID | Mechanic | Attack vector | Sev | Mitigation / status |
| --- | --- | --- | --- | --- |
| EE-1 | 4-h observation window, capital sequestered | Pending capital manipulated into NAV (donation-style) to distort NAVps before activation | H | Mitigated(S1): pending deposits held in internal escrow accounting, excluded from NAV and idleUSDC (§4.2, §5); share math never reads raw `balanceOf` (defi-amm-security: internal accounting) |
| EE-2 | Sequestered capital has no voting rights | Attacker activates exactly at proposal creation to gain snapshot weight | M | Deferred(S2): snapshot taken at proposal creation; activation in the same block ordered after snapshot by design (snapshot reads pre-activation state) |
| EE-3 | Window skip via irreversible opt-in | Skip removes the observation delay as a governance defense | L | Mitigated: window is not the governance defense — snapshots are (VO-9); window is social/observational (§5). No additional vector from skipping identified |
| EE-4 | Window once per agent per vault | Dust-deposit early to pre-clear the window, flash-deposit later | M | Mitigated(S2 interplay): pre-cleared window grants immediate *minting*, but voting power still snapshot-gated; residual is identical to VO-9 |
| EE-5 | Instant exit at pro-rata NAV | Exit at stale NAV between oracle updates (latency arbitrage) | H | Deferred(S4): oracle staleness bounds tight enough that the breaker trips before exploitable drift; Sprint 6 quantifies the profitable-drift threshold vs. exit fee |
| EE-6 | In-kind redemption | Redeemer forces distribution of illiquid/blacklisted asset positions (e.g. USDC-blacklisted vault address scenario), or in-kind transfer of a token that reverts, blocking all exits | H | Mitigated(S1): per-asset transfer failure isolates — failed asset's slice is escrowed for later claim rather than reverting the whole redemption; Sprint 6 red-teams the escrow path |
| EE-7 | Exit fee ≤1%, decays with tenure | Fee-avoidance by transferring shares to an aged identity | M | Mitigated(S1): tenure binds to the share lot, not the holder — transfers reset tenure clock on transferred shares (S1 keeps shares non-transferable, making this moot until transferability is ever proposed) |
| EE-8 | Exit fee paid to remaining members | Last-two-members endgame: penultimate exiter pays fee to final member; final member exits free — mild incentive race to not be penultimate | L | **Accepted**: bounded at 1%, self-limiting; fee waived only for the true last member (§4.6) |
| EE-9 | Exit fee never to operator | Operator is also a member and receives fee pro-rata via membership | L | **Accepted**: operator-as-member receives only their member share like anyone else; the prohibition is on *routing*, and routing is to shares, not identity. Documented so it isn't misread as a violation |
| EE-10 | Forward pricing between passage and execution (Mode F) | Exit-then-veto: member queues Mode-F exit, then votes/act to sabotage execution so settlement never comes | M | Mitigated(S1): Mode-F-locked shares lose voting eligibility at queue time (§4.4); if a passed proposal expires unexecuted (execution deadline), queued exits settle at then-current NAV — no indefinite lock |
| EE-11 | Swing pricing on oversized redemptions | Splitting one large redemption into many small ones under θ to dodge the swing | M | Mitigated(S1): swing measured against rolling window of redemptions per member, not per transaction; in-kind path (the default) needs no swing at all (§4.5, §4.7) |

## SV — Sub-vaults

| ID | Mechanic | Attack vector | Sev | Mitigation / status |
| --- | --- | --- | --- | --- |
| SV-1 | Parent allocates, child self-governs | Child governance rebalances into assets that violate parent mandate — parent capital exposed to unbargained risk | M | Deferred(S5): parent allocation is a member position in the child — parent gets stake-weighted vote in child governance; mandate enforcement is governance, not code. Accepted residual: code cannot read mandates |
| SV-2 | Max depth 3 | Depth measured naively lets A→B→C→A′ (new vault, same operators) recreate depth | L | Deferred(S5): depth = registry-recorded parent-chain length from root; new vault with a parent inherits parent depth + 1 regardless of operator identity |
| SV-3 | Recursive deposits blocked at contract level | Cycle via intermediary: A deposits into B, B into A — each individually valid | H | Deferred(S5): registry walk of full ancestor chain at deposit time (O(3) by depth cap); vault-to-vault deposits *only* permitted along registered parent→child edges, closing side-channel cycles |
| SV-4 | Cumulative effective fees displayed, stacked total capped | Fee stacking under-computed if child changes fees after parent allocates (full-consensus makes this rare but possible) | M | Deferred(S5): cap checked at allocation *and* re-checked at child fee-crystallization time; excess fee truncated to cap |
| SV-5 | Parent redemptions draw idle stables before child positions | Attacker drains parent idle stables with small redemptions to force next redemption into child unwind at bad prices | L | Deferred(S5): ordering is a liquidity preference, not a price guarantee; child unwind is in-kind pro-rata (EE-6 machinery). No profitable vector identified beyond ordinary redemption impact — challenge in Sprint 6 |
| SV-6 | Child quorum floors inherit from parent | Parent sets floor 100% then allocates, bricking child governance | M | Deferred(S5): inheritance is `max(childFloor, parentFloor)` computed at allocation; parent floor capped at protocol max for inheritance purposes |
| SV-7 | Sub-vault NAV composition | Child NAV manipulation propagates to parent NAV (parent prices its child position at child-reported NAVps) | H | Deferred(S5): parent prices child position through the same OracleAggregator asset-level path (look-through pricing), never through child self-reported NAVps |

## SF — Safety systems

| ID | Mechanic | Attack vector | Sev | Mitigation / status |
| --- | --- | --- | --- | --- |
| SF-1 | Multi-source median oracle | Compromise of ⌈n/2⌉ sources moves the median; correlated upstream (same aggregator API) sources are not independent | H | Deferred(S4): source independence is a listing criterion (different mechanism classes: CL-style push, TWAP, RedStone-style pull); per-asset source set fixed at vault creation |
| SF-2 | Stale-oracle breaker freezes everything incl. exits | Attacker induces staleness (DoS a source, or exploit a source's own pause) to trap capital; separately, honest stall during market crisis locks members into falling basket | H | **Accepted (K-4)**: any exit-during-staleness hatch *is* the stale-price exit the breaker exists to prevent. Mitigation is source count and independence (SF-1). No hatch will be added. **Partial softening:** *pending* (observation-window) capital is never trapped — `cancelPending` reads no oracle, so un-activated deposits are always reclaimable during a freeze (`test_pendingDepositCancellableDuringOracleFreeze`). Only active share capital is held |
| SF-3 | Per-vault capacity caps | Cap-squatting: attacker fills capacity with own stake to exclude others, then charges for exit (or just griefs) | L | Mitigated(S1): squatter's capital is at risk in the basket like anyone's and pays exit fee to leave; economic disincentive suffices. No further vector identified |
| SF-4 | Operator aggregate leaderboard, all vaults | Score inflation via self-dealing vaults (operator's own capital, wash performance) | M | Deferred(S3): leaderboard aggregates only canonical-factory vaults (CM-5); displays TVL-weighted and member-count-weighted views so dust vaults can't dominate; residual accepted — reputation systems are gameable at the margin |
| SF-5 | No cherry-picking | Operator winds down losing vaults early to shorten their loss window in time-weighted metrics | M | Deferred(S3): closed-vault history is retained permanently in the registry and remains in aggregates; wind-down itself is recorded |

## MO — Module liveness (added post-review, Sprint 3 hardening)

| ID | Mechanic | Attack vector | Sev | Mitigation / status |
| --- | --- | --- | --- | --- |
| MO-1 | Creator-chosen bookkeeping modules (governance / feeEngine / registry) on the exit path | Reverting, gas-guzzling, or returndata-bombing module bricks all exits forever (no upgrade path) — honeypot vaults, or an honest governance bug protocol-wide (review H-1) | H | **Mitigated(S3)**: all module calls on the exit path are gas-capped (300k) and returndata-bounded (1 word); failures are event-logged and forfeit only the module's own bookkeeping. Governance failure falls back to Mode I — a broken governance loses forward pricing (VO-8 leak accepted in that already-broken state), never member liveness |
| MO-2 | In-kind transfer of misbehaving basket token | Token returning 1–31 bytes or a returndata bomb reverts settlement, bricking exits (review H-2 — falsified original EE-6 claim) | H | **Mitigated(S3)**: `tryTransfer` is assembly, gas-capped, bounded to one returndata word; malformed results degrade to the EE-6 escrow, never revert |
| MO-3 | Creator gate × Mode-F queue | Gate-compliant queued exit stranded forever by third-party deposits between queue and settle (review M-1) | M | **Mitigated(S3)**: gate is checked at queue time and NOT re-checked at settlement of queued exits — new joiners had on-chain notice of the queue |
| MO-4 | Perf fee vs in-kind payout | Fee clamped to cash leg ⇒ fully invested vaults pay ~zero performance fee (review M-2) | M | **Mitigated(S3)**: fee withheld uniformly across cash and in-kind legs; asset-leg fees credited to the operator via the engine's per-token claim flow |

## PX — Payments and creation

| ID | Mechanic | Attack vector | Sev | Mitigation / status |
| --- | --- | --- | --- | --- |
| PX-1 | Settlement in USDC | USDC blacklist hits the vault contract address → deposits/redemptions of the settlement leg freeze | H | **Accepted**: centralized-asset risk is inherent to the USDC choice in the brief; in-kind redemption (EE-6 escrow isolation) keeps non-USDC basket assets exitable. Documented, not defended |
| PX-2 | x402 metered access | Payment-flow attacks (replay, facilitator compromise) against the API layer | M | Deferred(S7): x402 is strictly off-chain (§9); contracts unaffected by any x402 failure. API treats x402 receipts per reference-implementation verification; agent-side spend limits per llm-trading-agent-security |
| PX-3 | Permissionless vault creation | Scam vaults imitating reputable operators (name/metadata spoofing) to harvest deposits | M | Deferred(S3): operator identity is the registry key, not display metadata; leaderboard and API surface registry identity first. Residual accepted — permissionless means scam vaults exist; the registry makes them distinguishable, not impossible |

## Agent-side (off-chain) — recorded, out of contract scope

| ID | Vector | Disposition |
| --- | --- | --- |
| AG-1 | Prompt injection via on-chain/token metadata read by voting agents (token names, proposal descriptions) turning into malicious votes or deposits | Operator guidance doc (S7): sanitize on-chain strings before LLM context; treat injection as a financial attack (llm-trading-agent-security) |
| AG-2 | Agent key compromise → its stake votes/exits maliciously | Contract treats every member as potentially adversarial already; no member's compromise breaks others' invariants. Guidance: dedicated hot wallets, session-scoped funds |
| AG-3 | Coordinated agent collusion (vote rings) | Equivalent to whale stake; bounded by concentration caps (VO-5) and quorum floors. Accepted residual of stake-weighted governance |

---

## Sprint 6 adversarial pass — findings and dispositions

Two independent security agents reviewed all layers (reports in `contracts/docs/reviews/`).
Confirmed findings and their fixes (regression suite `contracts/test/Sprint6Fixes.t.sol`):

**Execution/oracle/sub-vault (Agent B):**
| # | Sev | Disposition |
| --- | --- | --- |
| E1 | H | Fixed — `_childValueWad` now recurses depth-bounded so grandchild value is in root NAV (SV-7 at full depth) |
| E2 | H | Fixed — oracle `maxStaleness` upper-capped (1 day) + saturating subtraction; closes the underflow-panic honeypot |
| E3 | M | Fixed — rebalance leftover-sweep measures this-swap balance delta, no longer absorbs EE-6 escrow or donations |
| E4 | M | **Partially mitigated** — exits skip children mid-rebalance (no more deep-stack revert); but if the ONLY child holding the needed value is mid-rebalance and idle can't cover, the exit still reverts `ExitNeedsChildSettlement` (retry after the child settles, bounded by its timelock). Window narrowed, not closed |
| E5 | M | **Partially mitigated** — silent underpayment fixed (reduce by measured value); but a persistently-escrowing child (e.g. blacklisted parent address) turns into a permanent `ExitNeedsChildSettlement` revert rather than escrow-and-continue as direct holdings do. Known residual (EE-6 asymmetry for child-held slices) |
| E6 | M | Fixed — oracle floor `≥3` sources + strict-majority quorum + lower-median (no even-k swing / sum overflow) |
| E7 | M | **Documented residual** — EE-5 latency arb threshold is gas within the oracle's drift band; bounded by the new 1-day staleness ceiling + non-zero exit fee. Full closure needs oracle-enforced mint-time freshness (design option, not shipped) |
| E8 | L | Fixed — `MAX_BASKET_ASSETS = 10` bounds navWad gas; recursion depth-capped |

**Governance/economic (Agent A):**
| # | Sev | Disposition |
| --- | --- | --- |
| G1 | H | Fixed — concentration cap applies to RECEIVED (delegated) weight only; a dominant/sole holder can always reveal own weight (vaults no longer dead on arrival) |
| G2 | M | Fixed — RuleChange execute re-applies the SV-6 parent-quorum-floor inheritance |
| G3 | M | **Documented residual (CM-5)** — single-vault carry farming is possible but gated by the 1% exit-fee cap forcing ~100:1 transient capital fronting + leaderboard reputation drag; economic deterrent, not a code fix |
| G4 | L→M | Fixed — standing default must predate the proposal (`setAt < createdAt`), closing the tally-aware reveal-phase default |
| G5 | L | **Documented** — fee-assess vs carry-record are separate bounded calls; `MODULE_CALL_GAS=300k` covers the carry write; not atomic but not exploitable at current params |

**Accepted-rows re-review ([reviews/SPRINT6-GOVERNANCE-ACCEPTED-ROWS.md](reviews/SPRINT6-GOVERNANCE-ACCEPTED-ROWS.md)):** K-3/VO-2/VO-3 and snapshot soundness **hold as designed**. Two divergences handled:
| GA-1 | M | **Fixed** — a parent vault that allocated to a child was a non-voting member of the child's eligible stake, making full-consensus RuleChange permanently unreachable (froze child config). VaultCore now excludes the registered parent from all voting-eligible stake + holder counts (`parentVault()`); regression `test_childRuleChangePassesAfterParentAllocates` |
| GA-2 (VO-7) | L | See VO-7 above — mid-reveal tally readable; commit binds direction, no new exploit |

## Coverage check

Brief bullets → rows: execution (4/4), core mechanics (8/8), voting (9/9), entry/exit (11/11),
sub-vaults (7/7), safety (5/5), payments/creation (3/3), agent-side (3, extra-scope). **44 rows
+ 3 agent-side.** Zero brief bullets without a row. Rows marked "None found" or "Accepted" are
standing challenges for the Sprint 6 adversarial pass.

Sharpest known seams (Sprint 6 priority order): VO-8 (timelock × forward-pricing interplay),
SF-2 (staleness-induction cost), CM-5 (loss-carryforward self-dealing), SV-7 (look-through
pricing), EE-5 (latency arbitrage threshold vs. exit fee).
