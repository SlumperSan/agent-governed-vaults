# Open Items

The live to-do list between now and a meaningful `v1.0.0-launch-candidate`. Everything that keeps [[current-state]] at NO-GO, plus the accepted residuals.

## Why it matters

Gate 0 and gate 1 are the only rows that speak to safety, and both are NO-GO. This note separates the launch-blocking work from the accepted residuals so nobody mistakes a documented, accepted tradeoff for an unfinished task — or vice versa.

## Launch-blocking

1. **C-6 — settle the oracle mechanism.** [[c6-oracle-byzantine]] keeps gate 0 NO-GO. `ChainlinkOracle` is shipped ([[chainlink-direct-pivot]]); the **NEXT step in progress** is a factory-level oracle-gate to adopt Chainlink-direct as launch default and make the custom [[oracleaggregator]] **non-deployable** (leaving it selectable re-imports C-6). Final mechanism choice is an owner + external-auditor decision. Tracked by issue #48.
2. **External audit (gate 1).** Not started. Full review of the corrected tree at a new tag (`v0.4.0-audit`); must cover the remediation itself (six contracts changed, including the `OracleAggregator._tryLatestPrice` assembly).
3. **Rebuild `base-mainnet.json` (issue #41).** Currently **NOT-DEPLOYABLE**: needs 5 sources/asset at quorum 3 and `maxObservationAge ≤ window/20`; two further source addresses per asset are a human input. (Chainlink-direct simplifies this if adopted.)
4. **Re-run testnet lifecycle + soak + canary (gates 2, 3, 6).** STALE — earned against superseded bytecode. Redeploy testnet, re-run drills against the corrected contracts. See [[audit-reverification]].
5. **VaultCore-headroom sprint (issue #40).** H-5/H-6/H-9 and M-15's exit-side need `VaultCore` bytes that do not exist (1,014 B margin). Dormant-at-launch behind [[root-vaults-only]], but required before sub-vaults return.
6. **One recorded restore drill (gate 7).** ~30 min, no keys, doable anytime — CONDITIONAL until performed.

## Open Highs / not-mitigated

- **H-8** — partially fixed + config-mitigated; the key open High for a root-only launch.
- **M-7 — NOT mitigated.** The `proposalCooldown` floor is per-proposer and sidesteppable with a second address; the serial-proposal exit freeze stands. Accepted residual, bounded by the ≥1h commit phase.

## Accepted residuals (DORMANT / ACCEPTED — not tasks)

- **Dormant-at-launch (need a funded child):** H-5, H-6, H-7, H-9, M-5, L-6 — deferred **with** the sub-vault feature via [[root-vaults-only]].
- **Accepted design tradeoffs:** M-8 (opaque `actionHash` = MEV protection), M-9 (settlement-timing option, bounded `gain/10`), M-10 (per-address commit-reveal), L-5 (rebasing tokens, creator-disclosed), L-7 (standing-default asymmetry).
- **Residual-risk register:** immutability, oracle-freeze-beats-mispricing, USDC-depeg on the TWAP leg, shared WETH/USDC pool, Pyth pull-based keeper, x402 broadcast-not-finality — all documented as ship-anyway with mitigations.

## Links

- Status: [[current-state]] · [[launch-readiness-gates]] · [[audit-reverification]]
- Open Criticals/Highs: [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]] · [[highs]] · [[mediums-and-lows]]
- Decisions bounding scope: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[delegatecall-split-rejected]]
- Tracking: [[prs-and-issues]] · [[go-to-market-plan]] · [[remediation-history]]
