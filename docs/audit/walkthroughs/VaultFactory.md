# Walkthrough — VaultFactory.sol

**Risk: Medium.** ~120 LoC. `contracts/src/VaultFactory.sol`.

> **Sprint 7 change (#10).** The factory no longer writes `new VaultCore(...)`. It encodes
> the constructor arguments and calls `vaultDeployer.deploy(...)`, an immutable address pinned
> at construction. This was forced by EIP-170 — VaultCore's creation code alone exceeds the
> runtime cap, so the factory could not be deployed at all (27,241 B). Read
> [VaultDeployer.md](VaultDeployer.md) alongside this file; **the trust chain is unchanged**,
> it just has one more link: factory → its one pinned deployer → VaultCore creation code.

## Purpose

Permissionless canonical deployment + attestation. The factory is what makes the registry
trustworthy (CM-5/SF-4/PX-3): only vaults deployed here get attested, so carry marks and
leaderboard rows can only be produced by real, visible, protocol-shaped vaults. Creation is
fully permissionless — attestation is automatic and identity-keyed (to `msg.sender` as
operator), never curated.

## What it fixes at deployment

Every vault it deploys gets the **same immutable protocol singletons** (registry, governance,
feeEngine, subVaultRegistry — all immutable on the factory itself) plus the **creator's
choices** from `VaultParams`: usdc, basket, oracle, capacity cap, min deposit, exit-fee
ceiling + decay, adapter allowlist. `msg.sender` becomes the vault's `creator` (the 5% gate
binds to this identity) and its attested operator.

**The oracle is the one creator choice the factory curates (C-6).** A sixth constructor argument,
`allowedOracles_`, fixes a blessed set; `oracleAllowlistEnforced` is `allowedOracles_.length > 0`,
and while enforced `_requireAllowedOracle` reverts `OracleNotAllowed()` for any other oracle. The
set is immutable — no add, no remove, no owner — and an **empty** allowlist disables enforcement
entirely (local/tests). Separately, `_requireOracleCoversBasket` calls `priceWad` for every basket
asset and reverts `OracleMissingAsset(asset)` on a revert or a zero, so an oracle that cannot price
*this* basket is rejected rather than deploying a permanently-bricked vault. Both gates run in
`createVault` **and** `createChildVault`. What the allowlist does **not** do — bind an
already-deployed vault (`VaultCore.oracle` is immutable), or prove a feed is genuine — is
enumerated in [ChainlinkOracle.md](ChainlinkOracle.md), which also walks the launch oracle itself.

## Entry points

| Function | Notes |
| --- | --- |
| `createVault(params)` | `_requireAllowedOracle` (C-6) → `_deploy` → `_requireOracleCoversBasket` → `registry.attestVault(vault, msg.sender)` → record in `allVaults`. The priceability probe runs **after** `_deploy` on purpose: `VaultCore`'s constructor owns basket validity (cap, duplicates, decimals → `BadConfig`) and must diagnose a malformed basket first; this check has the last word on a different question — can this oracle actually price it. `_deploy` wires each vault's `subVaultRegistry` to the real registry **only when `allowSubVaults`**; otherwise `address(0)` (root-only, C-1) |
| `oracleAllowlistEnforced` / `isAllowedOracle` | **Immutable, C-6 curation.** Non-empty `allowedOracles_` at construction ⇒ enforced; each entry must be non-zero and have code. Gates **vault creation only** — every deployed vault is pinned to its own immutable oracle whatever the allowlist later says (`docs/LAUNCH-READINESS.md` §4 row 12; `test/audit/AuditOracleRotation.t.sol`) |
| `allowSubVaults` | **Immutable, C-1 launch switch.** False at launch → `createChildVault` reverts `SubVaultsDisabled` and every deployed vault is wired root-only (`subVaultRegistry = address(0)`, so `allocateToChild` reverts and `parentVault()` is `address(0)`). A funded child would otherwise have an empty electorate capturable by one dust deposit (C-1), and there is no purely-internal fix; sub-vaults are deferred to a post-launch, post-audit release. Set true only once the parent-casts-child-vote mechanism ships |
| `vaultDeployer` | Immutable. The factory's ONLY vault construction path (#10). Named `vaultDeployer`, not `deployer`, because the singletons already use `deployer` for the account that deployed them (`registry.deployer()`) |
| `createChildVault(params, parent)` | **Reverts `SubVaultsDisabled` unless `allowSubVaults`** (C-1, see above). When enabled: `msg.sender == parent.creator()` (L-1), **child USDC must equal parent USDC** and **child basket ⊆ parent basket** (`assetUnit != 0` check per asset) — the property that makes in-kind child redemptions always map into parent accounting and look-through pricing always resolvable (SV-7). Then `subVaultRegistry.registerChild(parent, vault, exitFeeMaxBps)` (depth + fee-stack checks live there) + attestation |
| `vaultCount` / `allVaults` | Enumeration for the indexer |

