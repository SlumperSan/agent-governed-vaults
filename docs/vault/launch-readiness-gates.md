# Launch-readiness gates

The **Base mainnet** go/no-go checklist ([LAUNCH-READINESS.md](../LAUNCH-READINESS.md)): nine gates,
each with a verifiable artifact. **Verdict for Base mainnet: NO-GO** — but no longer for security
reasons: every security gate is now cleared and what remains is operational. This board covers no
other chain; the Robinhood Chain mainnet deployment of 2026-09-05 was not put to it, and
§0 of the source document lists gate by gate what was and was not run there.

> **⚠ [LAUNCH-READINESS.md](../LAUNCH-READINESS.md) is authoritative; this note is a mirror.** Rows
> 0, 1 and 5 below were corrected on 2026-08-30 after the C-6 pivot shipped and the owner's audit
> attestation landed, row 7 on 2026-09-02 when the gate closed, and row 2 on 2026-09-04, after the
> lifecycle re-run on the current deployment passed 2026-09-03. Rows 3/6 are directionally right but
> read the source document (and `npm run cc`) for the live board.

## Why it matters

A green board measures the tests you wrote, and the tests you wrote encode the failures you already
imagined — five Criticals sat under 189 passing tests, a clean soak, and a verified deployment. And
the remediation **invalidated the evidence**: six contracts changed bytecode, so the soak and
canary results now describe *superseded* contracts (the testnet lifecycle has since been re-run on
the current deployment — gate 2). Only gates 0 and 1 speak to safety, and both are now **GO**
(gate 0 root-only, gate 1 owner-attested); the Base launch stays NO-GO on the OPERATIONAL gates 3/6
(soak + canary), which need the five-drill soak re-run against the current deployment with the
canary observed alongside it.

## The nine gates

| # | Gate | Verdict |
|---|---|---|
| 0 | No known unfixed Critical vulnerabilities | **GO (root-only)** — C-1 closed at launch by [[root-vaults-only]] (`allowSubVaults = false`, confirmed on `Deploy.s.sol:79`); C-2/C-3/C-5 fixed with executed evidence; **C-6 resolved by [[chainlink-direct-pivot]]** — the median was removed, not patched — plus the factory oracle-gate. Re-enabling sub-vaults reopens C-1. |
| 1 | External audit completed, findings remediated | **GO on OWNER ATTESTATION** — not on independent verification. An audit was commissioned at `v0.4.0-audit`; the owner has read the report and attests it surfaced **no major issues**. The report is **held privately** and is deliberately not in the repo. The scope list and the Low/Informational findings have **not** been published, and gate 1 says *findings remediated*, not *no criticals* — so do not describe this protocol as "audited" without that qualifier. |
| 2 | Testnet full lifecycle proven | **GO** — 2026-09-03. Redeployed at sourceCommit `8a0e1155` (factory `0xc1cb7824…9743`) and the ten-phase lifecycle re-run against it, every phase successful: `docs/evidence/testnet-lifecycle-run.json`; `LAUNCH-READINESS.md` gate 2. |
| 3 | Soak drills (Mode-F + sub-vault) | **STALE** — the five drills have not been re-run against the current deployment; the superseded-bytecode reason is retired (`LAUNCH-READINESS.md` gate 3). |
| 4 | Live x402 settlement | **GO** (unaffected) — x402 is off-chain plus a USDC `transferWithAuthorization`; touches no contract this branch changed. The one operational gate that survives intact. |
| 5 | Base mainnet oracle stack config verified | **GO with a NAMED RESIDUAL** — reshaped by the pivot. `base-mainnet.json.chainlinkOracle` prices each asset from **one genuine Chainlink Data Feed**: WETH←ETH/USD, cbBTC←BTC/USD, USDC pinned, plus the Base L2 sequencer uptime feed — verified on Base mainnet **12/12** and mirrored + verified on Base Sepolia **11/11**. **Neither verification covers chain 4663**, which has no Chainlink sequencer uptime feed at all and whose feeds publish on an 86,400 s heartbeat — exactly `MAX_HEARTBEAT` (`contracts/src/oracle/ChainlinkOracle.sol:98`), the loosest the contract permits. No cbETH: Base has no cbETH/USD feed. The "5 sources at quorum 3" requirement and the NOT-DEPLOYABLE status described the removed aggregator and no longer apply. **Residual: single-provider dependency** — heartbeat + sane-price band + sequencer gate are the *only* defences against a bad answer, a feed failure fails that asset **closed with no fallback**, and there is no rotation lever (residual 12). |
| 6 | Canary operational | **STALE** — read-only and unchanged; it closes when the canary runs against the current deployment alongside the gate-3 soak and its transitions reconcile to drill actions (`LAUNCH-READINESS.md` gate 6). |
| 7 | Ops runbook exercised (a restore performed) | **GO** — 2026-09-02. The drill is recorded in [docs/RESTORE-DRILL.md](../RESTORE-DRILL.md): first Docker-free 2026-08-30 (§5–6, addendum §9), then re-run under a real Linux Docker engine with **steps 1 and 6 literal** (`docker compose stop/start`) — the one condition this row was CONDITIONAL on — in #139 (`4619f17a`), §10. The three runbook/Compose defects that re-run surfaced are fixed in #141 (`adafdc7c`). Read the row in the source document for the residuals; each belongs to a different gate. |
| 8 | All CI gates green | **GO** — `forge test` 434 pass / 0 fail / 11 skip (445 total); backend 976 (974 pass, 2 skip). Measured 2026-09-03 at `protocol/main` `88a62fb4`; the earlier 252 / 553 figures were correct when taken and the suite has grown since. Certifies the gates ran, not that the protocol is safe; `v1.0.0-launch-candidate` deliberately not cut. |

