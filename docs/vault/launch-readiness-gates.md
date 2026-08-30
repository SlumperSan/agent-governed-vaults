# Launch-readiness gates

The mainnet go/no-go checklist ([LAUNCH-READINESS.md](../LAUNCH-READINESS.md)): nine gates, each with
a verifiable artifact. **Verdict: NO-GO** — but no longer for security reasons: every security gate
is now cleared and what remains is operational.

> **⚠ [LAUNCH-READINESS.md](../LAUNCH-READINESS.md) is authoritative; this note is a mirror.** Rows
> 0, 1 and 5 below were corrected on 2026-08-30 after the C-6 pivot shipped and the owner's audit
> attestation landed. Rows 2/3/6/7 are directionally right but read the source document (and
> `npm run cc`) for the live board.

## Why it matters

A green board measures the tests you wrote, and the tests you wrote encode the failures you already
imagined — five Criticals sat under 189 passing tests, a clean soak, and a verified deployment. And
the remediation **invalidated the evidence**: six contracts changed bytecode, so the testnet
deployment, soak, and canary results now describe *superseded* contracts. Only gates 0 and 1 speak to
safety, and both are NO-GO.

## The nine gates

| # | Gate | Verdict |
|---|---|---|
| 0 | No known unfixed Critical vulnerabilities | **GO (root-only)** — C-1 closed at launch by [[root-vaults-only]] (`allowSubVaults = false`, confirmed on `Deploy.s.sol:77`); C-2/C-3/C-5 fixed with executed evidence; **C-6 resolved by [[chainlink-direct-pivot]]** — the median was removed, not patched — plus the factory oracle-gate. Re-enabling sub-vaults reopens C-1. |
| 1 | External audit completed, findings remediated | **GO on OWNER ATTESTATION** — not on independent verification. An audit was commissioned at `v0.4.0-audit`; the owner has read the report and attests it surfaced **no major issues**. The report is **held privately** and is deliberately not in the repo. The scope list and the Low/Informational findings have **not** been published, and gate 1 says *findings remediated*, not *no criticals* — so do not describe this protocol as "audited" without that qualifier. |
| 2 | Testnet full lifecycle proven | **STALE** — the Base Sepolia deployment is now superseded bytecode; must be redeployed and re-run. |
| 3 | Soak drills (Mode-F + sub-vault) | **STALE** — drills exercised exactly the paths the remediation touched; re-run against the corrected contracts. |
| 4 | Live x402 settlement | **GO** (unaffected) — x402 is off-chain plus a USDC `transferWithAuthorization`; touches no contract this branch changed. The one operational gate that survives intact. |
| 5 | Mainnet oracle stack config verified | **GO with a NAMED RESIDUAL** — reshaped by the pivot. `base-mainnet.json.chainlinkOracle` prices each asset from **one genuine Chainlink Data Feed**: WETH←ETH/USD, cbBTC←BTC/USD, USDC pinned, plus the Base L2 sequencer uptime feed — verified on Base mainnet **12/12** and mirrored + verified on Base Sepolia **11/11**. No cbETH: Base has no cbETH/USD feed. The "5 sources at quorum 3" requirement and the NOT-DEPLOYABLE status described the removed aggregator and no longer apply. **Residual: single-provider dependency** — heartbeat + sane-price band + sequencer gate are the *only* defences against a bad answer, a feed failure fails that asset **closed with no fallback**, and there is no rotation lever (residual 12). |
| 6 | Canary operational | **STALE** — read-only and unchanged, but its evidence came from watching superseded contracts; re-earns alongside gate 3. |
| 7 | Ops runbook exercised (a restore performed) | **CONDITIONAL** — the backup ring shipped, but a deliberate restore drill (~30 min, no keys) has not been recorded. |
| 8 | All CI gates green | **GO** — `forge test` 252 pass / 0 fail; backend 553 (551 pass, 2 skip). Certifies the gates ran, not that the protocol is safe; `v1.0.0-launch-candidate` deliberately not cut. |

## Launch parameters (§2)

Root vaults only (the cheapest risk reduction — see [[root-vaults-only]]); first vault
`capacityCapUsdc = 50,000`; `exitFeeMaxBps = 50`; governance `3600/3600/0/86400`, quorum 2,500 bps;
a per-feed heartbeat and sane-price band per asset; first baskets **WETH + cbBTC** (majors only —
cbETH was dropped because Base publishes no cbETH/USD feed). The "each asset needs five price
sources" line described the retired aggregator and no longer applies. EIP-170: `VaultCore` runs with
**~283 B** of margin — corrected 2026-08-30; the 1,014 B previously recorded here predates M-15's
deposit overload, which spent 731 B. `VaultFactory` (~21,004 B spare) and `ChainlinkOracle`
(~23,044 B spare) are **not** size-constrained, contrary to what earlier notes assumed.

## The path to GO (§6)

C-1 decided (root-only) · C-6 resolved by the pivot · external audit commissioned (owner
attestation, gate 1) · `base-mainnet.json.chainlinkOracle` populated and on-chain-verified ·
**remaining:** re-run the testnet lifecycle, soak and canary on the pivoted tree (gates 2/3/6, need
a funded key) and one recorded restore drill (gate 7). H-5/H-6/H-9 stay deferred with the sub-vault
feature — and with `VaultCore` at ~283 B of margin, anything VaultCore-shaped is now effectively
closed.

## Links

- [[c6-oracle-byzantine]] · [[c1-empty-electorate]] · [[c4-depressed-price-theft]] ·
  [[root-vaults-only]] · [[chainlink-direct-pivot]]
- [[highs]] (H-1, H-2, H-8) · [[audit-reverification]] · [[oracleaggregator]] · [[chainlinkoracle]] ·
  [[x402-metering]] · [[current-state]] · [[go-to-market-plan]] · [[security-index]]
