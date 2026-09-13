# VaultFactory

The permissionless, canonical vault-deployment and attestation contract. Anyone can deploy a vault;
only vaults deployed here are attested to their operator. `contracts/src/VaultFactory.sol`.

## Why it matters

The canonical factory is what makes the whole reputation system trustworthy (CM-5, SF-4, PX-3):
carry marks and leaderboard rows in [[operatorregistry]] can only be produced by real,
protocol-shaped vaults, because only factory-deployed vaults are attested. Creation stays fully
permissionless: attestation is automatic and identity-keyed, never curated. It is also the single
place the **C-1 launch gate** is enforced, which is why one immutable bool on this contract closes
an entire class of criticals.

## Key state

- Immutables: `registry`, `governance`, `feeEngine`, `subVaultRegistry`, `vaultDeployer`, the
  **`allowSubVaults`** switch, and the **`allowedOracles_`** oracle allowlist (see below).
- `allVaults[]`: every vault ever deployed here.

## Entry points

- `createVault(VaultParams)`: deploy + attest a **root** vault; `msg.sender` becomes creator (the
  5% gate identity) and attested operator.
- `createChildVault(VaultParams, parent)`: deploy a child; **reverts `SubVaultsDisabled` at
  launch**.
- `vaultCount()`: length of `allVaults`.

Construction goes through `_deploy`, which ABI-encodes VaultCore's constructor tuple and calls
`vaultDeployer.deploy(...)` (see [[vaultdeployer]]: the factory can't `new VaultCore(...)` because
the blob **plus the factory's own logic** exceeds EIP-170; the blob alone is 22,391 B, under the
24,576 B cap. Re-measured 2026-09-03). A failing VaultCore constructor bubbles its own revert
unchanged.

## Security findings that live here

- [[c1-empty-electorate]]: **the `allowSubVaults = false` gate ([[root-vaults-only]]).** A funded
  sub-vault has an **empty electorate**: the parent's non-voting exclusion (GA-1) means its only
  capital is the parent's allocation while its voting-eligible stake and holder count are both zero,
  so one `minDepositUsdc` buys sole governance control, and the proposer-supplied `minAmountOut`
  turns capture into **drain**. There is no purely-internal fix (any denominator excluding the
  parent lets a dust depositor govern the parent's allocation; including it makes the child
  ungovernable). The decision is to ship launch with sub-vaults **disabled at the contract level**:
  - `createChildVault` reverts;
  - `_deploy` wires every vault it deploys with `subVaultRegistry = address(0)`, so each is intrinsically
    root-only: `parentVault()` is `address(0)`, `allocateToChild` reverts, the look-through paths
    are dead.
  - This closes **C-1, H-5, H-6, H-7 and H-9 as a class.** The sub-vault code is **retained, not
    deleted**, so a future factory can enable it once the parent-casts-child-vote mechanism ships and
    is audited.
- **L-1 (in `createChildVault`)**: the child path now requires `msg.sender ==
  parent.creator()`. Previously it performed **no authorization on `parent`**: anyone could
  permanently attach an arbitrary child under any vault (edges are creation-time-only, no removal)
  and, as the child's creator, register a `GovConfig` with `timelockDuration = 0`, removing the
  parent's only race in C-1. Low standalone, load-bearing in composition. (Dormant at launch behind
  the same gate, but retained.)

- [[c6-oracle-byzantine]]: **the `allowedOracles_` oracle-gate (PR #50).** The bespoke
  [[oracleaggregator]] cannot be secured against an adversarial source set (`quorum ≥ 2a+1` is a
  listing requirement the constructor cannot see), so leaving it user-selectable re-imported C-6 for
  any vault that picked it. The factory now takes an **immutable oracle allowlist** at construction:
  a **non-empty** `allowedOracles_` sets `oracleAllowlistEnforced`, and both `createVault` and
  `createChildVault` revert **`OracleNotAllowed`** for any `oracle_` not on the list; an **empty**
  list is permissive (enforcement off). This is the contract-level lever that makes the custom
  aggregator non-deployable and pins vaults to the blessed [[chainlinkoracle]]: the second half of
  the C-6 remediation, alongside the safe oracle (#49). See [[chainlink-direct-pivot]]. Regression:
  `AuditOracleAllowlist.t.sol`. Mainnet deployment is guarded by `Deploy.s.sol` (PR #53) which
  **reverts if the `BLESSED_ORACLES` allowlist is empty**, preventing accidental unsafe deploys. Gate 0
  is **GO (root-only)**: the *mechanism* is complete and the external audit (gate 1) is complete on
  owner attestation. Any mainnet deploy must still populate the allowlist with real addresses: for the live Robinhood Chain factory, what was blessed is in `contracts/config/deployments/robinhood-mainnet.json` and readable on-chain via `factory.isAllowedOracle(...)` and `factory.oracleAllowlistEnforced()`; a
  deploy step, not an open Critical.

The child path also enforces same-USDC and basket-subset-of-parent, so in-kind child redemptions
always map into parent accounting and look-through pricing (SV-7) is always possible.

## Two-step bring-up

Not a trust gap, documented UX: after `createVault` the creator registers the vault's `GovConfig`
with [[governance]] in a second transaction. Until then no proposal can exist and exits settle in
Mode I.

## Size: EIP-170

Runtime **3,572 B**; margin **21,004 B** (`forge build --sizes`, 2026-09-03; this row read
~2,818 B / ~21,758 B until then). Historically VaultFactory was 2,665 B **over** the cap because it
embedded VaultCore's creation code inline: the reason [[vaultdeployer]] exists.

## Links

- [[contracts-index]] · [[vaultdeployer]] · [[vaultcore]] · [[operatorregistry]] ·
  [[subvaultregistry]] · [[governance]] · [[oracleaggregator]] · [[chainlinkoracle]]
- Architecture: [[sub-vaults]] · [[nav-and-shares]] · [[oracle-layer]]
- Findings: [[c1-empty-electorate]] · [[c6-oracle-byzantine]] · [[highs]]
- Decision: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[threat-model-commitments]] ·
  [[launch-readiness-gates]]
