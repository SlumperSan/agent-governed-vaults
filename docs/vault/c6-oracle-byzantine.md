# C-6 — The oracle quorum prescription is a fault-tolerance floor, silent on the Byzantine floor

The custom aggregator's "m ≥ 5, quorum ≥ 3" prescription is a **fault-tolerance** floor (sound
against benign withholdings), not a **Byzantine** one. It is silent on `quorum ≥ 2a + 1`, so two
adversarial sources plus one withholding honest leg seize the lower median and re-open C-4's theft.

## Why it matters

Critical, and **new** (Phase-2 re-verification, issue #48). It re-opens C-4's measured 88.9% theft
under a config that passes **every** constructor check. Because the tier is config/curation-
conditional an auditor may re-rate to High — but **gate 0 does not clear while it is open**. It was
surfaced by the pass that replaced the report's *inference* ("fixing C-3/H-1/H-2/M-1 removes C-4's
trigger") with an executed end-to-end test driving a **real** `OracleAggregator` into a deposit.

## Mechanism

The H-1 remediation prescribes m ≥ 5 / quorum ≥ 3 and asserts the lower median is "bounded by the
honest set." That is correct against *benign* withholdings (with `a = 0` controlled sources, `k` can
fall to 3 and the median stays honest). With lower-median selection `fresh[(k-1)/2]`
(`OracleAggregator.sol:131`, deliberately un-averaged to avoid H-1's even-`k` swing), an actor
controlling `a` sources owns the reported price once the fresh count `k ≤ 2a`. Because `k` falls to
the quorum through **ordinary withholding**, at m=5 / quorum 3 a single honest leg withholding drops
`k` to 4, and two adversarial sources then own `fresh[1]`.

**The withholding is routine, not hypothetical.** *Fail-closed at the source becomes fail-open at the
aggregator*: the honest TWAP source going quiet fails closed by the H-2 fix's own logic (a pool quiet
past `window/20` withholds), and `base-mainnet.json` records the cbETH Pyth leg live at 2549 s stale.

**Measured** (`AuditC4EndToEnd.t.sol`, real aggregator → deposit): two creator-controlled sources
depressed to 4% + the honest TWAP quiet → 1,000,000 USDC into a 2,777,762 USD claim; victim
1,000,000 → 111,124 USD (−88.9%); in-kind exit realises 733.33 wETH + 916,668 USDC. Identical to
C-4's table — because it **is** C-4, driven through the real oracle.

**The boundary, derived and asserted.** An actor controlling `a` of the fresh `k` owns the lower
median iff `k ≤ 2a`. Safety requires **`quorum ≥ 2a + 1`**; to also tolerate `f` benign withholdings,
**`m ≥ 2a + f + 1`**. At quorum 3 the config tolerates exactly `a = 1`. **No clean code fix at m=5**:
tolerating `a=2` needs quorum ≥ 5 (zero fault tolerance at m=5); genuine `a=2`-with-tolerance needs
m ≥ 7. The cheapest adversary is the vault **creator**, who chooses the source list — two sources
they control pass `MIN_SOURCES`, `MIN_MEDIAN`, the strict-majority rule, and M-1's distinctness loop.

## Status

**OPEN** at launch, but the remediation **mechanism is now complete in code**. Two parts:

1. **The safe oracle** — [[chainlinkoracle]] / [[chainlink-direct-pivot]] (PR #49): an additive
   `IOracleAggregator` that prices each asset from ONE Chainlink Data Feed — no median, no quorum, no
   per-vault source set — so C-6's median-gaming has no surface to exist (fail-closed reads, a
   per-asset sane-price band, the Base L2 sequencer-uptime guard, decimals→WAD, USDC pin; 32 tests,
   1,532 B). It deletes the whole oracle-finding class (C-3, C-4, C-6, H-1, H-2, H-3, M-1, M-14) by
   deletion.
2. **The factory oracle-gate — DONE (PR #50).** Leaving the custom `OracleAggregator` user-selectable
   re-imported C-6 for any vault that picked it. [[vaultfactory]] now carries an immutable oracle
   allowlist `allowedOracles_`: a non-empty list sets `oracleAllowlistEnforced`, and both
   `createVault`/`createChildVault` revert `OracleNotAllowed` for any non-blessed oracle; an empty
   list is permissive. Regression `AuditOracleAllowlist.t.sol`.

**Gate 0 stays NO-GO** — but on deploy config + external audit, no longer on missing code. Issue #48
remains OPEN only until (a) the mainnet deploy config populates `allowedOracles_` with the real
blessed-oracle addresses and (b) the external audit. Absent Chainlink, C-6 is a config/curation
requirement: `quorum ≥ 2a + 1`, genuinely independent sources, no single actor controlling ≥ 2.

## Regression test

`contracts/test/audit/AuditC4EndToEnd.t.sol` (7 tests: `test_safe_*` establish the `a ≤ 1` safe
boundary, `test_residual_*` + `test_c4EndToEnd_*` demonstrate the `a ≥ 2` theft;
`test_hostileConfigPassesEveryConstructorCheck` proves the hostile config is admissible).

## Links

- [[chainlinkoracle]] · [[chainlink-direct-pivot]] · [[oracleaggregator]] · [[vaultfactory]] ·
  [[oracle-sources]] · [[oracle-layer]] · [[build-vs-buy]]
- [[c4-depressed-price-theft]] · [[c3-oracle-brick]] · [[highs]] (H-1, H-2, H-3) ·
  [[audit-reverification]] · [[threat-model-commitments]] (SF-1) · [[launch-readiness-gates]] ·
  [[security-index]]
