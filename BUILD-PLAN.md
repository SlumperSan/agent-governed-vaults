# Agent-Governed Index Vault Protocol: Phased Build Plan

Status: **plan only, no code written.** Sprint 0 is blocked on one decision (§1).

---

## 1. Blocking decision: repository state

The working tree is bare. `git status` shows **15,606 uncommitted deletions** (the entire
prior x402-analytics project) while `HEAD` (`36113b4`) still contains all of it. Current
branch is `master`; the repo's main branch is `main`.

This is indistinguishable from an accidental deletion. Nothing is scaffolded, committed,
or restored until the user picks one of:

| Option | Effect |
| --- | --- |
| **A. Commit the clearing** on a new branch (`protocol/main`) | Deletion becomes an explicit, revertable commit. Prior work stays reachable at `36113b4`. |
| **B. Restore HEAD, build in a subdirectory** (`vault-protocol/`) | Analytics project returns; new protocol lives beside it in one repo. |
| **C. Orphan branch** (`git checkout --orphan protocol`) | Clean history for the new protocol, old history preserved on `master`. |

No `git add -A`, no `git checkout .`; both destroy information about which state was intended.

---

## 2. Sprint 0: prerequisites (mechanical, light model)

- Foundry install on Windows (`foundryup` via git-bash, or `scoop install foundry`); **not currently present**.
- Monorepo scaffold, npm workspaces:
  - `contracts/`: Foundry, Solidity ^0.8.26
  - `packages/indexer/`: viem + Postgres event indexer
  - `apps/api/`: x402-metered read API
  - `apps/web/`: frontend (last)
  - `docs/`: architecture, threat model, ADRs
- CI: `forge fmt --check`, `forge build`, `forge test`, slither, gas snapshot diff.
- Solc pinned, `via-ir` on, no floating pragmas.

Gate: scaffold builds green. → approval.

---

## 3. Architectural commitments (decided now, cheap now / expensive later)

**C-1: Not ERC-4626.** In-kind redemption, swing pricing and forward pricing each break
`previewRedeem`'s round-trip guarantee. We ship 4626-*shaped* read-only views for tooling
compatibility and make **no compliance claim**. Locking this now prevents an accounting rewrite.

**C-2: Chain-agnostic from day one.** No `block.number` as a clock (use `block.timestamp`),
no hardcoded token or router addresses, no L2-specific precompiles, no `CREATE2` salt
assumptions tied to one chain's deployer. All venue contact goes through `IExecutionAdapter`.
Base DEX aggregation is *an adapter*, not a base class.

**C-3: VaultCore takes an immutable `IOperatorRegistry` reference at construction**, even
though the registry itself ships in Sprint 3 (stubbed in Sprint 1). That single reference is
load-bearing for three separate requirements: HWM portability across vaults (CM-4), leaderboard
integrity (SF-4/SF-5), and anti-Sybil (an operator who can mint a fresh identity sheds bad
history, which defeats "no cherry-picking" outright). Omitting the hook in Sprint 1 means
rewriting VaultCore in Sprint 3.

**C-4: Two-mode exit accounting.** See §4, contradiction K-1. Shares burn at *settlement*,
not at request; an exit with no passed-and-pending proposal settles in the same transaction
(indistinguishable from instant), otherwise it queues to post-rebalance NAV.

**C-5: Module split** (each independently testable, risk-ordered):

```
VaultCore ......... shares, NAV, deposits, redemptions, capacity  [Sprint 1]
Governance ........ commit-reveal, quorum, delegation, timelock   [Sprint 2]
FeeEngine ......... performance fee, per-(member,operator) HWM    [Sprint 3]
OperatorRegistry .. identity, cross-vault marks, leaderboard      [Sprint 3]
OracleAggregator .. median sourcing, staleness breaker            [Sprint 4]
IExecutionAdapter . venue abstraction + BaseAggregatorAdapter     [Sprint 4]
SubVaultRegistry .. depth, recursion block, fee-stack cap         [Sprint 5]
```

---

## 4. Contradictions in the brief: surfaced, not silently resolved

**K-1: "Instant exit at pro-rata NAV" vs. forward pricing.** These cannot both hold
unconditionally. Resolution shipped as commitment C-4 and documented as an explicit assumption
in the architecture doc. This is an accounting decision that lands in Sprint 1 and is expensive
to reverse in Sprint 4.

**K-2: Full-consensus rule changes are unreachable when any agent is offline.** "Immutable
except full consensus plus timelock" (CM-8) composed with "offline agents auto-abstain" (VO-1)
means one unreachable member permanently freezes the rule set. Read as intentional (rules are
meant to be near-immutable), but named explicitly rather than patched.

**K-3: Standing-defaults liveness floor.** Defaults count toward tally but never quorum (VO-2).
A vault where every member relies on defaults can therefore never pass anything. Intentional
liveness requirement; documented, not mitigated.

**K-4: Oracle breaker traps exits.** SF-2 freezes exits during staleness. This is a stated
tradeoff, not an oversight: an attacker who can induce staleness can trap capital. **No escape
hatch will be added.** Multi-source median (SF-1) is the mitigation. Flagged directly to the
Sprint 1 contract agent, because the instinct will be to "fix" it.

