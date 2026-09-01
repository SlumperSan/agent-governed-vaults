# Security Index

The map of content for the protocol's security posture: the six Criticals, the High/Medium/Low
tiers, and the cross-cutting notes (threat model, Slither, launch gates, re-verification) that tie
findings to the code they live in and the decisions that resolved them.

## Why it matters

An AI pre-audit run against the frozen contracts on 2026-08-25 (tag `v0.3.0-audit`, commit
`ad9396d7`) produced **41 findings — 5 Critical, 9 High, 15 Medium, 7 Low, 5 Informational**. A
2026-08-27 remediation pass closed twelve; the 2026-08-28 Phase-2 re-verification then surfaced a
**sixth Critical (C-6)** by converting an *inferred* C-4 closure into an *executed* refutation. The
launch verdict is **NO-GO**: gate 0 (no unfixed Criticals) is held by C-6, and gate 1 (external
audit) has not started. Note the pre-audit carries no liability, no attestation, and does not satisfy
any audit gate — it is findings to fix before a paid engagement, not clearance to ship.

## Disposition at the root-only launch (from the report's §1 table)

- **C-1** — closed at launch by [[root-vaults-only]] (sub-vaults disabled; no internal fix exists).
- **C-2, C-3, C-5** — FIXED with regression tests.
- **C-4** — closed at `a ≤ 1` adversarial oracle sources; **RE-OPENED at `a ≥ 2` by C-6**.
- **C-6** — **OPEN (new, Phase-2, issue #48)**; resolved in code by [[chainlinkoracle]] /
  [[chainlink-direct-pivot]] (PR #49) but gate 0 stays NO-GO pending a factory oracle-gate and the
  external audit.
- **H-1..H-4** — FIXED. **H-9** — **FIXED IN CODE 2026-09-01** (was dormant; see [[highs]]).
  **H-5, H-6, H-7** — DORMANT-AT-LAUNCH (need a funded child). **H-8** — partially fixed +
  config-mitigated, and the one open High that is *reachable* at a root-only launch.
- Medium/Low tier — per the report's disposition table; see [[mediums-and-lows]].

## The pattern worth carrying

A green board measures the tests you wrote, and the tests you wrote encode the failures you already
imagined. Five Criticals sat underneath 189 passing tests, a clean multi-day soak, and a verified
deployment. **Eight documented threat-model mitigations did not hold as written** — the most
dangerous property of the package, because a reviewer who trusts the rows will not look. See
[[threat-model-commitments]].

## Links

- Criticals: [[c1-empty-electorate]] · [[c2-unbounded-governance]] · [[c3-oracle-brick]] ·
  [[c4-depressed-price-theft]] · [[c5-vote-after-exit]] · [[c6-oracle-byzantine]]
- Tiers & cross-cutting: [[highs]] · [[mediums-and-lows]] · [[threat-model-commitments]] ·
  [[slither-triage]] · [[launch-readiness-gates]] · [[audit-reverification]]
- Decisions: [[root-vaults-only]] · [[chainlink-direct-pivot]]
- Contracts: [[vaultcore]] · [[governance]] · [[oracleaggregator]] · [[chainlinkoracle]] ·
  [[oracle-sources]] · [[vaultfactory]]
- State: [[current-state]] · [[remediation-history]] · [[open-items]] · [[prs-and-issues]]
