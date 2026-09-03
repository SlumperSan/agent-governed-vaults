# Open Items

The live to-do list between now and a meaningful `v1.0.0-launch-candidate`. Everything that keeps [[current-state]] at NO-GO, plus the accepted residuals.

## Why it matters

Gate 0 and gate 1 are the only rows that speak to safety, and both are NO-GO. This note separates the launch-blocking work from the accepted residuals so nobody mistakes a documented, accepted tradeoff for an unfinished task — or vice versa.

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
4. **Re-run testnet lifecycle + soak + canary (gates 2, 3, 6).** STALE — earned against superseded bytecode. Redeploy testnet, re-run drills against the corrected contracts. See [[audit-reverification]].
5. **VaultCore-headroom sprint (issue #40).** H-5/H-6 and M-15's exit-side need `VaultCore` bytes that do not exist (**3,926 B** of margin since PR #90, up from ~283 B — corrected 2026-08-30; the 1,014 B previously recorded predates M-15's deposit overload, which spent 731 B, so this is *tighter* than the note claimed, not looser). Dormant-at-launch behind [[root-vaults-only]], but required before sub-vaults return.
6. ~~**One recorded restore drill (gate 7).**~~ **DONE — gate 7 is GO as of 2026-09-02.** Recorded Docker-free 2026-08-30, then re-run under a real Linux Docker engine with steps 1 and 6 literal (`docker compose stop/start`) in #139 (`4619f17a`), `docs/RESTORE-DRILL.md` §10; the three runbook/Compose defects that re-run surfaced are fixed in #141 (`adafdc7c`). The residuals the drill named are in the gate 7 row of [LAUNCH-READINESS.md](../LAUNCH-READINESS.md) and belong to other gates.

## Open Highs / not-mitigated

- **H-8** — partially fixed + config-mitigated; the key open High for a root-only launch.
- **M-7 — NOT mitigated.** The `proposalCooldown` floor is per-proposer and sidesteppable with a second address; the serial-proposal exit freeze stands. Accepted residual, bounded by the ≥1h commit phase.

## Accepted residuals (DORMANT / ACCEPTED — not tasks)

- **Dormant-at-launch (need a funded child):** H-5, H-6, H-7, H-9, M-5, L-6 — deferred **with** the sub-vault feature via [[root-vaults-only]].
- **Accepted design tradeoffs:** M-8 (opaque `actionHash` = MEV protection), M-9 (settlement-timing option, bounded `gain/10`), M-10 (per-address commit-reveal), L-5 (rebasing tokens, creator-disclosed), L-7 (standing-default asymmetry).
- **Residual-risk register:** immutability, oracle-freeze-beats-mispricing, **single-provider Chainlink dependency** (row 13) and **curation immobility — no oracle rotation path** (row 12), USDC depeg, x402 broadcast-not-finality — all documented in [LAUNCH-READINESS.md](../LAUNCH-READINESS.md) §4 as ship-anyway with mitigations. The old TWAP-leg and Pyth-keeper rows went away with the retired aggregator.

## Links

- Status: [[current-state]] · [[launch-readiness-gates]] · [[audit-reverification]]
- Open Criticals/Highs: [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]] · [[highs]] · [[mediums-and-lows]]
- Decisions bounding scope: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[delegatecall-split-rejected]]
- Tracking: [[prs-and-issues]] · [[go-to-market-plan]] · [[remediation-history]]
