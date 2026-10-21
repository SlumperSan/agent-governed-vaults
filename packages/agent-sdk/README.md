# @x402-vaults/agent-sdk

Environment-agnostic client for the index-vault protocol's x402-metered API. Handles the full
402 → EIP-3009 authorize → retry loop; you supply a wallet (address + EIP-712 signer) and the
USDC domain. See [docs/AGENT-QUICKSTART.md](../../docs/AGENT-QUICKSTART.md).

- `src/index.mjs`: `createProtocolClient({ baseUrl, wallet, domain })` → `health()`,
  `getVault(addr)`, `leaderboard()`, `request(path)`.
- `src/eip3009.mjs`: build the `TransferWithAuthorization` typed data + x402 envelope from any signer.
- `src/smart-account.mjs`: `createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling })`
  returns a `{ writeContract }` that sends each write as an ERC-4337 UserOperation from a smart
  account (viem bundler client and smart account, entry point 0.6 or 0.7 as the account reports).
  It refuses a write for any other account and any UserOp priced above the ceiling, waits for the
  receipt, and strips URL paths from errors. It exposes no signing method, so the smart account
  is never offered as an ERC-1271 signer; pay x402 from a separate EOA.

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

Depends on viem (the UserOp writer's ABI encoder) and the two Solana packages (`src/svm-exact.mjs`); Node or browser. Tests: `node --test packages/agent-sdk/test/*.test.mjs`.
