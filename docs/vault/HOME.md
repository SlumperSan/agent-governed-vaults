# Agent-Governed Vaults: Knowledge Vault (HOME)

> Obsidian-style knowledge graph for this protocol. This is the **map of content (MOC)**: the hub
> of the graph. Every note links to related notes with `[[wikilinks]]` (filename without `.md`).
> Read this first to orient; follow links to drill in. Kept current as work lands.

**Repo:** `github.com/SlumperSan/agent-governed-vaults` (private) · **base:** `protocol/main`
**One-liner:** permissionless USDC index vaults whose members ratify every rebalance by
on-chain commit-reveal vote (proposal rights follow stake, not operatorship) with x402-metered
off-chain access. **Base mainnet launch verdict:** NO-GO, for OPERATIONAL reasons only (the soak and canary gates need the five-drill soak re-run against the current Base Sepolia deployment with the canary observed alongside it). **Robinhood Chain mainnet (4663):** deployed 2026-09-05 on the owner's decision of 2026-09-04, without those two gates. Two vaults exist on it and both hold real funds: `verifiedWiring["factory.vaultCount()"]` is 2 in `contracts/config/deployments/robinhood-mainnet.json`, naming `0x9b0229FF0613EaD59e41Eec556e03b5ED228e2b4` (`idleUsdc` 20000000 at block 61,646,791) and `0x03E121e18c68B48B84a60D8F93BcD7D5be31ee38` (0.001980484 WETH (`assetBalance` 1980483895862031 wei, read at block 61,646,791), a priced position rather than cash). Both were created by the deployer EOA rather than the creator Safe, against that record's own `intendedCreator`, and `creator` is immutable so neither can be corrected. See [[current-state]]. Every security gate is cleared: gate 0 GO (root-only, C-6 resolved by the Chainlink pivot), gate 1 GO on owner attestation. See [[launch-readiness-gates]].

## Conventions (for consistency across the graph)

- Filenames: `kebab-case.md`; the note title is a matching `# Title` H1.
- Link by filename stem: `[[vaultcore]]`, `[[c6-oracle-byzantine]]`. Unresolved links are fine. They
  mark notes worth writing.
- Each note starts with a one-line **definition**, then **why it matters**, then detail, then a
  **Links** section. Keep notes atomic (one concept) and cross-linked, not monolithic.
- Status tags in prose: **FIXED**, **OPEN**, **DEFERRED**, **ACCEPTED**, **DORMANT-AT-LAUNCH**.

## Clusters

### Architecture: [[architecture-overview]]
- [[nav-and-shares]] · [[governance-commit-reveal]] · [[two-mode-exits]] · [[sub-vaults]] ·
  [[oracle-layer]] · [[fees-and-carry]] · [[x402-metering]] · [[off-chain-stack]]

### Contracts: [[contracts-index]]
- [[vaultcore]] · [[governance]] · [[oracleaggregator]] · [[chainlinkoracle]] · [[vaultfactory]] ·
  [[vaultdeployer]] · [[subvaultregistry]] · [[feeengine]] · [[operatorregistry]] ·
  [[execution-adapters]] · [[oracle-sources]] · [[safetransferlib]]

### Security: [[security-index]]
- Criticals: [[c1-empty-electorate]] · [[c2-unbounded-governance]] · [[c3-oracle-brick]] ·
  [[c4-depressed-price-theft]] · [[c5-vote-after-exit]] · [[c6-oracle-byzantine]]
- [[highs]] · [[mediums-and-lows]] · [[threat-model-commitments]] · [[slither-triage]] ·
  [[launch-readiness-gates]] · [[audit-reverification]]

### Decisions & Principles: [[decisions-index]]
- [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[build-vs-buy]] · [[auto-merge]] ·
  [[delegatecall-split-rejected]] · [[continuous-autonomous-mode]]

### State & Roadmap: [[current-state]]
- [[remediation-history]] · [[open-items]] · [[prs-and-issues]] · [[go-to-market-plan]]

## Graph note

This vault is engineered as a graph: contracts link to the findings that live in them, findings link
to the decisions that resolved them, decisions link to the principles behind them. Start anywhere and
traverse. See [[current-state]] for "what is true right now".
