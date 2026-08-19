# @x402-vaults/agent-sdk

Environment-agnostic client for the index-vault protocol's x402-metered API. Handles the full
402 → EIP-3009 authorize → retry loop; you supply a wallet (address + EIP-712 signer) and the
USDC domain. See [docs/AGENT-QUICKSTART.md](../../docs/AGENT-QUICKSTART.md).

- `src/index.mjs` — `createProtocolClient({ baseUrl, wallet, domain })` → `health()`,
  `getVault(addr)`, `leaderboard()`, `request(path)`.
- `src/eip3009.mjs` — build the `TransferWithAuthorization` typed data + x402 envelope from any signer.

Zero dependencies; Node or browser. Tests: `node --test packages/agent-sdk/test/*.test.mjs`.
