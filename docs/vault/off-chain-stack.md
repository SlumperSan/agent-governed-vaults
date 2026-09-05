# Off-Chain Stack

**Definition.** Everything outside the contracts: the event indexer, the metered read API, the
agent SDK, the reference agent, the canary monitor, the operational logging library, and the web
frontend, all chain-agnostic and built so the tested core needs no live RPC.

**Why it matters.** The contracts are deliberately minimal (no upgrades, no admin); the intelligence
(indexing, agent voting, monitoring) lives here. This layer is where an operator actually runs a
vault, and where the [[x402-metering]] paid reads get their data.

## Packages (`packages/`)

- **indexer**: chain-agnostic event projections.
  - `projections.mjs`: pure reducers folding normalized events into vault + operator state and the
    all-vaults-included operator leaderboard (SF-4/SF-5); deterministic replay by
    `(block, logIndex)`.
  - `chain.mjs`: thin viem adapter turning on-chain logs into normalized events (the only
    chain-coupled file).
  - `store.mjs`: bigint/Map-safe serialization, atomic file snapshots, resume cursor.
  - `daemon.mjs`: resume-from-snapshot → poll → fold → snapshot, with `confirmations` lag for reorg
    safety; chain client + clock injected, so it is testable with no RPC. The tested core has zero
    dependencies; the API reads its projections directly.
- **agent-sdk**: client library; `eip3009.mjs` builds the `transferWithAuthorization` envelopes
  that pay for [[x402-metering]] reads; `index.mjs` is the public surface.
- **reference-agent**: a worked example agent (with fixtures) demonstrating the intended
  deposit/vote/exit loop against the SDK.
- **canary**: post-deploy health monitor: `canary-runner.mjs`, `reader.mjs`, `transitions.mjs`,
  `signals/`, `sinks.mjs`, `state-file.mjs`. Watches live vault state and emits signals on
  anomalous transitions.
- **oplog**: operational plumbing shared across services: `durable.mjs`, `heartbeat.mjs`,
  `logger.mjs`, `ops-check.mjs`, `shutdown.mjs` (graceful SIGTERM handling).

## Apps (`apps/`)

- **api**: the metered read server; see [[x402-metering]] for the route split, the x402 payment
  gate (`src/x402.mjs`), the facilitator (`facilitator.mjs` / `facilitator-server.mjs`), rate
  limiting (`ratelimit.mjs`), and metrics (`metrics.mjs`). Holds no keys and no RPC client.
- **web**: frontend: `api-client.mjs` (talks to the API), `fees.mjs` (fee display, including the
  cumulative sub-vault fee stack when that ships), `live-adapter.mjs` (live state binding).

## Design posture

- **Chain-agnostic**, mirroring the contract commitment (commitment C-2): `block.timestamp`-only
  logic on-chain, and off-chain the chain-coupled surface is isolated to a single viem adapter.
- **Injected dependencies for testability**: the facilitator is stubbed in API tests, the chain
  client and clock are injected into the indexer daemon; no live chain or facilitator is needed to
  run the suites.
- **Persistence = resumability**: a restart resumes from the last indexer snapshot rather than
  replaying from genesis.

## Links

- [[architecture-overview]] · [[x402-metering]] (the API this feeds) · [[fees-and-carry]]
  (leaderboard projections)
- Contracts consumed via ABIs: [[vaultcore]] · [[operatorregistry]] · [[vaultfactory]]
- State: [[current-state]]
