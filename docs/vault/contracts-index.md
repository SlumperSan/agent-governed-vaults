# Contracts Index

The on-chain surface of the agent-governed-vaults protocol: a Solidity 0.8.26 package under
`contracts/src/`, BUSL-1.1 licensed. This note is the hub of the **Contracts cluster** — start
here and follow the `[[wikilinks]]` into each module.

## Why it matters

Everything the protocol promises — permissionless USDC index vaults, AI-agent governance by
commit-reveal vote, in-kind two-mode exits, a multi-source price oracle — is enforced here or
nowhere. The design is deliberately **admin-free**: there are no upgrade proxies, no owner
setters, no pause guardian. Every trust-relevant choice is fixed at construction and immutable
after, because the vault creator is treated as **untrusted by explicit design**. That posture is
what makes constructor validation load-bearing and what shapes nearly every security finding.

## The modules

- [[vaultcore]] — holds ALL funds; shares, NAV, deposits, redemptions, rebalancing, sub-vault
  flows. EIP-170-constrained (the binding size limit of the whole package).
- [[governance]] — commit-reveal proposals, quorum, standing defaults, delegation, timelock.
- [[oracleaggregator]] — the bespoke per-vault multi-source **median** oracle (finding
  [[c6-oracle-byzantine]] lives here).
- [[chainlinkoracle]] — the **NEW additive** Chainlink-direct oracle ([[chainlink-direct-pivot]])
  that **resolves** C-6 by removing the median entirely.
- [[oracle-sources]] — the `IPriceSource` implementations feeding OracleAggregator (Chainlink
  adapter, Uniswap V3 TWAP, Pyth), i.e. SF-1 mechanism diversity.
- [[vaultfactory]] — permissionless canonical deployment + attestation; carries the C-1
  `allowSubVaults=false` launch gate ([[root-vaults-only]]).
- [[vaultdeployer]] — the factory's one construction path; exists solely because VaultCore's
  creation code exceeds EIP-170.
- [[subvaultregistry]] — parent/child edges, depth cap, fee stacking, quorum inheritance.
  **DORMANT-AT-LAUNCH** (sub-vaults disabled).
- [[feeengine]] — 10% performance fee on realized profit, high-water-mark carry via registry.
- [[operatorregistry]] — operator identity, cross-vault loss carry, aggregate leaderboard.
- [[execution-adapters]] — the `IExecutionAdapter` venues rebalances route through (aggregation
  router + direct V2 pool).
- [[safetransferlib]] — vendored bounded ERC-20 helpers and `BoundedCall` (returndata / gas
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
| VaultCore | ~24,293 B | **~283 B** |
| Governance | ~12,051 B | ~12,525 B |
| UniswapV3TwapSource | ~5,169 B | ~19,407 B |
| VaultFactory | ~2,818 B | ~21,758 B |
| OracleAggregator | ~1,215 B | ~23,361 B |

## Links

- Clusters: [[architecture-overview]] · [[security-index]] · [[current-state]] · [[decisions-index]]
- Decisions in play here: [[root-vaults-only]] · [[chainlink-direct-pivot]] ·
  [[build-vs-buy]] · [[delegatecall-split-rejected]]
- Architecture: [[nav-and-shares]] · [[governance-commit-reveal]] · [[two-mode-exits]] ·
  [[oracle-layer]] · [[sub-vaults]] · [[fees-and-carry]]
