# Walkthrough — VaultFactory.sol

**Risk: Medium.** ~114 LoC. `contracts/src/VaultFactory.sol`.

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

## Entry points

| Function | Notes |
| --- | --- |
| `createVault(params)` | `_deploy` → `registry.attestVault(vault, msg.sender)` → record in `allVaults` |
| `createChildVault(params, parent)` | Additionally: **child USDC must equal parent USDC** and **child basket ⊆ parent basket** (`assetUnit != 0` check per asset) — the property that makes in-kind child redemptions always map into parent accounting and look-through pricing always resolvable (SV-7). Then `subVaultRegistry.registerChild(parent, vault, exitFeeMaxBps)` (depth + fee-stack checks live there) + attestation |
| `vaultCount` / `allVaults` | Enumeration for the indexer |

## Two-step bring-up (documented UX, not a trust gap)

After `createVault`, the creator registers the vault's `GovConfig` with Governance in a
second transaction (`governance.registerVault`). Until then no proposals can exist and exits
settle Mode I. Nothing privileged can happen in the gap: the vault is fully functional for
deposits/exits, and `registerVault` is creator-gated on the vault's own `creator()`.

## Review focus

1. **Attestation-identity binding:** the operator attested is `msg.sender` at creation.
   A contract creating vaults on behalf of others attests *itself* — fine for the trust model
   (identity = whoever controls creation), but confirm downstream assumptions (leaderboard,
   carry) hold for contract operators.
2. **Child-subset check reads `parent.assetUnit`** — `assetUnit != 0 ⇔ in basket` on
   VaultCore, and the parent address comes from the caller; a bogus `parent` fails at
   `registerChild` (factory-only writer, parent must exist for depth/fee reads) — walk that
   failure ordering.
3. **No de-attestation exists.** A vault attested is attested forever (SF-5 retention). The
   factory has no owner, no pause, no list curation.

## Accepted risks here (do not re-report)

- **PX-3:** permissionless creation means scam vaults exist; the registry makes them
  distinguishable (identity-first surfacing), not impossible.
- Vaults deployed *outside* the factory can imitate the shape but are never attested — their
  marks and stats simply don't exist in the canonical registry.