## Launch parameters (§2)

Root vaults only (the cheapest risk reduction — see [[root-vaults-only]]); first vault
`capacityCapUsdc = 50,000`; `exitFeeMaxBps = 50`; governance `3600/3600/0/86400`, quorum 2,500 bps;
a per-feed heartbeat and sane-price band per asset; first baskets **WETH + cbBTC** (majors only —
cbETH was dropped because Base publishes no cbETH/USD feed). The "each asset needs five price
sources" line described the retired aggregator and no longer applies. EIP-170: `VaultCore` runs with
**3,926 B** of margin as of 2026-09-02, up from **~283 B** before PR #90 — corrected 2026-08-30; the 1,014 B previously recorded here predates M-15's
deposit overload, which spent 731 B. `VaultFactory` (~21,004 B spare) and `ChainlinkOracle`
(~23,044 B spare) are **not** size-constrained, contrary to what earlier notes assumed.

## The path to GO (§6)

C-1 decided (root-only) · C-6 resolved by the pivot · external audit commissioned (owner
attestation, gate 1) · `base-mainnet.json.chainlinkOracle` populated and on-chain-verified ·
**remaining:** re-run against the current deployment whichever of the operational gates 3/6 the
source document still shows short of GO. Gate 7 is closed — the restore drill is
recorded and re-run literally under Docker. H-5/H-6 stay deferred with the sub-vault (H-9 was fixed in code 2026-09-01)
feature — and with `VaultCore` at 3,926 B of margin, size is no longer what closes anything
VaultCore-shaped. The remaining reason is the sub-vault dormancy, not the byte budget.

## Links

- [[c6-oracle-byzantine]] · [[c1-empty-electorate]] · [[c4-depressed-price-theft]] ·
  [[root-vaults-only]] · [[chainlink-direct-pivot]]
- [[highs]] (H-1, H-2, H-8) · [[audit-reverification]] · [[oracleaggregator]] · [[chainlinkoracle]] ·
  [[x402-metering]] · [[current-state]] · [[go-to-market-plan]] · [[security-index]]
