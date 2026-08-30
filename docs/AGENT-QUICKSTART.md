# Agent Quickstart

Zero to an agent reading vault state through the x402-metered API, in about ten minutes, with **no
funded wallet and no testnet faucet**.

Every command on this page was executed on Windows PowerShell before it was written down, and the
output shown is the output it produced. Where something could **not** be executed — anything needing
a funded key — this page says so in place rather than presenting it as verified.

> **Shell.** The commands are PowerShell (Windows). PowerShell has no `&&` chaining and no inline
> `VAR=x cmd` prefix, so environment variables are set with `$env:NAME = "value"` on their own line.
> On macOS or Linux, translate `$env:NAME = "v"` to `export NAME=v`; nothing else changes.

- **The mechanism behind all of this:** [The x402 flow](X402-FLOW.md)
- **Method-by-method:** [Agent SDK reference](SDK-REFERENCE.md)
- **What is beta and what can freeze your exit:** [Limits and honest risks](LIMITS.md)
- **API contract:** [api/openapi.yaml](api/openapi.yaml) (OpenAPI 3.1 — generate a client from it)
- **Machine index:** [`/llms.txt`](../llms.txt)

---

## 1. What you will have at the end

A local metered API serving real indexed vault state, and an agent that:

1. reads the free discovery document to learn the price,
2. gets a `402` on a metered route,
3. signs an EIP-3009 `transferWithAuthorization` for $0.01 of USDC,
4. retries with the authorization, gets the data and a receipt,
5. prints the vault set, flagging the unattested one.

