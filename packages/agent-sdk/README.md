# @x402-vaults/agent-sdk

Environment-agnostic client for the index-vault protocol's x402-metered API. Handles the full
402 → EIP-3009 authorize → retry loop; you supply a wallet (address + EIP-712 signer) and the
USDC domain. See [docs/AGENT-QUICKSTART.md](../../docs/AGENT-QUICKSTART.md).

- `src/index.mjs`: `createProtocolClient({ baseUrl, wallet, domain })` → `health()`,
  `getVault(addr)`, `leaderboard()`, `request(path)`.
- `src/eip3009.mjs`: build the `TransferWithAuthorization` typed data + x402 envelope from any signer.

The SDK has no chain table. The domain is yours to supply, and it must be the pair the token on
your chain reports, because a wrong name or version still signs and then fails as a signer
mismatch. For Arc mainnet (chain 5042) the pair was read from the token on both public RPCs and
reproduces its `DOMAIN_SEPARATOR()`:

```js
const domain = {
  name: 'USDC',
  version: '2',
  chainId: 5042,
  verifyingContract: '0x3600000000000000000000000000000000000000',
};
```

`node scripts/verify-arc-usdc-domain.mjs` repeats that read and check against the chain, and
`packages/reference-agent/presets/arc-mainnet.json` records the result.

Zero dependencies; Node or browser. Tests: `node --test packages/agent-sdk/test/*.test.mjs`.
