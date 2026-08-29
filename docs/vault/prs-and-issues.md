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
| **#50** | `security/c6-factory-oracle-gate` | [[vaultfactory]] immutable `allowedOracles_` allowlist; `createVault`/`createChildVault` revert `OracleNotAllowed` when enforced; `AuditOracleAllowlist.t.sol` | C-6 factory oracle-gate — completes the mechanism ([[c6-oracle-byzantine]]) |
| **#51** | `security/c6-vault` | the vault itself | C-6 ([[chainlink-direct-pivot]]) |
| **#53** | `security/deploy-guard` | `Deploy.s.sol` guard reverts if `BLESSED_ORACLES` allowlist empty on Base-mainnet | Deploy-time safety for C-6 oracle gate ([[vaultfactory]]) |
| **#54** | `security/c6-integration-tests` | `ChainlinkOracle` × `VaultCore` integration test suite | C-6 end-to-end ([[chainlinkoracle]]) |
| **#55** | `security/chainlink-config` | `base-mainnet.json` `chainlinkOracle` config block with feed placeholders; `scripts/verify-chainlink-oracle.mjs` on-chain verifier | C-6 deploy config ([[chainlinkoracle]]) |
| **#56** | `security/chainlink-fuzz` | `ChainlinkOracle` fuzz suite | C-6 property-based safety ([[chainlinkoracle]]) |
| **#57** | `docs/deployment-restructure` | `DEPLOYMENT.md` restructured: §1 deploy+verify `ChainlinkOracle` first → §2 factory with `BLESSED_ORACLES` → §3 custom oracle marked **DEFERRED** | C-6 deploy sequence ([[go-to-market-plan]]) |

Earlier (Phase 1): **#39** (`security/critical-remediation`) closed the twelve findings; **#38** was the Sprint-15 battery refresh; **#42** the medium-tier pass. See [[remediation-history]].

## Open issues

| Issue | Subject |
| --- | --- |
| **#40** | VaultCore-headroom sprint — the EIP-170 budget that blocks H-5/H-6/H-9 and M-15 exit-side |
| **#41** | Rebuild `base-mainnet.json` — 5 sources/asset at quorum 3, `maxObservationAge ≤ window/20`; human-supplied addresses |
| **#48** | C-6 tracking — remediation **mechanism now complete in code** (safe oracle #49 + factory gate #50); stays OPEN only until the mainnet deploy config populates `allowedOracles_` with real blessed-oracle addresses and the external audit clears; **gate 0 does not clear while open** |

Referenced audit issues from the pre-audit engagement: #31–#35 (the Critical filings), #32 (C-4 DiD), #33 (C-1), #34 (C-5), #24 (evidence-based launch readiness).

## Links

- What the PRs changed: [[remediation-history]] · [[current-state]] · [[open-items]]
- Merge convention: [[auto-merge]] · [[continuous-autonomous-mode]]
- Findings: [[c1-empty-electorate]] · [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]] · [[highs]] · [[security-index]]
- Decisions: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[decisions-index]]
