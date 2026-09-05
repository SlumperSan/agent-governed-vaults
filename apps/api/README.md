# Metered Read API (Sprint 7)

Read layer over indexed vault state, gated by x402 (V2) payment.

- `src/x402.mjs` — payment gate: 402 challenge (`PAYMENT-REQUIRED`), client authorization via
  `PAYMENT-SIGNATURE` (base64 EIP-3009 `transferWithAuthorization` envelope), settlement through
  an injected facilitator, `PAYMENT-RESPONSE` receipt echo. Server holds no keys, moves no funds.
- `src/server.mjs` — Node-http routes: `/health`, `/.well-known/x402` and `/metrics` (free);
  `/vaults`, `/vaults/:addr`, `/vaults/:addr/members/:m` and `/operators/leaderboard` (paid).
  Also the request caps (method, URL length, body size) applied before any handler work.
- `src/ratelimit.mjs` — per-IP token bucket on the FREE routes only. The paid routes are
  self-limiting: **x402 IS the rate limiter**, since every metered read costs the caller USDC.
- **x402 is a per-chain capability** (`packages/chain-config/src/x402.mjs`, resolved from
  `contracts/config/<chain>.json` via `CHAIN_ID`). On a chain that declares `x402.enabled: false`
  — chain 4663, per the owner's decision of 2026-09-05 — the routes above marked "paid" are served
  with no 402, no challenge and no payment headers, and the token bucket then covers **every**
  route, because the sentence before this one is exactly why the paid ones were left out of it.
  Nothing is removed: unset `CHAIN_ID`, a chain with no config, or a config with no `x402` block
  all meter as they always have, and so does everything above.
- `src/metrics.mjs` — the plain-text counters behind `/metrics`, including
  `vault_indexer_snapshot_age_seconds`, which is the indexer-lag signal. The API holds no RPC
  client by design, so it reports snapshot age rather than a blocks-behind figure it cannot know.

Settlement is USDC on Base via EIP-3009 executed by the facilitator (never this server), per the
x402 V2 scheme (see docs/RESEARCH-SPRINT1.md).

Operating it — log format, rate limits, metrics, backups, restore, the incident table — is
[docs/RUNTIME.md §8](../../docs/RUNTIME.md#8-operations).

Run tests: `npm run test:backend` (from repo root). No live chain or facilitator needed —
the facilitator is injected and stubbed in tests. `test/signals.test.mjs` spawns the real
entrypoint and sends it a real SIGTERM; it skips on Windows, where a child cannot be signalled.
