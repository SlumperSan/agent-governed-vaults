# Launch-readiness gates

The mainnet go/no-go checklist ([LAUNCH-READINESS.md](../LAUNCH-READINESS.md)): nine gates, each with
a verifiable artifact. **Verdict: NO-GO** — gate 0 held by the open Critical [[c6-oracle-byzantine]],
gate 1 (external audit) not started.

## Why it matters

A green board measures the tests you wrote, and the tests you wrote encode the failures you already
imagined — five Criticals sat under 189 passing tests, a clean soak, and a verified deployment. And
the remediation **invalidated the evidence**: six contracts changed bytecode, so the testnet
deployment, soak, and canary results now describe *superseded* contracts. Only gates 0 and 1 speak to
safety, and both are NO-GO.

## The nine gates

| # | Gate | Verdict |
|---|---|---|
| 0 | No known unfixed Critical vulnerabilities | **NO-GO** — C-1/C-2/C-3/C-5 closed with executed evidence; C-1 closed at launch by [[root-vaults-only]]; **C-4/C-6 hold this row** (C-6 has no clean code fix at m=5; leading resolution is [[chainlink-direct-pivot]] plus a factory oracle-gate). Re-enabling sub-vaults reopens C-1. |
| 1 | External audit completed, findings remediated | **NO-GO** — not started; an AI pre-audit is not an external audit. `v0.3.0-audit` withdrawn as an engagement reference; commission a **full** review at a new tag (`v0.4.0-audit`) covering the remediation itself. |
| 2 | Testnet full lifecycle proven | **STALE** — the Base Sepolia deployment is now superseded bytecode; must be redeployed and re-run. |
| 3 | Soak drills (Mode-F + sub-vault) | **STALE** — drills exercised exactly the paths the remediation touched; re-run against the corrected contracts. |
| 4 | Live x402 settlement | **GO** (unaffected) — x402 is off-chain plus a USDC `transferWithAuthorization`; touches no contract this branch changed. The one operational gate that survives intact. |
| 5 | Mainnet oracle stack config verified | **NO-GO** — the config no longer builds: H-1 needs quorum ≥ 3 (so 5 sources/asset), H-2 needs `maxObservationAge <= window/20`. `base-mainnet.json` is **NOT-DEPLOYABLE** with a `rebuildChecklist`. |
| 6 | Canary operational | **STALE** — read-only and unchanged, but its evidence came from watching superseded contracts; re-earns alongside gate 3. |
| 7 | Ops runbook exercised (a restore performed) | **CONDITIONAL** — the backup ring shipped, but a deliberate restore drill (~30 min, no keys) has not been recorded. |
| 8 | All CI gates green | **GO** — `forge test` 252 pass / 0 fail; backend 553 (551 pass, 2 skip). Certifies the gates ran, not that the protocol is safe; `v1.0.0-launch-candidate` deliberately not cut. |

## Launch parameters (§2)

Root vaults only (the cheapest risk reduction — see [[root-vaults-only]]); first vault
`capacityCapUsdc = 50,000`; `exitFeeMaxBps = 50`; governance `3600/3600/0/86400`, quorum 2,500 bps;
oracle staleness 3,600 s per asset; **each asset now needs five price sources** (slots 4–5 carried by
operator diversity); first baskets WETH + cbETH (majors only). EIP-170: `VaultCore` runs with **1,014
B** of margin, the tight budget that governed what could be fixed in-contract.

## The path to GO (§6)

C-1 decided (root-only) · fix H-5/H-6 (need VaultCore bytes) · work H-8 + H-9 · rebuild
`base-mainnet.json` (5 sources/asset, real addresses — a human task) · re-run the drill battery +
soak, redeploy testnet · commission the external audit at a new tag · one recorded restore drill.

## Links

- [[c6-oracle-byzantine]] · [[c1-empty-electorate]] · [[c4-depressed-price-theft]] ·
  [[root-vaults-only]] · [[chainlink-direct-pivot]]
- [[highs]] (H-1, H-2, H-8) · [[audit-reverification]] · [[oracleaggregator]] · [[chainlinkoracle]] ·
  [[x402-metering]] · [[current-state]] · [[go-to-market-plan]] · [[security-index]]
