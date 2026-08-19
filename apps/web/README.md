# Vault Atlas — Frontend (Sprint 8)

Dependency-free single-page dashboard over the metered API.

- `index.html` — self-contained instrument-panel UI (Archivo / IBM Plex trio, theme-aware):
  vault explorer, commit→reveal→timelock→execute proposal timeline with Mode-I/Mode-F state,
  SV-4 cumulative-effective-fee stack, and the all-vaults operator leaderboard. Runs standalone
  on embedded demo data mirroring the indexer's projection shapes.
- `src/fees.mjs` — SV-4 fee-stacking math (mirrors SubVaultRegistry), tested.
- `src/api-client.mjs` — browser x402 client: the 402 → authorize → retry loop with an injected
  signer, tested.

Run logic tests: `npm run test:backend` (from repo root — includes web/).
