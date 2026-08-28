# PRs and Issues

The GitHub ledger for the Phase-2 remediation: which PRs landed which fixes on `protocol/main`, and which issues remain open. Repo: `github.com/SlumperSan/agent-governed-vaults` (private).

## Why it matters

In [[continuous-autonomous-mode]] with [[auto-merge]], the PR list *is* the change history — each finding is one branch, one PR, one merge. This note maps PR/issue numbers to findings so the audit prose and the git log line up.

## Merged PRs (Phase 2)

| PR | Branch | Lands | Finding(s) |
| --- | --- | --- | --- |
| **#43** | `security/c1-root-vaults-only` | `VaultFactory.allowSubVaults = false`, root-only wiring | C-1 ([[root-vaults-only]]); closes H-5/H-6/H-7/H-9 as a class |
| **#44** | `security/h8-quorum-regime` | de-stake-blind the `<5`-member quorum regime | H-8 (fix sybil pass + dust lockout) |
| **#45** | `security/m15-slippage` | deposit-side `minSharesOut` overload | M-15 (deposit side; exit-side deferred) |
| **#46** | `security/sprint20-dispositions` | disposition remaining findings; correct SLITHER-TRIAGE | Medium/Low tier |
| **#47** | `security/oracle-reverification-c6` | `AuditC4EndToEnd.t.sol`; C-4 re-verification | surfaced C-6 ([[c6-oracle-byzantine]]) |
| **#49** | `security/chainlink-oracle` | additive `ChainlinkOracle.sol` (Chainlink Data Feeds direct) | C-6 resolution ([[chainlink-direct-pivot]]) |

Earlier (Phase 1): **#39** (`security/critical-remediation`) closed the twelve findings; **#38** was the Sprint-15 battery refresh; **#42** the medium-tier pass. See [[remediation-history]].

## Open issues

| Issue | Subject |
| --- | --- |
| **#40** | VaultCore-headroom sprint — the EIP-170 budget that blocks H-5/H-6/H-9 and M-15 exit-side |
| **#41** | Rebuild `base-mainnet.json` — 5 sources/asset at quorum 3, `maxObservationAge ≤ window/20`; human-supplied addresses |
| **#48** | C-6 tracking — the oracle-curation / mechanism decision; **gate 0 does not clear while open** |

Referenced audit issues from the pre-audit engagement: #31–#35 (the Critical filings), #32 (C-4 DiD), #33 (C-1), #34 (C-5), #24 (evidence-based launch readiness).

## Links

- What the PRs changed: [[remediation-history]] · [[current-state]] · [[open-items]]
- Merge convention: [[auto-merge]] · [[continuous-autonomous-mode]]
- Findings: [[c1-empty-electorate]] · [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]] · [[highs]] · [[security-index]]
- Decisions: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[decisions-index]]
