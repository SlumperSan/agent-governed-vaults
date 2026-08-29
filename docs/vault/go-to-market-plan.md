# Go-to-Market Plan

The shape of the first mainnet launch once GO is reached: what ships, at what size, with which parameters, and how it scales from there. Everything here is contingent on clearing gate 0 (C-6) and gate 1 (external audit).

## Why it matters

Because the protocol is immutable per vault, go-to-market is expressed almost entirely as **launch parameters** — immutable choices baked in at deploy. Staging isn't a marketing decision, it's a deployment decision: "staged caps" necessarily means *staged vaults*. This note is the argued launch configuration.

## Launch configuration (argued, not asserted)

- **Topology: root vaults only, zero sub-vaults.** The cheapest risk reduction anywhere — costs nothing, waits on no redeploy. See [[root-vaults-only]].
- **Oracle: Chainlink-direct as the intended launch default** ([[chainlink-direct-pivot]]), with the custom aggregator made non-deployable via the factory oracle-gate (NEXT step). Contingent on C-6 being settled.
- **First `capacityCapUsdc`: 50,000 USDC.** Large enough that a 10% performance fee on plausible returns pays for operations; small enough that a total-loss event — the honest worst case for a fresh immutable protocol — is survivable and compensable.
- **First baskets: WETH + cbETH — majors only.** The TWAP source quantizes at $1e-6, a listing constraint below ~$0.01/token; no low-priced assets until a second verification pass. (Chainlink-direct requires each asset to have a Chainlink feed — a reasonable bound for a spot index of majors.)
- **Exit fee:** `exitFeeMaxBps = 50`, decay 302,400 s (3.5 days) — the value exercised end-to-end in the soak.
- **Governance config:** `3600/3600/0/86400`, quorum 2,500 bps root floor — the values the soak ran through five full rounds. Zero timelock is defensible *because* Mode-F exits exist.
- **Oracle staleness:** 3,600 s/asset (not tighter — a tight bound drops the pull-based Pyth leg on most reads); `maxObservationAge ≤ window/20` is a hard constraint (90 s ceiling at the 1,800 s window).

## Mainnet deploy sequence (Phase 3)

The C-6 oracle-gate is fully scaffolded ([#53–57]); the safe bring-up order is:
1. **Populate `base-mainnet.json`** — fill [[chainlinkoracle]] `feedOf[asset]` config placeholders with real Base Chainlink feed addresses.
2. **`DeployChainlinkOracle.s.sol`** — deploy and test the oracle contract with verified addresses.
3. **`scripts/verify-chainlink-oracle.mjs`** — on-chain verifier confirms feeds are live and responding.
4. **Set `BLESSED_ORACLES`** — populate the factory's immutable allowlist with the verified oracle address (the gate that enables `createVault`).
5. **`Deploy.s.sol`** — mainnet deployment now succeeds (guard reverts if allowlist is empty).

Defer the bespoke [[oracleaggregator]] to a second-generation vault post-audit, pending the parent-casts-child-vote mechanism.

## Scaling path

Raise capacity by **deploying a second vault (≥250k)** only after **≥30 incident-free days** with the canary clean. Do not launch an uncapped vault. Reinstate sub-vaults only after C-1's parent-casts-child-vote mechanism is built and audited **and** the SV-* drills are re-run against corrected contracts.

## Keys & roles at launch

Deployer EOA has **no post-wiring authority** (no owner functions exist); operator identity is a per-vault leaderboard identity with member-equal weight (cannot pause/upgrade/reprice/move funds); facilitator settler is stateless and only broadcasts `transferWithAuthorization`; API host and canary are keyless/read-only. Immutability means there is no admin key to compromise — and no admin key to fix a bug with.

## Gate to GO

Not yet. `v1.0.0-launch-candidate` is deliberately **not cut**. The path runs through [[open-items]]: settle C-6, commission the external audit, rebuild the mainnet config, re-run the STALE operational gates, record a restore drill.

## Links

- Current posture: [[current-state]] · [[open-items]] · [[launch-readiness-gates]]
- Decisions shaping the launch: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[build-vs-buy]]
- Mechanics: [[two-mode-exits]] · [[governance-commit-reveal]] · [[fees-and-carry]] · [[x402-metering]] · [[oracle-layer]]
- History: [[remediation-history]] · [[prs-and-issues]] · [[decisions-index]]
