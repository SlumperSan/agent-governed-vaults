# @x402-vaults/agent-sdk

Environment-agnostic client for the index-vault protocol's x402-metered API. Handles the full
402 → EIP-3009 authorize → retry loop; you supply a wallet (address + EIP-712 signer) and the
USDC domain.

**Full reference with a runnable example for every method:
[docs/SDK-REFERENCE.md](../../docs/SDK-REFERENCE.md).** That page is checked against this source by
`scripts/test/docs-site.test.mjs`, so it cannot drift; this README is the map, not the reference.

- `src/index.mjs` — `createProtocolClient({ baseUrl, wallet, domain, fetchImpl?, nowSec?, skewSec?, onPayment? })`
  → `discovery()` and `health()` (free), `listVaults()`, `getVault(addr)`,
  `memberPosition(vault, member)`, `leaderboard()` (metered), plus `request(path)` as the escape
  hatch. Metered methods resolve `{ data, receipt }`; free ones return the body. Non-2xx throws
  `ProtocolError` (`status`, `body`).
- `src/eip3009.mjs` — `authorizeFromChallenge`, `buildTypedData`, `buildEnvelope`: build the
  `TransferWithAuthorization` typed data and x402 envelope from any signer.

Two things that are easy to get wrong and expensive when you do:

- **`domain` is chain-specific.** Base mainnet USDC reports `name: "USD Coin"`; Base Sepolia reports
  `"USDC"`. The wrong name yields a valid signature over the wrong struct hash, recovers to a
  stranger, and surfaces as an opaque `signer-mismatch`. Read it from the token.
- **Signing is spending.** The 402 → sign → retry round trip happens inside one call, so a spend cap
  must live *inside* the signer, not around the call. `onPayment` fires after signing and before the
  paid retry — record the envelope, because a receipt id cannot be re-verified against the chain.

Zero dependencies; Node or browser. Tests: `node --test packages/agent-sdk/test/*.test.mjs`.
