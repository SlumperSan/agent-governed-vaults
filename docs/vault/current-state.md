# Current State

What is true right now. The launch verdict is **NO-GO** — but no longer for security reasons.

> **⚠ This note goes stale by design.** The computed, live state comes from `npm run cc` and
> [docs/NOW.md](../NOW.md); the argued go/no-go board is
> [docs/LAUNCH-READINESS.md](../LAUNCH-READINESS.md). Where they disagree with this note, they win
> and this note is what needs fixing. Corrected 2026-08-30 — the previous version predated the
> C-6 pivot shipping, the owner's audit attestation and the live Base Sepolia deploy, and asserted
> all three wrongly.

## Why it matters

This protocol is immutable at deployment, so "ship" is a one-way door. This note is the single place
to read the current posture without reconstructing it from PRs and audit prose. If a row here says
NO-GO, real money should not go in.

## Launch verdict: NO-GO — on operational gates only

Every **security** gate is cleared ([[launch-readiness-gates]]):

- **Gate 0 — no known unfixed Critical: GO (root-only).** C-1 closed at launch by
  [[root-vaults-only]] (`allowSubVaults = false`, confirmed on `Deploy.s.sol:77`); C-2, C-3 and C-5
  fixed with executed evidence; **C-6 resolved by the [[chainlink-direct-pivot]]** — the bespoke
  median was *removed*, not patched. Re-enabling sub-vaults reopens C-1.
- **Gate 1 — external audit: GO on OWNER ATTESTATION, not on independent verification.** An audit
  was commissioned at `v0.4.0-audit`; the owner has read the report and attests it surfaced **no
  major issues**. The report contains sensitive material and is **held privately** — deliberately
  not in the repo. The scope list and the Low/Informational findings have **not** been published,
  and the gate reads *findings remediated*, not *no criticals*. **Do not describe this protocol as
  "audited" without that qualifier.**
- **Gate 5 — mainnet oracle stack: GO with a named residual.** See below.

What still blocks GO is operational and needs a funded key, not more code: gates **2/3/6** (testnet
full lifecycle, soak, canary — must be re-run on the pivoted tree) and gate **7** (one recorded
restore drill, ~30 min, no keys).

## The oracle, as it actually ships

`ChainlinkOracle` ([[chainlinkoracle]]) reads **one genuine Chainlink Data Feed per asset**, with no
median, no quorum and no per-vault source set. WETH via **ETH/USD**, cbBTC via **BTC/USD**, USDC
**pinned to $1.00**, and **no cbETH** — Base publishes no cbETH/USD feed, only cbETH/ETH, which the
constructor now rejects on denomination. The mainnet config block in
`contracts/config/base-mainnet.json` is verified on-chain **12/12**; the Base Sepolia mirror verifies
**11/11**. A `VaultFactory` oracle allowlist blesses specific oracle *instances*, so the retired
aggregator cannot be selected.

**Named residual — single-provider dependency.** An **L2 sequencer uptime gate** with a grace
period, a per-feed **heartbeat**, and a **sane-price band** are the *only* defences against a wrong
Chainlink answer; there is no second source to cross-check against. A feed deprecation or freeze
fails that asset **CLOSED with no fallback** — every NAV path in a vault holding it, exits included,
reverts until the feed recovers. A vault's oracle is `immutable` and the factory allowlist gates
*creation* only, so there is **no rotation lever** (residual 12, "curation immobility"). The
sequencer guard has never run against a real uptime feed outside the fork tests.

The retired stack — `OracleAggregator.sol`, `PythSource.sol`, `UniswapV3TwapSource.sol` and the
vendored `FullMath`/`TickMath` — now lives under **`contracts/test/retired/`**, kept solely as the
C-4/C-6 exploit evidence. See [[oracleaggregator]] and [[oracle-sources]].

## Deployment state

- **Live on Base Sepolia** (testnet only; nothing has ever been broadcast to mainnet). Canonical
  address book: `contracts/config/deployments/base-sepolia.json`, every address verified on-chain.
  A vault has been created, registered and funded with a USDC deposit priced by the live
  `ChainlinkOracle`; the remaining lifecycle phases sit behind the protocol's own 4h observation
  window and ~2h of governance timelocks.
- **Config paths, since they are easy to get wrong:** the mainnet config is
  `contracts/config/base-mainnet.json` — *not* under `config/deployments/`. Only
  `base-sepolia.json` (the generated address book) lives under `config/deployments/`.

## EIP-170 headroom

Only `VaultCore` is size-constrained, and much less so since PR #90 (2026-09-01) reclaimed
3,806 B: **~4,095 B** of margin, up from ~283 B. That figure was corrected on 2026-08-30
— earlier notes recorded 1,014 B (LAUNCH-READINESS §5) and 1,182 B (the H-5/H-6 notes), both of
which predate M-15's deposit overload spending 731 B. `VaultFactory` (~21,004 B spare) and
`ChainlinkOracle` (~23,044 B spare) are **not** tight, contrary to what earlier notes assumed.
Anything `VaultCore`-shaped is now effectively closed — which is the real reason H-5/H-6 stay
deferred, over and above the sub-vault dormancy.

## Launch shape once GO is reached

Root vaults only, majors-only baskets (**WETH + cbBTC**), first `capacityCapUsdc` 50,000 USDC,
Chainlink-direct oracle. See [[go-to-market-plan]].

## Links

- Gates & evidence: [[launch-readiness-gates]] · [[audit-reverification]] · [[open-items]]
- The arc that got here: [[remediation-history]] · [[prs-and-issues]]
- Decisions in force: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[build-vs-buy]] ·
  [[delegatecall-split-rejected]] · [[continuous-autonomous-mode]]
- Findings, as history: [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]]
- Plan: [[go-to-market-plan]] · [[decisions-index]] · [[security-index]]
