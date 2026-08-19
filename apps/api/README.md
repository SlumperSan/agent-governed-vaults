# Metered Read API (Sprint 7)

Read layer over indexed vault state, gated by x402 (V2) payment.

- `src/x402.mjs` — payment gate: 402 challenge (`PAYMENT-REQUIRED`), client authorization via
  `PAYMENT-SIGNATURE` (base64 EIP-3009 `transferWithAuthorization` envelope), settlement through
  an injected facilitator, `PAYMENT-RESPONSE` receipt echo. Server holds no keys, moves no funds.
- `src/server.mjs` — Node-http routes: `/health` (free), `/vaults/:addr` and
  `/operators/leaderboard` (paid).

Settlement is USDC on Base via EIP-3009 executed by the facilitator (never this server), per the
x402 V2 scheme (see docs/RESEARCH-SPRINT1.md).

Run tests: `npm run test:backend` (from repo root). No live chain or facilitator needed —
the facilitator is injected and stubbed in tests.