**Resolved by composition, no user input needed:**

- HWM key = `(member, operator)`. The hard part is the trusted cross-vault registry, not the semantics.
- Quorum denominator = stake *eligible* to vote (excludes observation-window sequestered capital,
  which by EE-2 has no voting rights); numerator = actively cast votes; standing defaults enter
  the tally numerator only.
- Creator 5% (CM-1) is a **withdrawal gate**, not a top-up obligation. Passive dilution below 5%
  by others' deposits is allowed and simply freezes creator withdrawals.
- Exit fee is waived when no members remain, since it can never route to the operator (EE-9).
- The 5-member boundary (CM-7) is a manipulation surface in both directions: Sybil in to cross
  it, exit to drop below. Gets its own threat-model rows.

---

## 5. Sprint 1: the deliverable

Three artifacts, in this order:

**1.1 `docs/ARCHITECTURE.md`**: module boundaries, state layout, NAV/share math with the
forward-pricing and swing-pricing formulas written out, upgrade posture (none: immutable
implementation, timelocked config only), and every assumption from §3–§4 stated inline.

**1.2 `docs/THREAT-MODEL.md`**: the pass criterion is **traceability, not insight**. Every
bullet in the brief gets an ID and a row: mechanic → attack vector → mitigation or accepted risk.
Rows are mandatory even where the answer is "no vector identified"; otherwise the dull mechanics
(capacity caps, in-kind redemption, leaderboard integrity) get silently skipped while the
interesting ones (commit-reveal, HWM, swing pricing) absorb all the attention. ID families:

```
EX-1..4   execution / adapters      CM-1..8   core mechanics
VO-1..9   voting                    EE-1..11  entry / exit
SV-1..7   sub-vaults                SF-1..5   safety
PX-1..3   payments (USDC, x402, permissionless creation)
```

~40 rows. Acceptance: diff the ID list against the brief, zero gaps.

**1.3 `contracts/src/VaultCore.sol` + tests**: shares and NAV accounting, deposit with
4-hour observation window (EE-1..4), redemption with two-mode settlement (C-4), in-kind
redemption path, exit fee with tenure decay routed to remaining members, per-vault capacity
cap, creator stake withdrawal gate, immutable `IOperatorRegistry` reference (C-3, stub).
Governance, fees and oracles are **interfaces only** this sprint.

Tests: unit plus a `forge` invariant suite. Core invariants to assert:

- no deposit or redemption mints/burns shares at a NAV the actor could have front-run
- `Σ member shares == totalSupply` across every path
- creator shares never fall below 5% *by creator action* while members remain
- exit fee never leaves the vault to the operator; NAV/share is non-decreasing for remainers on exit
- sequestered capital is never counted in voting-eligible stake

**Sprint 1 concurrency: one background agent, not three.** Research (x402 payment-flow
specifics, Base aggregator router interfaces, vault-governance prior art) is the only genuinely
non-blocking piece. The threat model depends on the architecture doc; VaultCore depends on both.

| Work | Department | Model tier |
| --- | --- | --- |
| Architecture doc | Contracts / economic design | heavy |
| Threat model | Security review | heavy |
| VaultCore + invariants | Contracts | heavy |
| Test boilerplate, fixtures, NatSpec | Contracts | light |
| x402 / router / prior-art research | Research | light–mid, background, parallel |

**STOP at the Sprint 1 boundary. No Sprint 2 work without approval.**

---

## 6. Sprints 2–9 (shape only; each re-planned at its gate)

| # | Scope | Departments | Concurrency |
| --- | --- | --- | --- |
| 2 | Governance: commit-reveal + reveal-deadline forfeiture, quorum incl. <5-member signer mode, delegation with concentration cap, standing defaults with 72h expiry, timelock ≤30d | Contracts (heavy), Security (heavy) | 2 |
| 3 | FeeEngine + OperatorRegistry: 10% realized-profit fee, `(member,operator)` HWM, cross-vault mark portability, leaderboard with no-cherry-pick enforcement | Contracts (heavy), Security (heavy) | 2 |
| 4 | OracleAggregator (median + staleness breaker), `IExecutionAdapter`, Base DEX aggregation adapter | Contracts (heavy), Research (light) | 2 |
| 5 | Sub-vaults: depth cap 3, contract-level recursion block, stacked-fee cap, parent-redemption liquidity ordering, inherited quorum floors | Contracts (heavy), Security (heavy) | 2 |
| 6 | Adversarial review pass: fuzz, invariant, economic attack simulation, external-audit prep package | Security (heavy) ×2 + Contracts | 3 |
| 7 | Indexer + x402-metered API | Backend (mid), Research (light) | 2 |
| 8 | Frontend: vault explorer, proposal UI, cumulative-effective-fee display (SV-4), operator leaderboard | Frontend (light–mid) | 3 |
| 9 | Testnet deployment, canary monitoring, audit handoff | All | 2 |

Rule held throughout: economic invariants and contract logic first, UI last; max three
concurrent agents; approval gate at every sprint boundary.
