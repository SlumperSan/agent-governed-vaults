# Audit re-verification

The Phase-2 re-verification pass (2026-08-28) that took the remediation's *inferred* closures and
re-tested them end-to-end against real code — and in doing so converted an inferred C-4 closure into
an executed refutation, surfacing the new Critical [[c6-oracle-byzantine]] (issue #48).

## Why it matters

The original remediation closed C-4 by **inference**: "fixing C-3/H-1/H-2/M-1 removes C-4's trigger."
That reasoning built `VaultCore` over a directly-set `MockOracle` — it never drove the *real*
`OracleAggregator`. The re-verification did its job: it replaced the argument with an executed test
and found the inference false at `a ≥ 2` adversarial sources. This is the discipline the whole
audit turns on — an inferred closure is not an executed one.

## What it found

Driving a real `OracleAggregator` into a `VaultCore` deposit (`AuditC4EndToEnd.t.sol`, 7 tests):

- Against a correctly-curated oracle (≥5 genuinely-independent sources, `a ≤ 1`) the trigger **is**
  gone — a single adversarial source can never move the lower median, verified down to quorum
  (`test_safe_oneControlledSource_medianHoldsAsHonestLegsWithhold`).
- But **two** adversarial sources + one withholding honest leg seize `fresh[1]` and re-open C-4's
  measured 88.9% theft, through the real aggregator
  (`test_residual_twoControlledSources_oneHonestWithholds_k4/_k3`). Identical to C-4's table — because
  it is C-4.
- The hostile config (two creator-controlled sources at quorum 3) passes **every** constructor check
  (`test_hostileConfigPassesEveryConstructorCheck`).

The boundary: an actor controlling `a` of the fresh `k` owns the lower median iff `k ≤ 2a`; safety
requires `quorum ≥ 2a + 1` and, with `f` benign withholdings, `m ≥ 2a + f + 1`. See
[[c6-oracle-byzantine]] for the full derivation.

## The companion faithful-mock pass

`AuditTwapFaithfulMock.t.sol` (8 tests + `FaithfulUniV3Pool.sol`, an independent v3-core `Oracle.sol`
port) confirms the H-2 fix holds against faithful observation-ring semantics — closing H-3's
test-blindness for the reachable dimensions.

## The qualified test buckets

The `test_finding_*` / `test_residual_*` cases that pass by executing an exploit span three
buckets, so any "N passing tests" figure must carry the qualifier. These buckets are as of this
re-verification (pre-pivot); C-6 has since been resolved — see Consequence below:

1. **Unreachable at launch by configuration** — the sub-vault suite; `AuditRootVaultsOnly` (C-1).
2. **Config-mitigated residual** — `AuditQuorumRegimeDust` (H-8 attack a).
3. **Was a live open finding at the re-verification** — `AuditC4EndToEnd` (C-6), since RESOLVED by
   the Chainlink-direct pivot; the test is retained as retired-aggregator exploit evidence.

## Consequence

Four of five original Criticals are closed with executed evidence (`AuditRootVaultsOnly`,
`Governance::test_phaseDurationHardCapsEnforced`, `AuditAggregatorDecodeBrick`, `AuditVoteAfterExit`).
**C-4/C-6 kept gate 0 NO-GO at the time of this re-verification.** They have since been resolved by
[[chainlink-direct-pivot]] — consuming Chainlink Data Feeds directly deleted most of the oracle-finding
class — and gate 0 is now **GO (root-only)** per LAUNCH-READINESS.md. This section records the
re-verification state before the pivot; read it as history.

## Links

- [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]] · [[c1-empty-electorate]] · [[highs]] (H-2,
  H-3, H-8) · [[chainlink-direct-pivot]] · [[chainlinkoracle]]
- [[oracleaggregator]] · [[oracle-sources]] · [[launch-readiness-gates]] ·
  [[threat-model-commitments]] · [[remediation-history]] · [[security-index]]
