# Go-to-Market Plan

The shape of the first mainnet launch once GO is reached: what ships, at what size, with which parameters, and how it scales from there. Everything here is contingent on clearing gate 0 (C-6) and gate 1 (external audit).

## Why it matters

Because the protocol is immutable per vault, go-to-market is expressed almost entirely as **launch parameters** — immutable choices baked in at deploy. Staging isn't a marketing decision, it's a deployment decision: "staged caps" necessarily means *staged vaults*. This note is the argued launch configuration.

## Launch configuration (argued, not asserted)

- **Topology: root vaults only, zero sub-vaults.** The cheapest risk reduction anywhere — costs nothing, waits on no redeploy. See [[root-vaults-only]].
- **Oracle: Chainlink-direct — shipped, and the launch default** ([[chainlink-direct-pivot]]). The custom aggregator is non-selectable via the factory oracle-gate and has been moved out of `contracts/src/` to `contracts/test/retired/`. C-6 is settled.
- **First `capacityCapUsdc`: 50,000 USDC.** Large enough that a 10% performance fee on plausible returns pays for operations; small enough that a total-loss event — the honest worst case for a fresh immutable protocol — is survivable and compensable.
- **First baskets: WETH + cbBTC — majors only.** Chainlink-direct requires each asset to have a genuine Chainlink **ASSET/USD** feed on Base, which is a reasonable bound for a spot index of majors and is what sets the universe. **cbETH was dropped**: Base publishes only `CBETH / ETH`, and the oracle constructor now rejects a non-USD denomination. The old `$1e-6` TWAP quantization constraint no longer applies — that was a property of the retired source.
- **Exit fee:** `exitFeeMaxBps = 50`, decay 604,800 s (7 days) — the values `base-mainnet.json` `smoke` carries. Nothing mechanically deploys them to mainnet: `Deploy.s.sol` creates no vault, the only reader of `smoke.exitFeeDecayPeriod` in a deploy position is `scripts/smoke-test.mjs` (a Base Sepolia runner defaulting to `base-sepolia.json`), and mainnet vault creation is the hand-written `factory.createVault(...)` step in DEPLOYMENT §4 — so this is the value the operator must type. 50 bps was exercised end-to-end in the soak. This line previously said 302,400 s (3.5 days); that decay was only ever run by the 25 bps soak drill vaults (`scripts/soak/soak-vaults.json`), while the 50 bps smoke vault ran 604,800 s. 3.5 d vs 7 d is an open owner launch-parameter decision; until it is made the doc states what the reference config carries, pinned by `scripts/test/config-doc-truth.test.mjs`.
- **Governance config:** `3600/3600/0/86400`, quorum 2,500 bps root floor — the values the soak ran through five full rounds. Zero timelock is defensible *because* Mode-F exits exist.
- **Oracle freshness:** a per-feed **heartbeat** sized to the Chainlink feed's own publishing cadence, plus a per-asset **sane-price band**, plus the L2 sequencer gate with its 3,600 s grace period. The old `maxObservationAge ≤ window/20` constraint was a TWAP property and no longer applies.

## Mainnet deploy sequence (Phase 3)

The C-6 oracle-gate is fully scaffolded ([#53–57]); the safe bring-up order is:
1. ~~**Populate `base-mainnet.json`**~~ — **DONE** (2026-08-29): [[chainlinkoracle]] `feedOf[asset]` is filled with real Base Chainlink feed addresses (WETH←ETH/USD, cbBTC←BTC/USD) and verified on-chain 12/12. The file is `contracts/config/base-mainnet.json`.
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

Not yet. `v1.0.0-launch-candidate` is deliberately **not cut**. The path runs through [[open-items]] — read the live list there rather than re-listing it here; as of 2026-09-02 what remains is re-running the STALE operational gates on the pivoted tree. The restore drill (gate 7) is done and that gate is GO.

## Links

- Current posture: [[current-state]] · [[open-items]] · [[launch-readiness-gates]]
- Decisions shaping the launch: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[build-vs-buy]]
- Mechanics: [[two-mode-exits]] · [[governance-commit-reveal]] · [[fees-and-carry]] · [[x402-metering]] · [[oracle-layer]]
- History: [[remediation-history]] · [[prs-and-issues]] · [[decisions-index]]
