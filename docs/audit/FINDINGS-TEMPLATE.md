# Findings Response Log — Template & Process

This file is the structured response log for external-audit findings. One entry per finding,
appended in the auditor's numbering order. The log — not chat, not commit messages — is the
audit trail: every finding gets a written disposition here, and nothing reported is ever fixed
silently.

## Severity scale (align with the threat model)

| Sev | Meaning |
| --- | --- |
| **Critical / High** | Loss of funds or permanent capital lockup |
| **Medium** | Value extraction or governance distortion |
| **Low** | Griefing / nuisance |
| **Informational** | Code quality, docs, gas |

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `Acknowledged` | Received, under analysis |
| `Confirmed` | Reproduced / mechanism verified by us |
| `Disputed` | We believe the mechanism does not hold — response explains why, with code refs |
| `Fixed` | Fix merged; `fix-commit` + regression test listed |
| `Accepted` | Deliberate tradeoff — response explains why, and the threat model gains/updates a row |
| `Out of scope` | Off-chain layer / already-documented residual (K-1..K-4, E4/E5/E7, G3/G5, PX-1, GA-2) — response points at the existing disposition |

Note for reviewers: the accepted residuals listed in
[README.md §7](README.md#7-known-residuals--please-pressure-test-but-dont-re-report-as-new)
are standing challenges — a finding that shows a **new consequence** beyond the documented one
is in scope and welcome (that is exactly how S1 H-1 and S6 E1 were found); a re-statement of
the documented consequence will be dispositioned `Out of scope` with a pointer.

## Entry template

```markdown
---

### [<AUDITOR-ID>] <one-line title>

- **Severity (auditor):** High | Medium | Low | Informational
- **Severity (ours, if different):** … — reasoning in Response
- **Status:** Acknowledged | Confirmed | Disputed | Fixed | Accepted | Out of scope
- **Component:** <contract>.sol : <function / line range>
- **Threat-model row(s):** <e.g. EE-6, SV-7, or "new — row added">
- **Finding summary:** <2–4 sentences, in our words — proves we understood it>

**Response:**
<Disposition rationale. For Disputed: the code path that breaks the mechanism, with
file:line. For Accepted: why the tradeoff is deliberate and what bounds the damage. For
Fixed: what changed and why this shape of fix (constructor validation / code path / docs) —
remember no admin-rescue fixes exist in this protocol (immutable posture).>

- **Fix commit:** <hash> | n/a
- **Regression test:** <test/File.t.sol::test_name> | n/a
- **Docs updated:** <ARCHITECTURE §, THREAT-MODEL row, walkthrough> | n/a
- **Verified by auditor:** pending | yes (<date>)
```

## Worked example (from the internal Sprint 6 round)

---

### [S6-E2] `maxStaleness` upper-unbounded → underflow permanently freezes the oracle

- **Severity (auditor):** High
- **Status:** Fixed
- **Component:** OracleAggregator.sol : constructor + priceWad
- **Threat-model row(s):** SF-2 (new consequence — deterministic, source-independent,
  irreversible panic, distinct from the accepted K-4 staleness freeze)
- **Finding summary:** The constructor validated only `maxStaleness > 0`; a value above
  `block.timestamp` made `block.timestamp - maxStaleness` panic-underflow in every `priceWad`
  call once the basket held assets — a permanent-lockup honeypot needing no malicious module.

**Response:**
Confirmed. Fixed both sides: constructor now requires
`0 < maxStaleness ≤ MAX_STALENESS_CEILING (1 day)` — a multi-year staleness bound is never
legitimate for a spot index — and `minUpdated` computes saturating as defense-in-depth. The
ceiling also bounds the E7 latency-arb drift window.

- **Fix commit:** (see Sprint 6 hardening series)
- **Regression test:** test/Sprint6Fixes.t.sol::test_finding2_maxStalenessCeiling,
  ::test_finding2_saturatingNoUnderflowPanic
- **Docs updated:** THREAT-MODEL "Sprint 6 adversarial pass" table (E2)
- **Verified by auditor:** yes

---

<!-- External-audit entries begin below this line. -->