## Two-step bring-up (documented UX, not a trust gap)

After `createVault`, the creator registers the vault's `GovConfig` with Governance in a
second transaction (`governance.registerVault`). Until then no proposals can exist and exits
settle Mode I. Nothing privileged can happen in the gap: the vault is fully functional for
deposits/exits, and `registerVault` is creator-gated on the vault's own `creator()`.

## The deployer hop (#10)

`_deploy` `abi.encode`s the same 13-argument tuple `new VaultCore(...)` used to build, in the
same order, and hands it to `vaultDeployer.deploy`. Three properties to check, each with a
test behind it:

- **The code is not caller-supplied.** The deployer holds VaultCore's creation code pinned at
  compile time; the factory sends only constructor arguments. See
  [VaultDeployer.md](VaultDeployer.md).
- **Reverts still bubble.** A failing VaultCore constructor surfaces unchanged, so
  `createVault` with a bad config still reverts `VaultCore.BadConfig()`
  (`Eip170::test_vaultCoreConstructorRevertsStillBubbleThroughTheFactory`,
  `Sprint6Fixes::test_finding8_basketCapEnforced`).
- **The attestation anchor did not move.** The deployer holds no authority and is not the
  registry's `factory`; calling it directly yields an unattested vault
  (`Eip170::test_deployingDirectlyThroughTheDeployerIsNeverAttested`).

The one genuinely new wiring requirement: **the deployer must be deployed before the factory**,
because the factory pins it immutably. `Deploy.s.sol` documents the ordering.

## Review focus

1. **Attestation-identity binding:** the operator attested is `msg.sender` at creation.
   A contract creating vaults on behalf of others attests *itself* — fine for the trust model
   (identity = whoever controls creation), but confirm downstream assumptions (leaderboard,
   carry) hold for contract operators.
2. **Child-subset check reads `parent.assetUnit`** — `assetUnit != 0 ⇔ in basket` on
   VaultCore, and the parent address comes from the caller. An EOA or a non-conforming contract
   fails: `registerChild` calls `IVaultFees(parent).exitFeeMaxBps()` in the fee-stack loop, which
   reverts on a codeless or method-less address. But a *crafted* mock implementing three view
   functions — `usdc()`, `assetUnit(address)`, `exitFeeMaxBps()` — passes every gate
   (`depthOf[fake] == 0`, so depth 1; a `0` fee keeps the stack under cap), producing a real
   attested child whose `parentOf` is a fake. Sprint 10 traced the outcome and it is **benign**:
   the fake gains nothing (`VaultCore.allocateToChild` requires `parentOf(child) ==
   address(this)`, and a non-VaultCore fake has no such function), and the child loses nothing
   (the edge is used only by `parentVault()`, to exclude a parent's position from voting-eligible
   stake — and the fake holds no shares). Recorded so the case is not re-derived from scratch;
   see [SPRINT10-DEPLOYMENT-REVIEW §F-2](../../reviews/SPRINT10-DEPLOYMENT-REVIEW.md).
3. **No de-attestation exists.** A vault attested is attested forever (SF-5 retention). The
   factory has no owner, no pause, no list curation.

## Accepted risks here (do not re-report)

- **PX-3:** permissionless creation means scam vaults exist; the registry makes them
  distinguishable (identity-first surfacing), not impossible.
- Vaults deployed *outside* the factory can imitate the shape but are never attested — their
  marks and stats simply don't exist in the canonical registry. Since Sprint 7 this includes
  vaults created by calling `VaultDeployer.deploy` directly, which is the same case rather than
  a new one (PX-4).
