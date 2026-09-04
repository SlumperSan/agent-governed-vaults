# Open Items

The live to-do list between now and a meaningful `v1.0.0-launch-candidate`. Everything that keeps [[current-state]] at NO-GO, plus the accepted residuals.

## Why it matters

Gate 0 and gate 1 are the rows that speak to safety, and both are **GO** — gate 0 root-only (C-6 resolved by the Chainlink pivot), gate 1 on owner attestation. The launch is still NO-GO, but on the OPERATIONAL gates (3/6, soak + canary), which need the five-drill soak re-run against the current deployment (the owner holds the runbook). This note separates the launch-blocking work from the accepted residuals so nobody mistakes a documented, accepted tradeoff for an unfinished task — or vice versa.

## Launch-blocking

> **⚠ Items 1–3 are CLOSED** (corrected 2026-08-30) and **item 6 is CLOSED** (2026-09-02, gate 7).
> They are kept here because the reasoning is still worth reading; the live list is items 4 and 5
> plus [docs/NOW.md](../NOW.md).

1. ~~**C-6 — settle the oracle mechanism.**~~ **DONE.** `ChainlinkOracle` shipped
   ([[chainlink-direct-pivot]]) *and* the factory oracle-gate landed (#50), so the retired
   [[oracleaggregator]] is non-selectable — it has since been moved out of `contracts/src/`
   entirely, to `contracts/test/retired/`. Gate 0 is **GO (root-only)**.
2. ~~**External audit (gate 1).**~~ **DONE, with a qualifier.** Commissioned at `v0.4.0-audit`; the
   owner has read the report and attests **no major issues**. The report is held privately, and the
   scope list plus the Low/Informational findings have not been published — so this is an *owner
   attestation*, not independent verification. Do not say "audited" unqualified.
3. ~~**Rebuild `base-mainnet.json` (issue #41).**~~ **DONE.** The `chainlinkOracle` block is
   populated with real Base feed addresses and verified on-chain **12/12**
   (`scripts/verify-chainlink-oracle.mjs`). The "5 sources/asset at quorum 3" requirement described
   the retired aggregator and no longer applies. The file is at `contracts/config/base-mainnet.json`
   — note the path: only `base-sepolia.json` lives under `config/deployments/`.
4. **Re-run soak + canary (gates 3, 6).** STALE — earned against superseded bytecode. Gate 2 (testnet lifecycle) is **GO**: the ten-phase lifecycle was re-run against the current Base Sepolia deployment (sourceCommit `8a0e1155`, factory `0xc1cb7824…9743`) and passed 2026-09-03 — `docs/evidence/testnet-lifecycle-run.json`, `docs/LAUNCH-READINESS.md` gate 2. What remains is the soak drills and the canary against that same deployment ([[Soak Restart 2026-09-04]]). See [[audit-reverification]].
5. **VaultCore-headroom sprint (issue #40).** H-5/H-6 and M-15's exit-side once needed `VaultCore` bytes that did not exist. **They now fit**: the margin is **3,926 B** (2026-09-02), up from ~283 B before PR #90. What still defers them is the sub-vault dormancy and #40's absent escrow-degradation design decision, not the byte budget. This entry read "bytes that do not exist" and called the budget *tighter* than earlier notes claimed; both were true against ~283 B and are backwards against 3,926 B. Dormant-at-launch behind [[root-vaults-only]], but required before sub-vaults return.
6. ~~**One recorded restore drill (gate 7).**~~ **DONE — gate 7 is GO as of 2026-09-02.** Recorded Docker-free 2026-08-30, then re-run under a real Linux Docker engine with steps 1 and 6 literal (`docker compose stop/start`) in #139 (`4619f17a`), `docs/RESTORE-DRILL.md` §10; the three runbook/Compose defects that re-run surfaced are fixed in #141 (`adafdc7c`). The residuals the drill named are in the gate 7 row of [LAUNCH-READINESS.md](../LAUNCH-READINESS.md) and belong to other gates.

## Open Highs / not-mitigated

- **H-8** — partially fixed + config-mitigated; the key open High for a root-only launch.
- **M-7 — NOT mitigated.** The `proposalCooldown` floor is per-proposer and sidesteppable with a second address; the serial-proposal exit freeze stands. Accepted residual, bounded by the ≥1h commit phase.

## Accepted residuals (DORMANT / ACCEPTED — not tasks)

- **Dormant-at-launch (need a funded child):** H-5, H-6, H-7, M-5, L-6 — deferred **with** the sub-vault feature via [[root-vaults-only]]. **H-9 has left this list:** still dormant, but FIXED IN CODE 2026-09-01 and therefore not deferred — see [[highs]].
- **Accepted design tradeoffs:** M-8 (opaque `actionHash` = MEV protection), M-9 (settlement-timing option, bounded `gain/10`), M-10 (per-address commit-reveal), L-5 (rebasing tokens, creator-disclosed), L-7 (standing-default asymmetry).
- **Residual-risk register:** immutability, oracle-freeze-beats-mispricing, **single-provider Chainlink dependency** (row 13) and **curation immobility — no oracle rotation path** (row 12), USDC depeg, x402 broadcast-not-finality — all documented in [LAUNCH-READINESS.md](../LAUNCH-READINESS.md) §4 as ship-anyway with mitigations. The old TWAP-leg and Pyth-keeper rows went away with the retired aggregator.

## Links

- Status: [[current-state]] · [[launch-readiness-gates]] · [[audit-reverification]]
- Open Criticals/Highs: [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]] · [[highs]] · [[mediums-and-lows]]
- Decisions bounding scope: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[delegatecall-split-rejected]]
- Tracking: [[prs-and-issues]] · [[go-to-market-plan]] · [[remediation-history]]
