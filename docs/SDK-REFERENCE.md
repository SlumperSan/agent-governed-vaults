# Agent SDK reference

`@x402-vaults/agent-sdk` — [`packages/agent-sdk`](../packages/agent-sdk). Zero dependencies, Node or
browser. It exists to do one thing well: run the x402 **402 → authorize → retry** loop so your agent
calls a metered route like an ordinary function.

> **This page cannot silently drift from the code.** `scripts/test/docs-site.test.mjs` boots a real
> API over a real snapshot, constructs a real client, enumerates the client's methods and the
> module's exports at runtime, and fails the gate if this page documents something that does not
> exist or omits something that does. Every example below was executed to produce the output shown.

- Source: [`src/index.mjs`](../packages/agent-sdk/src/index.mjs) ·
  [`src/eip3009.mjs`](../packages/agent-sdk/src/eip3009.mjs)
- The mechanism it implements: [The x402 flow](X402-FLOW.md)
- Get it running in ten minutes: [Agent quickstart](AGENT-QUICKSTART.md)

---

## Contents

| Export | Kind | What it is for |
| --- | --- | --- |
| [`createProtocolClient`](#createprotocolclient) | factory | The client. Typed methods over the metered API. |
| [`ProtocolError`](#protocolerror) | class | Thrown on any non-2xx; carries `status` and the parsed body. |
| [`authorizeFromChallenge`](#authorizefromchallenge) | function | Challenge → signed x402 envelope. Used internally; exported for hand-rolled loops. |
| [`buildTypedData`](#buildtypeddata) | function | The EIP-712 payload for `transferWithAuthorization`. |
| [`buildEnvelope`](#buildenvelope) | function | Wrap a signed authorization as the `PAYMENT-SIGNATURE` body. |

Client methods: [`discovery`](#clientdiscovery) · [`health`](#clienthealth) ·
[`listVaults`](#clientlistvaults) · [`getVault`](#clientgetvaultaddress) ·
[`memberPosition`](#clientmemberpositionvault-member) · [`leaderboard`](#clientleaderboard) ·
[`request`](#clientrequestpath)

---

## `createProtocolClient`

```js
import { createProtocolClient } from '@x402-vaults/agent-sdk';

const client = createProtocolClient({
  baseUrl: 'http://127.0.0.1:8402',
  wallet: {
    address: account.address,
    sign: (td) => account.signTypedData({
      domain: td.domain,
      types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
      primaryType: 'TransferWithAuthorization',
      message: td.message,
    }),
  },
  domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
});
```

### Config

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `string` | — | **Required.** No trailing slash; paths are appended verbatim. |
| `wallet` | `{address, sign}` | — | **Required.** `sign(typedData)` returns a `0x…` EIP-712 signature. Any signer: viem, ethers, a raw `eth_signTypedData_v4` hook, an MCP wallet tool. |
| `domain` | `{name, version, chainId, verifyingContract}` | — | **Required.** USDC's EIP-712 domain **on your chain**. Get this wrong and every settlement fails with an opaque `signer-mismatch` — see [the domain trap](#the-domain-is-the-one-you-are-most-likely-to-get-wrong). |
| `fetchImpl` | `typeof fetch` | global `fetch` | Injection point for tests, proxies, and non-global-fetch runtimes. |
| `nowSec` | `() => number` | `Date.now()/1000` | Clock source for `validAfter`/`validBefore`. |
| `skewSec` | `number` | `60` | How far `validAfter` is backdated. See [`authorizeFromChallenge`](#authorizefromchallenge). |
| `onPayment` | `({path, challenge, envelope}) => void` | — | Fires **after signing, before the paid retry.** See below. |

### `onPayment` is not optional in production

A receipt id is a broadcast transaction hash and nothing more. It cannot be replayed, audited, or
re-verified against the chain — and if the paid request then returns an error, you never see the
receipt at all, because the SDK throws. **The envelope can be re-verified.** Record it:

```js
const paid = [];
const client = createProtocolClient({
  /* … */
  onPayment: ({ path, envelope }) => paid.push({
    path, value: envelope.authorization.value, nonce: envelope.authorization.nonce,
  }),
});
```

The hook is deliberately passive: its return value is ignored and a throw is **not** caught, so a
buggy hook fails loudly rather than silently dropping the record of a payment that has already been
signed.

### The domain is the one you are most likely to get wrong

USDC's EIP-712 domain name is **not the same on every chain.** Both rows below were read from the
live token on 2026-08-29, not copied from a constant:

| Chain | `name()` | `version()` | Address |
| --- | --- | --- | --- |
| Base mainnet (8453) | `"USD Coin"` | `"2"` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base Sepolia (84532) | `"USDC"` | `"2"` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

The SDK takes `domain` as a parameter and does not guess for you. Read it from the token —
[the quickstart has a zero-dependency snippet](AGENT-QUICKSTART.md#3-read-the-usdc-domain-from-the-token-do-not-hard-code-it).

---

## Client methods

Every metered method returns `{ data, receipt }`. `receipt` is the parsed `PAYMENT-RESPONSE`
header — `{ receiptId, nonce }` — or `null` on a free route. Free methods return the body directly.

### `client.discovery()`

**Free.** The bootstrap call. Pricing, the route map, and spec pointers, before you spend anything.

```js
const disc = await client.discovery();
```

```json
{
  "x402Version": 2,
  "price": {
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "10000",
    "payTo": "0x000000000000000000000000000000000000beef",
    "network": "base"
  },
  "routes": {
    "free": ["/health", "/.well-known/x402", "/metrics"],
    "metered": ["/vaults", "/vaults/{address}", "/vaults/{address}/members/{member}", "/operators/leaderboard"]
  },
  "openapi": "docs/api/openapi.yaml",
  "llms": "/llms.txt"
}
```

`price.amount` is an integer string in **USDC base units, 6 decimals** — `"10000"` is $0.01. An
agent should read the price here rather than hard-coding it, and should compare `price.payTo`
against the `payTo` in each 402 challenge before authorizing.

### `client.health()`

**Free.** Liveness plus how far the indexer has got. Returns the body directly, not `{data, receipt}`.

```js
const health = await client.health();
```

```json
{ "ok": true, "lastBlock": 1010 }
```

`lastBlock` is the block the served snapshot reflects, not the chain head. If it is stale, every
number you read below it is stale with it.

### `client.listVaults()`

**Paid.** The discovery surface: every vault the indexer knows.

```js
const { data, receipt } = await client.listVaults();
for (const v of data.vaults) {
  if (!v.attested) continue;            // operatorId 0 — scam-quarantine, see below
  console.log(v.vault, v.memberCount);
}
```

```json
{
  "vaults": [
    { "vault": "0x1111111111111111111111111111111111111111", "operatorId": 1,
      "memberCount": 2, "depth": 0, "parent": null,
      "capacityCapUsdc": "1000000000000", "attested": true },
    { "vault": "0x2222222222222222222222222222222222222222", "operatorId": 0,
      "memberCount": 1, "depth": 0, "parent": null,
      "capacityCapUsdc": "0", "attested": false }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `operatorId` | The `OperatorRegistry` key. **`0` means unattested.** |
| `attested` | `operatorId !== 0`. Vault creation is permissionless, so scam vaults exist. Treat unattested as quarantine, and verify the operator, not the name. |
| `depth` | Sub-vault depth. `0` is a root vault. |
| `capacityCapUsdc` | Base units. **`"0"` means UNCAPPED**, not "full" — the single most invertible field on this page. |

### `client.getVault(address)`

**Paid.** One vault in detail, including its active proposal if it has one.

```js
const { data } = await client.getVault('0x3333333333333333333333333333333333333333');
```

```json
{
  "vault": "0x3333333333333333333333333333333333333333",
  "creator": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
  "usdc": "0xcccccccccccccccccccccccccccccccccccccccc",
  "operatorId": 2,
  "totalShares": "104000000000",
  "idleUsdc": "0",
  "memberCount": 2,
  "pendingCount": 0,
  "capacityCapUsdc": "250000000000",
  "parent": null,
  "depth": 0,
  "holders": 2,
  "activeProposal": {
    "pid": 42, "vault": "0x3333…3333", "ptype": 0,
    "proposer": "0xaaaa…aaa2", "status": "Active",
    "forWeight": "0", "againstWeight": "0",
    "revealedWeight": "0", "revealedVoters": 0
  }
}
```

**An unknown vault is a paid 404.** The payment gate runs before route resolution, so a typo'd
address settles a payment and then returns `404 unknown vault`, thrown as a
[`ProtocolError`](#protocolerror). That is not a bug — under x402 the payment *is* the rate limiter,
and a free "does this exist?" probe would be the cheapest way to scrape the API. But it means you
should validate the address shape client-side, and it is a second reason to keep
[`onPayment`](#onpayment-is-not-optional-in-production): on the throw, the `receipt` is gone and
the envelope you recorded is the only surviving evidence of what you paid.

**Everything here is event-derived.** NAV per share, live basket balances, fee schedules,
observation-window timers, and governance deadlines are **not** in this response, because events
carry no post-swap balances and no oracle prices. Those are chain reads —
`VaultCore.navPerShareWad()`, `exitFeeBpsOf(member)`,
`Governance.hasPendingExecution(vault)`. See [Agent quickstart §6](AGENT-QUICKSTART.md#8-act-on-chain).

### `client.memberPosition(vault, member)`

**Paid.** One member's share position in one vault.

```js
const { data } = await client.memberPosition(vaultAddr, agentAddr);
```

```json
{
  "vault": "0x3333333333333333333333333333333333333333",
  "member": "0x000000000000000000000000000000000000dead",
  "shares": "1500000000",
  "shareOfVaultBps": 144
}
```

`shareOfVaultBps` is an integer in basis points (144 = 1.44%). It is **not** voting weight:
governance counts `pastVotingEligibleShares(member, proposalCreatedAt)`, which excludes shares
deposited after the proposal opened, shares still inside the observation window, and shares locked
behind a Mode-F exit. Committing a vote on this number casts votes that can never count.

### `client.leaderboard()`

**Paid.** Operator track record across **all** their vaults, losses included — no cherry-picking.

```js
const { data } = await client.leaderboard();
```

```json
{
  "leaderboard": [
    { "operatorId": 1, "operator": "0xaaaa…aaa1", "netRealizedUsdc": "36000000000",
      "lifetimeGainUsdc": "42000000000", "lifetimeLossUsdc": "6000000000",
      "lifetimeFeesUsdc": "3600000000", "vaultCount": 1 },
    { "operatorId": 2, "operator": "0xaaaa…aaa2", "netRealizedUsdc": "-15500000000",
      "lifetimeGainUsdc": "4000000000", "lifetimeLossUsdc": "19500000000",
      "lifetimeFeesUsdc": "0", "vaultCount": 1 }
  ]
}
```

Sorted by `netRealizedUsdc` descending, ties broken by fees. **`netRealizedUsdc` can be negative and
arrives as a decimal string, so parse it as `BigInt`, not `Number`** — these are 6-decimal base
units and a large vault's lifetime figures will exceed `Number.MAX_SAFE_INTEGER` in cents long
before they look large in dollars.

An operator with *no* realizations at all has no track record — "not yet negative" is not evidence.
The reference agent's `requireProvenOperator` gate refuses that case by default.

### `client.request(path)`

**Paid or free, depending on the route.** The escape hatch for anything the typed methods do not
cover yet, and the function every method above delegates to.

```js
const { data, receipt } = await client.request('/vaults');
```

It takes a path, not a URL, and appends it to `baseUrl` verbatim — so **you** must encode path
segments. It runs the full 402 loop and throws [`ProtocolError`](#protocolerror) on a non-2xx.

---

## `ProtocolError`

Thrown by every method on any non-2xx response.

```js
import { ProtocolError } from '@x402-vaults/agent-sdk';

try {
  await client.getVault('0x9999999999999999999999999999999999999999');
} catch (err) {
  if (err instanceof ProtocolError) {
    console.error(err.status, err.message, err.body);
    // → 404 'unknown vault' { error: 'unknown vault' }
  }
}
```

| Property | Type | Notes |
| --- | --- | --- |
| `status` | `number` | HTTP status. `402` after a failed settlement; `404` unknown vault; `429` rate-limited on a free route. |
| `body` | `object` | The parsed JSON body, or `{}` if it did not parse. |
| `message` | `string` | `body.error` when present, otherwise `HTTP <status>`. |

A `402` reaching you means the *paid retry* was also refused — the SDK already tried once. The
`body.error` names the reason: `underpaid`, `asset-mismatch`, `recipient-mismatch`,
`network-mismatch`, `authorization-expired`, `replayed-nonce`, or
`settlement failed: <facilitator reason>`. `signer-mismatch` from the facilitator almost always
means the [EIP-712 domain](#the-domain-is-the-one-you-are-most-likely-to-get-wrong) is wrong, not
the signature.

---

## Low-level: rolling the loop yourself

You do not need these to use the client. They are exported because an agent with its own HTTP
stack, its own retry policy, or a wallet behind an MCP tool boundary may want the pieces.

### `authorizeFromChallenge`

Challenge + wallet → the signed envelope for the `PAYMENT-SIGNATURE` header.

```js
import { authorizeFromChallenge } from '@x402-vaults/agent-sdk';

const envelope = await authorizeFromChallenge({
  challenge,                        // parsed from the 402's PAYMENT-REQUIRED header
  walletAddress: account.address,
  domain,                           // USDC EIP-712 domain for the challenge's chain
  sign: (td) => account.signTypedData(/* … */),
  nowSec: Math.floor(Date.now() / 1000),
});
// header value: Buffer.from(JSON.stringify(envelope)).toString('base64')
```

| Param | Default | Notes |
| --- | --- | --- |
| `ttlSec` | `300` | `validBefore = nowSec + ttlSec`. Must be `> 0`. |
| `skewSec` | `60` | `validAfter = nowSec − skewSec`. Must be `>= 0`. |

**Why `validAfter` is backdated at all.** EIP-3009 compares `validAfter` against the timestamp of
the block that *mines* the settlement, not against your clock, and the token reverts outright on
`validAfter >= block.timestamp`. A payer whose clock runs even slightly fast signs an authorization
that is not yet valid when it lands. The default was 5 seconds once; the margin observed in the live
Base Sepolia run was 64 seconds. 60 costs nothing and removes the whole failure class.

### `buildTypedData`

The EIP-712 payload, if you want to inspect or sign it yourself.

```js
import { buildTypedData } from '@x402-vaults/agent-sdk';
const typedData = buildTypedData({ authorization, domain });
```

Returns `{ types, primaryType: 'TransferWithAuthorization', domain, message }`. Note `types`
includes `EIP712Domain` — viem computes that itself and wants only the payload type, which is why
every example on this page passes
`types: { TransferWithAuthorization: td.types.TransferWithAuthorization }`.

### `buildEnvelope`

Wrap a signed authorization as the x402 V2 envelope.

```js
import { buildEnvelope } from '@x402-vaults/agent-sdk';
const envelope = buildEnvelope({ authorization, signature, network: 'base' });
// → { x402Version: 2, scheme: 'exact', network, signature, authorization }
```

---

## Spend control — read this before you point it at a funded wallet

Under EIP-3009, **a signature is the spend.** There is no step after signing at which you can
decline, and the SDK runs 402 → sign → retry inside a single call, so a budget check *after* the
call is too late.

Enforce the cap **inside the signer**:

```js
const CAP_BASE_UNITS = 250_000n;                  // $0.25 for this session
let spent = 0n;

const wallet = {
  address: account.address,
  sign: (td) => {
    const value = BigInt(td.message.value);
    if (spent + value > CAP_BASE_UNITS) throw new Error(`x402 budget exhausted: ${spent}/${CAP_BASE_UNITS}`);
    spent += value;                                // count it BEFORE the signature exists
    return account.signTypedData({
      domain: td.domain,
      types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
      primaryType: 'TransferWithAuthorization',
      message: td.message,
    });
  },
};
```

This catches the case a pre-call gate cannot: a server that answers with a challenge asking for more
than the advertised price. The reference agent layers both — a pre-call budget gate so an exhausted
budget skips the read cleanly, and this signer backstop underneath it. See
[REFERENCE-AGENT.md §4](REFERENCE-AGENT.md#the-x402-spend-cap).

Use a dedicated hot wallet funded per session. Never the treasury.

## Known gaps

Stated rather than discovered later:

- **No retry, no backoff, no timeout.** One 402, one paid retry, then it throws. A flaky network is
  your problem; wrap `request` if you need resilience.
- **No response validation.** `data` is whatever the server sent, parsed. There is no schema check
  against [openapi.yaml](api/openapi.yaml).
- **`request(path)` does not encode for you.** Interpolate addresses yourself, and validate them.
- **No routes for governance or history.** The metered API is a read projection of vault and
  operator state; proposals appear only inside `getVault`. Everything else is a chain read.
