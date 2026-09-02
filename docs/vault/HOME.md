# Agent-Governed Vaults — Knowledge Vault (HOME)

> Obsidian-style knowledge graph for this protocol. This is the **map of content (MOC)** — the hub
> of the graph. Every note links to related notes with `[[wikilinks]]` (filename without `.md`).
> Read this first to orient; follow links to drill in. Kept current as work lands.

**Repo:** `github.com/SlumperSan/agent-governed-vaults` (private) · **base:** `protocol/main`
**One-liner:** permissionless USDC index vaults, governed by AI agents via commit-reveal weighted
vote, x402-metered off-chain access. **Launch verdict:** NO-GO (external audit pending; C-6 open).

## Conventions (for consistency across the graph)

- Filenames: `kebab-case.md`; the note title is a matching `# Title` H1.
- Link by filename stem: `[[vaultcore]]`, `[[c6-oracle-byzantine]]`. Unresolved links are fine — they
  mark notes worth writing.
- Each note starts with a one-line **definition**, then **why it matters**, then detail, then a
  **Links** section. Keep notes atomic (one concept) and cross-linked, not monolithic.
- Status tags in prose: **FIXED**, **OPEN**, **DEFERRED**, **ACCEPTED**, **DORMANT-AT-LAUNCH**.

## Clusters

### Architecture — [[architecture-overview]]
- [[nav-and-shares]] · [[governance-commit-reveal]] · [[two-mode-exits]] · [[sub-vaults]] ·
  [[oracle-layer]] · [[fees-and-carry]] · [[x402-metering]] · [[off-chain-stack]]

### Contracts — [[contracts-index]]
- [[vaultcore]] · [[governance]] · [[oracleaggregator]] · [[chainlinkoracle]] · [[vaultfactory]] ·
  [[vaultdeployer]] · [[subvaultregistry]] · [[feeengine]] · [[operatorregistry]] ·
  [[execution-adapters]] · [[oracle-sources]] · [[safetransferlib]]

### Security — [[security-index]]
- Criticals: [[c1-empty-electorate]] · [[c2-unbounded-governance]] · [[c3-oracle-brick]] ·
  [[c4-depressed-price-theft]] · [[c5-vote-after-exit]] · [[c6-oracle-byzantine]]
- [[highs]] · [[mediums-and-lows]] · [[threat-model-commitments]] · [[slither-triage]] ·
  [[launch-readiness-gates]] · [[audit-reverification]]

### Decisions & Principles — [[decisions-index]]
- [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[build-vs-buy]] · [[auto-merge]] ·
  [[delegatecall-split-rejected]] · [[continuous-autonomous-mode]]

### Operator policy — [[agent-policy-vault-1]]
- [[agent-policy-vault-1]] (vault #1's published deterministic rebalance policy) ·
  [[agent-policy-log]] (the proposal pre-image log it requires)

### State & Roadmap — [[current-state]]
- [[remediation-history]] · [[open-items]] · [[prs-and-issues]] · [[go-to-market-plan]]

## Graph note

This vault is engineered as a graph: contracts link to the findings that live in them, findings link
to the decisions that resolved them, decisions link to the principles behind them. Start anywhere and
traverse. See [[current-state]] for "what is true right now".
