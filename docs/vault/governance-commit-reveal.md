# Governance (Commit-Reveal)

**Definition.** The proposal system in [[governance]]: members commit a hashed vote, reveal it
after a deadline, and a passing proposal executes after a timelock — the only route to
`executeRebalance` and to config changes on a [[vaultcore]]. Weighting is stake-based only at five
or more members; below `SIGNER_REGIME_BELOW` (5) `finalize` takes a signer-count-plus-stake branch,
and a `RuleChange` needs full consensus — three regimes, not one.

**Why it matters.** Governance capture is the master risk: whoever controls the vote controls the
rebalance calldata. The oracle slippage bound (H-4) is what stops capture from becoming a *drain*,
but the vote machinery itself — snapshots, quorum regimes, commit-reveal — is the first line.

## Proposal types (structurally distinct on-chain)

`enum ProposalType { Rebalance, RuleChange, ChildAllocation }`. The type is contract-fixed, not
proposer-asserted text (VO-4), and it selects the quorum regime and payload shape:

- **Rebalance** — routine; the **only** type standing defaults apply to (VO-4).
- **RuleChange** — full-consensus + timelock; the near-immutable config path (CM-8 / K-2,
  **ACCEPTED**). One permanently-offline member ⇒ rules frozen forever, by intent.
- **ChildAllocation** — parent→child capital move (dead at launch, see [[sub-vaults]]).

**One active proposal per vault at a time** (`activeProposalOf[vault]`), with a proposal cooldown
(`PROPOSAL_COOLDOWN_FLOOR = 1 hour`, cap 30 days) — this is the CM-6 spam defense.

## Commit-reveal

- Commit `hash(support, salt)`; reveal after the commit deadline. Windows are vault-configured up
  to hard caps: `COMMIT_HARD_CAP = DEFAULT_TTL - 1` (just under 72h), `REVEAL_HARD_CAP = 30 days`,
  `EXECUTION_WINDOW_HARD_CAP = 90 days`. The commit cap is the tighter one **because of T-1**, not
  because of C-2: a commit phase at or beyond `DEFAULT_TTL` outlives every standing default, so VO-3
  would be dead before the reveal window opened. See [[mediums-and-lows]].
- **Unrevealed commits are forfeit** (count as abstain) — non-revealers grief only themselves;
  the quorum denominator is not starved (VO-6). Sizing note: Kleros abandoned commit-reveal (2026)
  because voters *forget* to reveal, so reveal windows were sized generously.
- The running tally **is** readable mid-reveal (public getter + cleartext `Revealed` events), but
  the commit binds `support`, so a late revealer cannot switch direction on the partial tally — no
  new exploit beyond ordinary reveal-order visibility (VO-7 / GA-2, documented residual; full
  closure needs encrypted reveals, a deliberate v1 non-goal).

## Quorum

- Denominator = **voting-eligible stake at the proposal snapshot**, which *excludes* pending
  deposits and Mode-F-locked shares ([[two-mode-exits]]). Registered parent vaults are excluded
  too (GA-1). `QUORUM_FLOOR_BPS = 2_500` (25% protocol floor).
- **< 5 members → signer count plus stake** (`SIGNER_REGIME_BELOW = 5`). The signer regime was
  hardened (H-8): the FOR side must also clear the stake quorum (blocks near-zero-stake sybils
  passing via head count) and passes on outright FOR-stake majority (blocks dust holders locking
  out a dominant member). Regime-flip residual (buy the 5th seat) is a **listing constraint**:
  `minDepositUsdc` must be economically meaningful (CM-7, partially remediated).

## Standing defaults

Count toward tally, and **never toward quorum at five or more members** (that branch counts `revealedWeight` only, VO-2/K-3). Below `SIGNER_REGIME_BELOW` they DO bear on passage: `finalize`'s sub-five branch tests `forWeight`, which includes applied standing defaults, so a Rebalance can pass on a >50% pre-declared-default majority with **zero live reveals**. `Governance.finalize` names this asymmetry as intended, not overlooked — defaults are Rebalance-only, must predate the proposal, and only ever widen the passing set. Expire 72h after being set (`DEFAULT_TTL = 72 hours`); valid
only for Rebalance proposals; must predate the proposal (`setAt < createdAt`, G4 fix). Offline
agents auto-abstain otherwise (K-3, **ACCEPTED**).

## Delegation

Permitted; a delegate's aggregate *received* weight is capped
(`CONCENTRATION_CAP_CEILING_BPS = 5_000`, i.e. ≤50%). The cap applies to received weight only, so
a dominant/sole holder can always reveal their **own** weight (G1 fix — vaults are not dead on
arrival). Re-checked at tally time against the snapshot, not just at delegation (VO-5).

## Timelock

Post-vote, vault-configurable, `TIMELOCK_HARD_CAP = 30 days`. **Mode-F redemption queueing begins
at vote passage, not at timelock expiry** — so exit-before-execution is always available (VO-8),
the subtlest economic seam in the design.

## Module-call safety

All governance/fee/registry module calls on the exit path are gas-capped
(`MODULE_CALL_GAS = 300k`) and returndata-bounded to one word ([[safetransferlib]] /
`BoundedCall`). A broken governance module falls back to Mode I — it loses forward pricing, never
member liveness (MO-1).

## Links

- [[architecture-overview]] · [[two-mode-exits]] (Mode-F queue at passage) · [[nav-and-shares]]
  (eligible-stake snapshot) · [[fees-and-carry]] · [[sub-vaults]]
- Contracts: [[governance]] · [[vaultcore]]
- Security: [[c2-unbounded-governance]] · [[c5-vote-after-exit]] · [[threat-model-commitments]]
