# Current State

What is true right now. The live branch is `protocol/main`; the launch verdict is **NO-GO**. Snapshot as of the Phase-2 remediation and the C-6 / ChainlinkOracle pivot (2026-08-28).

## Why it matters

This protocol is immutable at deployment, so "ship" is a one-way door. This note is the single place to read the current go/no-go posture without reconstructing it from PRs and audit prose. If a row here says NO-GO, real money should not go in.

## Launch verdict: NO-GO

Two gates keep it there ([[launch-readiness-gates]]):

- **Gate 0 — no known unfixed Critical: NO-GO, on C-6.** Four of five original Criticals are closed with **executed** evidence: C-1 ([[root-vaults-only]]), C-2, C-3, C-5. C-4/C-6 keep the row NO-GO — the Phase-2 re-verification (`AuditC4EndToEnd.t.sol`) falsified the inferred "C-4 path closed" claim and surfaced **C-6** ([[c6-oracle-byzantine]]): at `a ≥ 2` adversarial oracle sources the theft re-opens. C-6 has no clean code fix at m=5; the leading resolution is the [[chainlink-direct-pivot]].
- **Gate 1 — external audit: NO-GO.** Not started, and nothing in these sessions could change it — an AI pre-audit is not an external audit. Commission a **full** review of the corrected tree at a new tag (`v0.4.0-audit` recommended); it must also cover the remediation itself.

## Branch and evidence state

- **Live branch:** `protocol/main`. Remediation lands via [[auto-merge]] per-finding PRs.
- **Merged (Phase 2):** #43 (C-1 root-vaults-only), #44 (H-8), #45 (M-15), #46 (dispositions), #47 (C-6 re-verification), #49 (ChainlinkOracle). See [[prs-and-issues]].
- **Open issues:** #40 (VaultCore-headroom sprint), #41 (rebuild `base-mainnet.json`), #48 (C-6 tracking).
- **CI (gate 8): GO.** Full battery green — `forge fmt --check`, `forge build --sizes`, `forge test`, `forge snapshot --check`, and the backend suite all pass. (The last recorded `forge test` count was 252 pass / 0 fail / 0 skip on the 2026-08-27 remediation branch; later PRs added tests, so treat the count as indicative, not a live `protocol/main` figure — forge was not re-run here.) Green certifies the gates *ran*, not that the protocol is safe.
- **Evidence STALE:** the remediation changed six contracts, so gates 2 (testnet lifecycle), 3 (soak), and 6 (canary) are re-marked STALE — their reports describe superseded bytecode. Gate 4 (live x402 settlement) is the one operational gate that survives intact. See [[audit-reverification]].
- **`base-mainnet.json`: NOT-DEPLOYABLE** — the config no longer builds against the hardened constructors (needs 5 sources/asset at quorum 3, `maxObservationAge ≤ window/20`); real addresses are a human input.

## Launch shape once GO is reached

Root vaults only, majors-only baskets (WETH + cbETH), first `capacityCapUsdc` 50,000 USDC, Chainlink-direct oracle as the intended launch default. See [[go-to-market-plan]].

## Links

- Gates & evidence: [[launch-readiness-gates]] · [[audit-reverification]] · [[open-items]]
- The arc that got here: [[remediation-history]] · [[prs-and-issues]]
- Decisions in force: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[build-vs-buy]] · [[delegatecall-split-rejected]] · [[continuous-autonomous-mode]]
- Open Criticals: [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]]
- Plan: [[go-to-market-plan]] · [[decisions-index]] · [[security-index]]