The whole x402 loop runs on the real code path. What is **not** real is the settlement: the
quickstart runs the API with `FACILITATOR=stub`, which accepts payments **without settling anything
on-chain.** No USDC moves. No nonce is burned. No signature is verified. See
[§7](#7-what-was-real-and-what-was-not) — that distinction matters more than it looks.

## 2. Prerequisites

| | Needed | Verified with |
| --- | --- | --- |
| Node.js | ≥ 20 (ES modules, global `fetch`) | `v24.18.0` |
| npm | any current | `11.16.0` |
| git | any current | `2.54.0.windows.1` |

You do **not** need Foundry, an RPC endpoint, a wallet, or any USDC for this quickstart. Foundry is
only needed to build the contracts, which nothing below does.

```powershell
git clone https://github.com/SlumperSan/agent-governed-vaults.git
cd agent-governed-vaults
npm install
```

`npm install` pulls one runtime dependency (`viem`, for the signer) and its transitive set — 13
packages, no build step.

## 3. Read the USDC domain from the token, do not hard-code it

Do this before anything else, because it is the single most likely reason a first x402 integration
fails, and it fails *silently*.

USDC's EIP-712 domain `name` is **not the same on every chain**. Signing under the wrong one does
not produce an error at signing time — it produces a structurally valid signature over a *different*
struct hash, which recovers to an unrelated address, and surfaces much later as an opaque
`signer-mismatch` from the facilitator. That message points at your signature; the fault is in your
config. It has bitten this codebase twice
([X402-LIVE-REPORT §7.1 and §7.6](X402-LIVE-REPORT.md)).

The values, read from the live tokens on 2026-08-29 — not copied from a constant:

| Chain | `name()` | `version()` | USDC address |
| --- | --- | --- | --- |
| Base mainnet (8453) | `"USD Coin"` | `"2"` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base Sepolia (84532) | `"USDC"` | `"2"` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

**Read it from the token instead of trusting that table.** The whole check is two `eth_call`s and no
dependencies — it is implemented in
[`docs/examples/read-vaults.mjs`](examples/read-vaults.mjs) as `resolveUsdcDomain`, and you can run
it standalone:

```powershell
node -e "import('./docs/examples/read-vaults.mjs').then(m => m.resolveUsdcDomain({ chainId: 84532, rpcUrl: 'https://sepolia.base.org' })).then(r => console.log(JSON.stringify(r, null, 2)))"
```

```json
{
  "domain": {
    "name": "USDC",
    "version": "2",
    "chainId": 84532,
    "verifyingContract": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
  },
  "source": "read from 0x036CbD53842c5426634e7929541eC2318f3dCF7e via https://sepolia.base.org"
}
```

This is the only step on this page that needs the public internet. If your network blocks it, skip
it — the rest of the quickstart runs entirely on localhost — but do not skip it in production code.

## 4. Seed a snapshot

The metered API serves the indexer's snapshot. There is no deployed vault history to index yet, so
seed one:

```powershell
node packages/reference-agent/fixtures/seed-snapshot.mjs ./data/demo-snapshot.json
```

```text
seeded ./data/demo-snapshot.json: 3 vaults, 2 operators, 1 proposal(s), lastBlock 1010
```

The `./data` directory is created for you if it does not exist. **The API is not stubbed or
special-cased for this**: the fixture folds synthetic events through the real projection code
([`packages/indexer/src/projections.mjs`](../packages/indexer/src/projections.mjs)) and writes them
with the real store, so the API loads this exactly as it would load one the live daemon produced.
Only the *events* are synthetic.

The three vaults are chosen to exercise the branches an agent has to handle: one attested and
profitable, one attested with a negative operator net and an open proposal, and one **never
attested** — `operatorId 0`, the scam-quarantine signal.

## 5. Start the metered API — terminal 1

PowerShell sets each variable on its own line; there is no inline `VAR=x cmd` form.

```powershell
$env:PRICE_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
$env:PRICE_PAYTO = "0x000000000000000000000000000000000000beef"
$env:FACILITATOR = "stub"
$env:STATE_PATH  = "./data/demo-snapshot.json"
node apps/api/src/serve.mjs
```

```text
{"level":"warn","service":"api","event":"facilitator.stub","msg":"payments are ACCEPTED WITHOUT on-chain settlement (dev only). Set FACILITATOR=http + FACILITATOR_URL for production."}
{"level":"info","service":"api","event":"listening","port":8402,"snapshot":"./data/demo-snapshot.json","lastBlock":1010,"reloadMs":5000,"facilitator":"stub","cors":false,"trustProxy":false,"rateLimit":"5/s burst 60"}
```

**Read that first line.** It is the API telling you it will accept any payment without settling it.
That is correct for local development and wrong for anything else.

This process stays in the foreground. **Leave it running and open a second terminal** for the rest.
(Do not reach for `Start-Job` here: in Windows PowerShell a background job does not inherit the
`$env:` variables you just set, so the server would exit complaining about missing `PRICE_ASSET`.)

Check it is up, from the second terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8402/health | ConvertTo-Json -Compress
```

```json
{"ok":true,"lastBlock":1010}
```

## 6. Run the agent — terminal 2

```powershell
node docs/examples/read-vaults.mjs --api=http://127.0.0.1:8402 --chain-id=84532
```

```text
agent wallet   0x839DA920844441b27b6F4eD7caD1F78EA6A1F3CF  (throwaway, in memory, never written to disk)
usdc domain    name="USDC" version="2" chainId=84532
               table (NOT verified against the token)
               ⚠  not read from the token. Pass --rpc=<url> before trusting this against a real facilitator.

discovery      $0.01 per metered read → 0x000000000000000000000000000000000000beef
               metered: /vaults, /vaults/{address}, /vaults/{address}/members/{member}, /operators/leaderboard
health         ok=true lastBlock=1010

GET /vaults    3 vault(s)   receipt stub_1_0x7752dd32
  0x1111111111111111111111111111111111111111  operatorId=1  members=2  depth=0
  0x3333333333333333333333333333333333333333  operatorId=2  members=2  depth=0
  0x2222222222222222222222222222222222222222  operatorId=0  members=1  depth=0   ⚠ UNATTESTED — treat as scam-quarantine

GET /operators/leaderboard   2 operator(s)
  operatorId=1  net realized $36000  vaults=1
  operatorId=2  net realized $-15500  vaults=1

paid 2 time(s), 0.02 USDC authorized in total.
```

Add `--rpc=https://sepolia.base.org` to read the domain from the token instead of the table, and
`--vault=0x3333333333333333333333333333333333333333` to fetch one vault in detail. `--json` emits a
single machine-readable object instead of prose.

**That is the whole loop.** The source is
[`docs/examples/read-vaults.mjs`](examples/read-vaults.mjs) — about 100 lines of actual logic, and
it is executed by the repository's test gate, so it cannot rot without the build going red.

### The eight lines that matter

```js
import { createProtocolClient } from '@x402-vaults/agent-sdk';

const client = createProtocolClient({
  baseUrl: 'http://127.0.0.1:8402',
  wallet: { address: account.address, sign: (td) => account.signTypedData({
    domain: td.domain,
    types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
    primaryType: 'TransferWithAuthorization',
    message: td.message,
  }) },
  domain,                                   // ← from §3, read from the token
  onPayment: ({ path, envelope }) => paid.push({ path, envelope }),
});

const { data } = await client.listVaults();  // 402 → sign → retry, all inside this call
```

Note `types` drops `EIP712Domain`: the SDK includes it (it is part of the standard payload), and
viem computes it itself and wants only the payload type.

Note also `onPayment`. It fires after the authorization is signed and **before** the paid retry. A
receipt id is a broadcast transaction hash and nothing more — it cannot be replayed or re-verified
against the chain, and if the paid request then fails you never see it at all, because the SDK
throws. The envelope is the durable evidence of what you paid. Record it.

### Spend control, before you point this at a real wallet

Under EIP-3009 **a signature is the spend** — there is no step afterwards at which you can decline,
and the 402 → sign → retry round trip happens inside a single SDK call. So a budget check *around*
the call is too late. Put it *inside the signer*:

```js
let spent = 0n;
const CAP = 250_000n;                                   // $0.25 for this session
const sign = (td) => {
  const value = BigInt(td.message.value);
  if (spent + value > CAP) throw new Error('x402 budget exhausted');
  spent += value;                                       // count before the signature exists
  return account.signTypedData(/* … */);
};
```

This also catches a hostile server that answers with a challenge asking for more than its advertised
price. Use a dedicated hot wallet funded per session; never the treasury.

## 7. What was real, and what was not

Being precise about this is the point of the section.

| | |
| --- | --- |
| **Real** | The SDK, the 402 challenge, the EIP-712 signature, the envelope, the header round trip, the projections, the route handlers, and the served data. |
| **Real** | The USDC domain read in §3 — two live `eth_call`s against Base Sepolia. |
| **Synthetic** | The *events* behind the snapshot. Real projection code, fixture inputs. |
| **NOT real** | **The settlement.** `FACILITATOR=stub` accepts every payment without touching a chain. No USDC moved, no nonce was burned, and **your signature was never verified.** |

That last row has a consequence worth internalising: **the stub will happily accept a signature made
under the wrong EIP-712 domain.** A green local run does not prove your domain config is right — it
proves your code compiles and your headers are shaped correctly. The first time you point this at a
real facilitator is the first time the domain is actually checked. That is why §3 is step three and
not an appendix.

To settle for real you need a funded key, and this page **cannot** show you a verified transcript of
that, because doing so requires spending real USDC on a real chain. What exists instead is a
recorded run someone else did with a funded key: [docs/X402-LIVE-REPORT.md](X402-LIVE-REPORT.md) —
one settlement on Base Sepolia, tx
`0xd0a777b7…6a84`, 10,000 base units moved, replay rejected as `authorization-used`, 14 independent
`cast` checks passed. Read that rather than trusting an unrun command here.

To move from stub to real, set `FACILITATOR=http` and `FACILITATOR_URL=<facilitator>` on the API,
and read [The x402 flow §8](X402-FLOW.md#8-local-development-and-the-honest-caveat-about-it).

## 8. Act on-chain

The metered API is read-only. Every state change goes directly to the contracts (ABIs in
`contracts/out/` after `forge build`). The agent-relevant entrypoints:

| Goal | Call | Notes |
| --- | --- | --- |
| Join a vault | `VaultCore.deposit(amountUsdc)` | First deposit enters a **4-hour observation window** (no shares, no votes yet). Call `activate(self)` after the window, or `skipWindow()` to opt in immediately — **irreversible, once per vault**. |
| Propose | `Governance.propose(vault, ptype, actionHash)` | Needs ≥ `proposalThresholdBps` of eligible stake. `ptype`: 0 Rebalance, 1 RuleChange, 2 ChildAllocation. |
| Vote | `Governance.commitVote(pid, hash)` then `revealVote(pid, support, salt)` | **Commit-reveal — two transactions.** `hash = keccak256(abi.encode(pid, voter, support, salt))`. Missing the reveal window forfeits your vote and it counts as an abstain. |
| Delegate | `Governance.setDelegate(vault, delegate)` | Concentration-capped on the delegate's *received* weight. |
| Exit | `VaultCore.requestExit(shares)` | Instant pro-rata **in-kind** (Mode I). If a rebalance is passed-but-pending it queues and settles at **post-rebalance NAV** (Mode F) — call `settleQueuedExit(self)` after execution. |

**Read before you act:** `VaultCore.navPerShareWad()`,
`pastVotingEligibleShares(member, ts)`, `exitFeeBpsOf(member)`,
`Governance.hasPendingExecution(vault)`.

A complete worked implementation of all of this — including commit-reveal salt derivation that
survives a restart — is [the reference agent](REFERENCE-AGENT.md). Read
[its limitations](LIMITS.md#2-the-reference-agent-is-a-demonstration-not-a-product) first.

## 9. Protocol semantics an integrating agent must respect

These are the ones that cost money when an integration gets them wrong.

- **`capacityCapUsdc: "0"` means UNCAPPED, not full.** The most invertible field in the API.
- **`operatorId: 0` means unattested.** Vault creation is permissionless, so scam vaults exist and
  can claim any branding they like. Operator identity is the registry key
  (`OperatorRegistry.operatorOf(vault)`), never display metadata. Verify the operator, not the name.
- **Voting weight is not your share balance.** Governance counts
  `pastVotingEligibleShares(member, proposal.createdAt)`. Shares deposited after the proposal
  opened, shares still inside the observation window, and shares locked behind a Mode-F exit carry
  **no** vote. Committing on `sharesOf` casts votes that can never count.
- **Observation window.** A first deposit is sequestered 4 h with no shares and no vote. Budget for
  it. `skipWindow()` is irreversible and once per vault.
- **Forward pricing.** Exiting between a vote passing and its execution settles at the *post*-
  rebalance price — you carry the outcome of a trade you did not choose.
- **Oracle breaker.** If the median goes stale, **everything freezes, including exits**, by design.
  A failed NAV read is not a warning; it is the freeze. Pending capital stays reclaimable; active
  shares do not.
- **Fees stack multiplicatively.** 10% of realized profit per level, compounding up a sub-vault
  chain (`keep = keep × 0.9`), so two levels is **19%** effective, not 10%. Plus an exit fee ≤1%
  decaying with tenure, paid to the remaining members. Read
  `SubVaultRegistry.stackedPerfFeeBps(vault)` / `stackedExitFeeCapBps(vault)`; never assume the base
  rate.
- **Reputation is portable.** Realized losses under an operator shelter your future gains under that
  *same operator* from fees, across vaults.
- **Shares are non-transferable.** Exiting is the only way out.

## 10. Index the chain yourself (optional)

[`packages/indexer`](../packages/indexer) folds normalized events into vault and operator state with
deterministic replay. Point `src/chain.mjs` at your own RPC plus the factory and registry addresses
to run your own projection instead of — or alongside — the metered API. That removes the per-read
cost and the trust in someone else's snapshot, at the price of running a daemon.

## 11. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `api: missing required env: PRICE_ASSET, PRICE_PAYTO` | The variables were set in a different terminal, or in a `Start-Job` block that did not inherit them. Set them in the same shell that runs `node`. |
| `signer-mismatch` from the facilitator | The EIP-712 domain, almost always — not the signature. Go back to [§3](#3-read-the-usdc-domain-from-the-token-do-not-hard-code-it) and read `name()`/`version()` off the token. |
| `402 payment invalid: replayed-nonce` | The authorization nonce was already used. Nonces are burned permanently per `(payer, nonce)`; start a fresh 402 rather than re-signing. |
| `402 payment invalid: underpaid` | `challenge.amount` is in **base units, 6 decimals**. `"10000"` is $0.01. |
| `404 unknown vault` — and you were charged | Expected. The payment gate runs before route resolution, so a typo'd address settles first and 404s second. Validate addresses client-side. |
| `ECONNREFUSED 127.0.0.1:8402` | Terminal 1 is not running, or it exited on a config error. Check its output. |
| `429` on `/health` | The free routes are rate-limited (5/s, burst 60). The metered routes are not — under x402 the payment *is* the rate limiter. |

## 12. Read the docs locally

The whole documentation set renders as a site that reads these markdown files at runtime:

```powershell
node docs/site/serve.mjs
```

Then open <http://127.0.0.1:8403/docs/site/>. It must be **served**, not opened from the
filesystem — a browser blocks `fetch()` over `file://`, so double-clicking `index.html` shows an
empty shell.
