# Current State

What is true right now. The **Base mainnet** launch verdict is **NO-GO** (but no longer for
security reasons). Since 2026-09-05 the protocol is deployed on **Robinhood Chain
mainnet (chain 4663)**, on the owner's decision of 2026-09-04 and without that board's soak and
canary gates. No vault has been created on it yet, so nothing there holds member money.

> **⚠ This note goes stale by design.** The computed, live state comes from `npm run cc` and
> [docs/NOW.md](../NOW.md); the argued go/no-go board is
> [docs/LAUNCH-READINESS.md](../LAUNCH-READINESS.md). Where they disagree with this note, they win
> and this note is what needs fixing. Corrected 2026-08-30: the previous version predated the
> C-6 pivot shipping, the owner's audit attestation and the live Base Sepolia deploy, and asserted
> all three wrongly.

## Why it matters

This protocol is immutable at deployment, so "ship" is a one-way door. This note is the single place
to read the current posture without reconstructing it from PRs and audit prose. If a row here says
NO-GO, real money should not go in.

**And a contradiction that is stated rather than smoothed away:** on 2026-09-04 the owner decided
to deploy to Robinhood Chain mainnet and to fund it, while the board this note mirrors said
NO-GO. That verdict is about the Base mainnet launch and was not applied to chain 4663. But the
sentence above is advice, not a jurisdictional claim, and the deployment went against it. A reader
should know that and should not be left to reconcile the two from a date stamp.

## Base mainnet launch verdict: NO-GO, on operational gates only

Every **security** gate is cleared ([[launch-readiness-gates]]):

- **Gate 0: no known unfixed Critical (GO root-only).** C-1 closed at launch by
  [[root-vaults-only]] (`allowSubVaults = false`, confirmed on `Deploy.s.sol:79`); C-2, C-3 and C-5
  fixed with executed evidence; **C-6 resolved by the [[chainlink-direct-pivot]]**: the bespoke
  median was *removed*, not patched. Re-enabling sub-vaults reopens C-1.
- **Gate 1: external audit (GO on OWNER ATTESTATION, not on independent verification).** An audit
  was commissioned at `v0.4.0-audit`; the owner has read the report and attests it surfaced **no
  major issues**. The report contains sensitive material and is **held privately** (deliberately
  not in the repo). The scope list and the Low/Informational findings have **not** been published,
  and the gate reads *findings remediated*, not *no criticals*. **Do not describe this protocol as
  "audited" without that qualifier.**
- **Gate 5: mainnet oracle stack (GO with a named residual)**, earned against BASE feeds and the
  Base L2 sequencer uptime feed. It says nothing about chain 4663, which has no sequencer uptime
  feed and runs its feeds at the 86,400 s `MAX_HEARTBEAT` ceiling. See below.

What still blocks GO is operational, not more code: the operational gates **3/6** (soak, canary),
gate 2 (testnet full lifecycle) is GO since 2026-09-03, which [[launch-readiness-gates]] and
`docs/LAUNCH-READINESS.md` show short of GO until the five-drill soak is re-run against the current
deployment with the canary observed alongside it. **Gate 7 is closed**: GO as
of 2026-09-02, the restore drill recorded and then re-run literally under Docker.

## The oracle, as it actually ships

`ChainlinkOracle` ([[chainlinkoracle]]) reads **one genuine Chainlink Data Feed per asset**, with no
median, no quorum and no per-vault source set. WETH via **ETH/USD**, cbBTC via **BTC/USD**, USDC
**pinned to $1.00**, and **no cbETH**: Base publishes no cbETH/USD feed, only cbETH/ETH, which the
constructor now rejects on denomination. The mainnet config block in
`contracts/config/base-mainnet.json` is verified on-chain **12/12**; the Base Sepolia mirror verifies
**11/11**. A `VaultFactory` oracle allowlist blesses specific oracle *instances*, so the retired
aggregator cannot be selected.

