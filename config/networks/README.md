# `config/networks` — x402 capability for networks that have no EVM chain id

One file per payment network. `packages/chain-config/src/x402.mjs` reads this directory
non-recursively and indexes every `*.json` that declares a string `network`.

This is **not** a deployment configuration and must not become one. The vault contracts are
Solidity; nothing in this directory deploys, and nothing here is read by Solidity. It answers one
question — *may this network meter reads over x402, and by which scheme* — for networks the
`contracts/config` directory cannot describe because they have no `chainId`.

## Why it is separate from `contracts/config`

`contracts/config/*.json` is the vault deployment configuration: oracle parameters, governance
defaults, asset lists. `vm.readFile` reads those files inside forge tests, and
`scripts/test/config-doc-truth.test.mjs` enumerates every `*-mainnet.json` there and asserts a
`govDefencesNote` on each. A payment network has no governance defences, so `solana-mainnet.json`
in that directory would red the suite on the day it landed and the fix would be an exemption list
inside a guard whose whole value is that it enumerates rather than lists.

## Shape

```json
{
  "network": "solana-mainnet",
  "chainName": "Solana mainnet-beta",
  "scheme": "exact-svm",
  "x402": { "enabled": true, "note": "why, and since when" }
}
```

- **`network`** — required, and the key. Matched case-insensitively, because `NETWORK=Solana-Mainnet`
  in a `.env` is the same network as `solana-mainnet`, and a lookup that says otherwise takes a
  payment gate off by capitalisation.
- **`scheme`** — which x402 settlement scheme this network speaks. EVM chains use `exact-evm`
  (EIP-3009 `transferWithAuthorization`); Solana uses `exact-svm` (SPL `TransferChecked`, with the
  facilitator signing as fee payer). The resolver returns it so a caller can pick a facilitator
  without a second lookup.
- **`x402.enabled`** — only an explicit `false` disables. An absent block, a partial block, an
  unknown network, or a missing directory all mean **enabled**: x402 is a payment gate, and a gate
  must not come off because a lookup could not read its source.

## Adding a network

Add the file. Nothing else — the directory is enumerated from the filesystem, never from a list, so
a network added today is covered today. Then add a case to
`apps/api/test/x402-capability.test.mjs`, which is where the resolver's behaviour is pinned.
