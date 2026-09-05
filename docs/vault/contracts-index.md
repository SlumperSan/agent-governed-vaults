# Contracts Index

The on-chain surface of the agent-governed-vaults protocol: a Solidity 0.8.26 package under
`contracts/src/`, BUSL-1.1 licensed. This note is the hub of the **Contracts cluster**: start
here and follow the `[[wikilinks]]` into each module.

## Why it matters

Everything the protocol promises: permissionless USDC index vaults, member governance by
commit-reveal vote, in-kind two-mode exits, a fail-closed Chainlink price oracle, is enforced here or
nowhere. The design is deliberately **admin-free**: there are no upgrade proxies, no owner
setters, no pause guardian. Every trust-relevant choice is fixed at construction and immutable
after, because the vault creator is treated as **untrusted by explicit design**. That posture is
what makes constructor validation load-bearing and what shapes nearly every security finding.

## The modules

- [[vaultcore]]: holds ALL funds; shares, NAV, deposits, redemptions, rebalancing, sub-vault
  flows. EIP-170-constrained (the binding size limit of the whole package).
- [[governance]]: commit-reveal proposals, quorum, standing defaults, delegation, timelock.
- [[chainlinkoracle]]: **the launch oracle**: one genuine Chainlink Data Feed per asset, no
  median and no quorum, fail-closed ([[chainlink-direct-pivot]]). It **resolves** C-6.
- [[oracleaggregator]]: **RETIRED**, moved to `contracts/test/retired/`. The bespoke per-vault
  multi-source **median** oracle that finding [[c6-oracle-byzantine]] killed. Design record only.
- [[oracle-sources]]: **RETIRED**, moved to `contracts/test/retired/`. The `IPriceSource`
  implementations that fed OracleAggregator (Chainlink adapter, Uniswap V3 TWAP, Pyth), i.e. the
  SF-1 mechanism-diversity argument. There is no `IPriceSource` layer on the launch path.
- [[vaultfactory]]: permissionless canonical deployment + attestation; carries the C-1
  `allowSubVaults=false` launch gate ([[root-vaults-only]]).
- [[vaultdeployer]]: the factory's one construction path; exists because VaultCore's creation code
  (22,391 B, re-measured 2026-09-03) plus a factory's own logic exceeds EIP-170. The blob alone is
  under the 24,576 B cap; this line claimed otherwise until 2026-09-03.
- [[subvaultregistry]]: parent/child edges, depth cap, fee stacking, quorum inheritance.
  **DORMANT-AT-LAUNCH** (sub-vaults disabled).
- [[feeengine]]: 10% performance fee on realized profit, high-water-mark carry via registry.
- [[operatorregistry]]: operator identity, cross-vault loss carry, aggregate leaderboard.
- [[execution-adapters]]: the `IExecutionAdapter` venues rebalances route through (aggregation
  router + direct V2 pool).
- [[safetransferlib]]: vendored bounded ERC-20 helpers and `BoundedCall` (returndata / gas
  hardening).

## Deployment topology (wiring order)

The singletons are wired once, at deploy time, then locked:

1. `OperatorRegistry` and `SubVaultRegistry` deploy first (each records its `deployer`).
2. `FeeEngine` binds to the registry.
3. `VaultDeployer` is deployed (it embeds `type(VaultCore).creationCode`).
4. `VaultFactory` binds registry + governance + feeEngine + subVaultRegistry + deployer, and
   takes the `allowSubVaults` switch.
5. `OperatorRegistry.wire(factory, feeEngine)` and `SubVaultRegistry.wire(factory)` and
   `Governance.wireSubVaultRegistry(...)` lock the one-shot edges.

Per vault: the creator calls `VaultFactory.createVault`, then (second tx) `registerVault` on
[[governance]] with a `GovConfig`. Until registration, no proposal can exist and every exit
settles in Mode I.

## EIP-170 headroom snapshot

The runtime-bytecode size cap (24,576 B) governed **what could be fixed at all** during
remediation. Current margins (post-M-15; see [[vaultcore]] for the reconciliation):

| Contract | Runtime | Margin |
| --- | --- | --- |
| VaultCore | **20,650 B** | **3,926 B** (was ~24,293 B and ~283 B before PR #90) |
| ChainlinkOracle | ~1,532 B | ~23,044 B |
| Governance | **12,155 B** | **12,421 B** |
| VaultFactory | ~3,572 B | ~21,004 B |

> **Only `VaultCore` is size-constrained.** Prior sessions treated `VaultFactory` and
> `ChainlinkOracle` as tight; measurement says otherwise. 21,004 B and 23,044 B spare
> respectively. *(VaultCore and Governance re-measured with `forge build --sizes` at
> `protocol/main` on 2026-09-02; the other two rows carry their 2026-08-30 figures. **Re-measure
> rather than copy any of these**: no guard walks this table, which is how the previous VaultCore
> and Governance rows went stale.)* `VaultCore`'s 3,926 B is real headroom rather than the ~283 B
> that once closed anything `VaultCore`-shaped, but H-5/H-6 remain deferred for the reasons in
> [[vaultcore]]. `UniswapV3TwapSource` and `OracleAggregator` are no longer in the deployable
> set (retired to `contracts/test/retired/`), so their sizes are dropped from this table.

## Links

- Clusters: [[architecture-overview]] · [[security-index]] · [[current-state]] · [[decisions-index]]
- Decisions in play here: [[root-vaults-only]] · [[chainlink-direct-pivot]] ·
  [[build-vs-buy]] · [[delegatecall-split-rejected]]
- Architecture: [[nav-and-shares]] · [[governance-commit-reveal]] · [[two-mode-exits]] ·
  [[oracle-layer]] · [[sub-vaults]] · [[fees-and-carry]]