**Named residual: single-provider dependency.** An **L2 sequencer uptime gate** with a grace
period, a per-feed **heartbeat**, and a **sane-price band** are the *only* defences against a wrong
Chainlink answer; there is no second source to cross-check against. A feed deprecation or freeze
fails that asset **CLOSED with no fallback**: every NAV path in a vault holding it, exits included,
reverts until the feed recovers. A vault's oracle is `immutable` and the factory allowlist gates
*creation* only, so there is **no rotation lever** (residual 12, "curation immobility"). The
sequencer guard has never run against a real uptime feed outside the fork tests. The Robinhood
Chain mainnet deployment did not change that, because Chainlink publishes no uptime feed for chain
4663 to wire.

The retired stack (`OracleAggregator.sol`, `PythSource.sol`, `UniswapV3TwapSource.sol` and the
vendored `FullMath`/`TickMath`) now lives under **`contracts/test/retired/`**, kept solely as the
C-4/C-6 exploit evidence. See [[oracleaggregator]] and [[oracle-sources]].

## Deployment state

- **Deployed on Robinhood Chain mainnet (chain 4663) on 2026-09-05**: record
  at `contracts/config/deployments/robinhood-mainnet.json`, `VaultFactory`
  `0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1`, settlement token USDG (6 dp). The singletons are
  deployed and wired; **no vault has been created on it yet**: `smokeVault` is null in that
  record and `verifiedWiring["factory.vaultCount()"]` is 0, both read from chain 4663 at block
  54,991,182, so no member funds are at stake there. Vault #1 is the creator Safe
  `0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c`'s to create.
  **No Base mainnet deployment exists.** This line previously read
  "testnet only; nothing has ever been broadcast to mainnet", which one transaction falsified.
- **Deployed on Base Sepolia** (a testnet trial, no real value at stake).
  **The committed address book now IS the current deployment**, as of 2026-09-03.
  `contracts/config/deployments/base-sepolia.json` records `sourceCommit 8a0e1155`, deploy block
  46,307,173, factory `0xc1cb7824…9743`, and the adapter it names carries both the reentrancy mutex
  (#101) and the scoped-refund fix (#108). The ten-phase lifecycle transaction table for the run
  against it is `docs/evidence/testnet-lifecycle-run.json`. One qualifier, stated in the book's
  `bytecodeCurrency` block: the sole `contracts/src/` change since `8a0e1155` is a NatSpec-only
  edit to `VaultDeployer.sol`, which under solc's default `ipfs` metadata changes that contract's
  bytecode trailer but not its opcodes and not the `VaultCore` creation code it carries. So the
  vaults are byte-identical to a `protocol/main` build. Vaults have been created, registered, funded, activated, governed and
  exited on Base Sepolia. `docs/SOAK-REPORT.md` §5 records a full loop with a transaction hash for
  every phase, including a Mode-F exit. This bullet said the remaining phases still sat behind the
  4h window and ~2h of timelocks; that was true when written and has not been since.
- **Config paths, since they are easy to get wrong:** the mainnet config is
  `contracts/config/base-mainnet.json`, *not* under `config/deployments/`. Only
  `base-sepolia.json` (the generated address book) lives under `config/deployments/`.

## EIP-170 headroom

Only `VaultCore` is size-constrained, and much less so since PR #90 (2026-09-01). Current margin
is **3,926 B**: `VaultCore` 20,650 B runtime, measured with `forge build --sizes` at
`protocol/main` on 2026-09-02. **Re-measure rather than copy that number**; no guard checks it.
Earlier figures were 4,095 B after #90 and ~283 B before it. That **~283 B** was itself a
2026-08-30 correction. Earlier notes recorded 1,014 B (LAUNCH-READINESS §5) and 1,182 B (the H-5/H-6 notes), both of
which predate M-15's deposit overload spending 731 B. `VaultFactory` (~21,004 B spare) and
`ChainlinkOracle` (~23,044 B spare) are **not** tight, contrary to what earlier notes assumed.
3,926 B is real headroom, not the ~283 B that once closed anything `VaultCore`-shaped. **Size is
therefore no longer the reason H-5/H-6 stay deferred**: the sub-vault dormancy is, and #40's
escrow-degradation design decision still does not exist. This paragraph asserted the opposite until
2026-09-02, which mattered because it made a fixable class look permanently closed.

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
