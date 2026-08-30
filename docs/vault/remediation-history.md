# Remediation History

The Phase-2 arc: from a 41-finding AI pre-audit to a root-only, Chainlink-direct launch shape — twelve findings fixed in code, C-1 closed by decision, C-6 discovered and pivoted around.

## Why it matters

The remediation is itself the strongest evidence for the top residual risk — **immutability**. Every fix required a full redeploy because nothing can be patched, and the fixes changed six contracts, which invalidated the testnet deployment, the soak, and the canary evidence in one move. Reading the arc explains why so much operational evidence is now STALE ([[audit-reverification]]).

## The arc

**Pre-audit (2026-08-25, tag `v0.3.0-audit` → `ad9396d7`).** Nine specialist passes over 3,349 LoC produced **41 findings: 5 Critical, 9 High, 15 Medium, 7 Low, 5 Informational**. Verdict: NO-GO. The `v0.3.0-audit` tag is now **withdrawn** as an engagement reference (it remains a valid historical marker of the pre-remediation tree). See [[audit-reverification]].

**First remediation pass (2026-08-27, PR #39, `security/critical-remediation`).** Closed **twelve** findings with `test_remediated_*` coverage, each preserving the replaced exploit in git history:
- Criticals: C-2 (unbounded governance durations), C-3 (oracle brick), C-5 (vote-after-exit).
- Highs: H-1, H-2 (stale TWAP tick reported fresh), H-3 (the mock that couldn't detect H-2), H-4.
- Mediums: M-1, M-2 (EE-6 escrow isolation), M-3, M-4, M-11 (returndata hardening, **+336 B** reclaimed), M-12. Plus an unbounded `proposalCooldown` (C-2's shape, unfiled) capped at 30 days.
- Lows: L-1, L-2, L-3, L-4.
- **Reverted:** M-6's `proposalThresholdBps` floor — it re-introduced C-2's shape into `propose()` (a constructor cannot see live stake distribution); the freeze is pinned as a passing test.

**Phase 2 (2026-08-28).** The decision-driven closes and the re-verification:
- **C-1 → closed by decision:** [[root-vaults-only]] (`allowSubVaults = false`, PR #43). Also closes sub-vault-only Highs H-5/H-6/H-7/H-9 as a class and makes M-5/L-6 dormant.
- **H-8 → partially fixed + config-mitigated** (PR #44): de-stake-blinded the `<5`-member quorum regime.
- **M-15 → partially fixed** (PR #45): deposit-side `minSharesOut`; exit-side deferred on byte budget.
- **Dispositions swept** (PR #46): remaining Medium/Low findings dispositioned; SLITHER-TRIAGE rows corrected.
- **C-6 discovered** (PR #47): end-to-end re-verification (`AuditC4EndToEnd.t.sol`) falsified the inferred C-4 closure and surfaced the new Critical [[c6-oracle-byzantine]].
- **ChainlinkOracle shipped** (PR #49): the [[chainlink-direct-pivot]] — additive oracle that deletes the C-6 surface. NEXT step: factory oracle-gate to make the custom aggregator non-deployable.

## Byte budget — why it decided what could be fixed

`VaultCore` began the session with 1,560 B of EIP-170 margin and ended with **1,014 B** (a dated record — the live figure is **~283 B** since M-15's deposit overload spent 731 B; see [[vaultcore]]). The path was non-monotonic: H-4 cost 375 and M-4 cost 3 (→1,182); **M-11 returned 336** (→1,518); M-2 spent 504 on escrow routing. M-2 was affordable **only because M-11 came first**. H-5/H-6/H-9 and M-15's exit-side remain unfixed because they land in `VaultCore` and do not fit — which is also why the [[delegatecall-split-rejected]] was considered, then dropped once sub-vaults were disabled.

## Links

- Findings: [[security-index]] · [[c1-empty-electorate]] · [[c2-unbounded-governance]] · [[c3-oracle-brick]] · [[c4-depressed-price-theft]] · [[c5-vote-after-exit]] · [[c6-oracle-byzantine]] · [[highs]] · [[mediums-and-lows]]
- Decisions: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[delegatecall-split-rejected]] · [[build-vs-buy]]
- State: [[current-state]] · [[open-items]] · [[prs-and-issues]] · [[audit-reverification]] · [[launch-readiness-gates]]
- Contracts touched: [[vaultcore]] · [[governance]] · [[oracleaggregator]] · [[oracle-sources]] · [[vaultfactory]] · [[chainlinkoracle]] · [[safetransferlib]]
