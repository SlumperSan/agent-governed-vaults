# Runtime guide — running the live stack

This is the operator runbook for the three runtime processes that turn deployed contracts into a
live product: the **indexer**, the **API**, and the **web** front end. Everything here is
**non-custodial** — no process in this repo holds a private key or moves funds. Payment settlement
is delegated to an external **facilitator**.

For the tested internals behind each piece, see [ARCHITECTURE.md](ARCHITECTURE.md); for contract
deployment, [DEPLOYMENT.md](DEPLOYMENT.md) — and for the operational Base Sepolia path that
produces the addresses this guide consumes, [TESTNET-CHECKLIST.md](TESTNET-CHECKLIST.md)
(`DeployTestnet.s.sol` driven by [`contracts/config/base-sepolia.json`](../contracts/config/base-sepolia.json)).

> Note (Sprint 7): contract deployment was blocked by
> [issue #10](https://github.com/SlumperSan/agent-governed-vaults/issues/10) (`VaultFactory` over
> the EIP-170 size cap) and no longer is. The runtime stack below is unaffected either way — it is
> independently tested and runs against any deployed address set.

---

## 1. How the pieces fit

```
   Base RPC ──logs──▶  indexer  ──snapshot file──▶  API  ──HTTP/x402──▶  web
 (viem getLogs)     (index-runner.mjs)  (JSON)   (serve.mjs)          (index.html?api=)
       │                                   │             │
       │                          (reads)  │    verifyAndSettle │ (no key here)
       │                                   ▼             ▼
       └──eth_call / eth_getLogs──▶      canary    facilitator (external)
              (read-only)         (canary-runner.mjs)  verifies EIP-712 sig + settles
                                  alerts on transition  USDC.transferWithAuthorization
```

- The **indexer** reads real logs from a Base RPC via viem, folds them into projection state, and
  writes an atomic **snapshot file** on an interval. It resumes from that snapshot on restart.
- The **API** loads the snapshot and reloads it on an interval (separate process, shared file). It
  serves read routes gated by the x402 payment scheme. It holds **no key** — it asks a facilitator
  to verify+settle each payment.
- The **facilitator** is where settlement (and the only key) lives. In production this is a
  **remote HTTP facilitator** you point the API at. You may also run your own settler — this repo
  ships one (`apps/api/src/facilitator-server.mjs`), proven live on Base Sepolia (§6).
- The **canary** watches the deployed contracts for the [DEPLOYMENT §6](DEPLOYMENT.md) signals and
  alerts on transitions. It reads the chain directly (`eth_call`/`eth_getLogs`) and reads — never
  writes — the indexer snapshot, which two of its signals compare against chain state. It is
  read-only on top of being keyless: no wallet client, no account, never sends a transaction. Full
  guide in [CANARY.md](CANARY.md).
- The **web** app is self-contained demo by default; with `?api=<url>` it renders live data.

**Wiring order** (each step needs the previous one's output):

1. Deploy the contracts → record the **factory / operator-registry / sub-vault-registry /
   governance** addresses and the **deploy block**.
2. Start the **indexer** with the RPC + those addresses. Let it catch up.
3. Start the **API** pointed at the same snapshot file + a facilitator + the USDC price.
4. Open the **web** app with `?api=<api-url>` (or ship the API URL into a deployed build).
5. Start the **canary** against the same RPC + snapshot, once the indexer has caught up. It is
   independent of the API and the web app — run it from step 2 onward if you prefer.

---

## 2. Prerequisites

- **Node 24+** (`node --version`).
- **viem** — the sole runtime dependency, lazily imported. Install it once at the repo root:
  ```bash
  npm install
  ```
  (The test suite needs no dependencies; only the running indexer/API/settler import viem.)
- A **Base RPC URL** (mainnet `8453` or Base Sepolia `84532`). A public endpoint works for low
  volume; use a provider endpoint for production throughput.
- **Deployed contract addresses** + the **deploy block**. On testnet these come from the
  `DeployTestnet.s.sol` run; the verified Base Sepolia infrastructure addresses (USDC, router,
  Chainlink feeds) live in `contracts/config/base-sepolia.json` (ships with the testnet-deploy work).
- The **USDC address** on your chain and a **payTo** address to receive metered-read payments.

---

## 3. Run locally (stub facilitator)

The fastest path to "real vault data flowing to the front end". Uses the accept-all **stub**
facilitator so you don't need a live facilitator to see the loop work. **Stub accepts payments
without on-chain settlement — dev only.**

```bash
npm install                      # pulls viem
cp .env.example .env             # then edit .env (see the table in §5)
```

**Terminal 1 — indexer:**
```bash
RPC_URL=https://sepolia.base.org \
CHAIN_ID=84532 CHAIN_NAME=base-sepolia \
FACTORY_ADDRESS=0x… OPERATOR_REGISTRY_ADDRESS=0x… \
SUBVAULT_REGISTRY_ADDRESS=0x… GOVERNANCE_ADDRESS=0x… \
START_BLOCK=<deploy-block> STATE_PATH=./data/indexer-state.json \
npm run start:indexer
```
It logs `indexed [from..to] — N events, now at <block>` as it catches up, then idles at the head.

**Terminal 2 — API:**
```bash
PRICE_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
PRICE_PAYTO=0x<your-recipient> PRICE_NETWORK=base-sepolia \
STATE_PATH=./data/indexer-state.json PORT=8402 CORS=1 FACILITATOR=stub \
npm run start:api
```

**Verify:**
```bash
curl -s localhost:8402/health                 # {"ok":true,"lastBlock":…}
curl -s localhost:8402/.well-known/x402        # pricing + route map (free)
curl -si localhost:8402/vaults | head -1       # 402 Payment Required (metered)
```

**Terminal 3 — web** (any static server rooted at `apps/web`, so `./src/*.mjs` resolves):
```bash
cd apps/web && python3 -m http.server 8080
```
Open `http://localhost:8080/index.html?api=http://localhost:8402`. You'll see a **Live API** banner
and the indexed vaults/operators. Drop the `?api=` param and it falls back to the embedded demo.

> Live mode reads are metered over x402. In the browser the SDK signs with a **dev signer** (a dummy
> signature the stub facilitator accepts) — the browser never holds a real key. Against a real
> settling facilitator that dummy signature is rejected, which is correct: the browser demo is not
> meant to move funds. NAV/share, basket weights, and proposal phases are chain-read enrichment the
> API does not expose yet, so live mode shows those as placeholders (the banner says so).

---

## 4. Run in production (Docker + remote facilitator)

Production swaps the stub for a **remote HTTP facilitator** (which holds the settlement key, not
you) and runs both processes from one image sharing a snapshot volume.

```bash
cp .env.example .env     # fill in RPC_URL, addresses, PRICE_*, and:
                         #   FACILITATOR=http
                         #   FACILITATOR_URL=https://<your-facilitator>/settle
docker compose up --build
```

`docker-compose.yml` runs `indexer` (writes `/data/indexer-state.json`) and `api` (reads it,
publishes `:8402`) against a shared `vault-state` volume. Both `restart: unless-stopped`.

Production notes:
- Put the API behind TLS (a reverse proxy). `CORS=1` is required if the browser front end is served
  from a different origin than the API.
- Size `CONFIRMATIONS` for your reorg tolerance and `POLL_INTERVAL_MS` (~one Base block ≈ 2s; the
  default 12s is conservative). `BATCH_BLOCKS` caps each `getLogs` range for RPC limits.
- The API serves **stale-but-valid** state if a snapshot reload ever fails (corrupt/partial write),
  and logs it — it never serves a torn read (snapshots are written temp-then-rename).
- Back up / persist the snapshot volume to avoid a full re-index on a fresh host (or set
  `START_BLOCK` to the deploy block so a cold start skips empty history).

---

## 5. Environment variables

### Indexer (`npm run start:indexer`)

| Var | Required | Default | Meaning |
|---|---|---|---|
| `RPC_URL` | ✅ | — | Base HTTP RPC endpoint |
| `FACTORY_ADDRESS` | ✅ | — | VaultFactory |
| `OPERATOR_REGISTRY_ADDRESS` | ✅ | — | OperatorRegistry |
| `SUBVAULT_REGISTRY_ADDRESS` | ✅ | — | SubVaultRegistry |
| `GOVERNANCE_ADDRESS` | ✅ | — | Governance |
| `CHAIN_ID` | | `8453` | `8453` Base, `84532` Base Sepolia |
| `CHAIN_NAME` | | `base` | label for the viem chain |
| `START_BLOCK` | | `0` | deploy block — skip empty history on a cold start |
| `STATE_PATH` | | `./data/indexer-state.json` | snapshot file (share with the API) |
| `CONFIRMATIONS` | | `5` | blocks to lag behind head (reorg safety) |
| `BATCH_BLOCKS` | | `2000` | max blocks per `getLogs` batch |
| `POLL_INTERVAL_MS` | | `12000` | poll cadence once caught up |

### API (`npm run start:api`)

| Var | Required | Default | Meaning |
|---|---|---|---|
| `PRICE_ASSET` | ✅ | — | USDC contract address (payment denomination) |
| `PRICE_PAYTO` | ✅ | — | recipient of metered-read payments |
| `PRICE_AMOUNT` | | `10000` | price in USDC base units (6dp); `10000` = $0.01 |
| `PRICE_NETWORK` | | `base` | network label echoed in the x402 challenge |
| `FACILITATOR` | | `stub` | `stub` (dev, accept-all) or `http` (remote settler) |
| `FACILITATOR_URL` | if `http` | — | remote facilitator endpoint |
| `STATE_PATH` | | `./data/indexer-state.json` | snapshot file (share with the indexer) |
| `PORT` | | `8402` | HTTP listen port |
| `RELOAD_MS` | | `5000` | snapshot re-read cadence |
| `CORS` | | off | `1`/`true` to enable CORS + preflight (browser live mode) |

### Settling facilitator (`scripts/live-x402-run.mjs`, or your own runner — §6)

Only relevant if you run your own settler. **This is the one process that holds a key.**

| Var | Required | Default | Meaning |
|---|---|---|---|
| `FACILITATOR_I_UNDERSTAND_THIS_SPENDS_FUNDS` | ✅ | — | must be exactly `yes`; startup refuses otherwise |
| `SETTLER_KEYSTORE` | ✅ | — | path to a V3 keystore file (e.g. `~/.foundry/keystores/<name>`) |
| `SETTLER_KEYSTORE_PASSWORD` | ✅ | — | decrypted in-process; the key never enters the environment |
| `RPC_URL` | | Base Sepolia public node | JSON-RPC endpoint |
| `USDC_ADDRESS` | | Base Sepolia USDC | settlement token |

A raw `SETTLER_PRIVATE_KEY` / `PAYER_PRIVATE_KEY` in the environment is **rejected**, not honoured:
a key in env is one leaked shell history, `ps` listing or crash dump away from a drained wallet.

### Canary (`npm run start:canary`)

Read-only post-launch monitor — see [CANARY.md](CANARY.md) for what each signal means and what to do
when one fires. Reuses `RPC_URL`, `CHAIN_ID`, `CHAIN_NAME`, `CONFIRMATIONS`, `STATE_PATH`, and
`OPERATOR_REGISTRY_ADDRESS` from the indexer block above.

| Var | Required | Default | Meaning |
|---|---|---|---|
| `RPC_URL` | ✅ | — | Base HTTP RPC endpoint |
| `STATE_PATH` | | `./data/indexer-state.json` | indexer snapshot; the vault set is discovered from it (read-only) |
| `VAULTS` | | — | explicit vault list, to run without an indexer |
| `OPERATOR_REGISTRY_ADDRESS` | | — | enables the fee-routing signal |
| `CANARY_STATE_PATH` | | `./data/canary-state.json` | its OWN transition state — never the indexer's |
| `CANARY_POLL_INTERVAL_MS` | | `30000` | sweep cadence; named apart from the indexer's `POLL_INTERVAL_MS` |
| `ALERT_WEBHOOK_URL` | | — | POST one JSON body per transition |
| `NAV_DIVERGENCE_BPS` | | `50` | NAV composition bar, 50 = 0.5% |
| `ORACLE_MIN_MARGIN` | | `0` | alert when fresh sources minus quorum <= this |
| `HEARTBEAT_MS` | | `0` (off) | periodic "still watching" line |

The `PRICE_ASSET`/`PRICE_NETWORK`/`CHAIN_ID` must agree across the API and whatever wallet/agent
pays: the challenge binds the payment to that exact asset + network.

---

## 6. Running your own settling facilitator

If you don't use a third-party facilitator, run your own settler. It recovers the EIP-712 payer from
the signed authorization and settles `USDC.transferWithAuthorization` on-chain. **It needs a funded
account to pay gas — a key you supply and control.** This repo never embeds, reads from env, or logs
a key: the facilitator takes a viem account you inject at runtime.

This path is no longer theoretical. It has settled a real paid read on Base Sepolia — see
[X402-LIVE-REPORT.md](X402-LIVE-REPORT.md) for the transaction hashes, balance deltas, gas costs and
the replay rejection, all verified independently with `cast`.

### 6.1 The entrypoint

`apps/api/src/facilitator-server.mjs` exports `startFacilitatorServer(...)`, which wraps
`createSettlingFacilitator` in exactly the HTTP shape `createHttpFacilitator` posts:

```
POST /settle   { x402Version: 2, challenge, envelope }  →  { ok: true, receiptId }
                                                        →  { ok: false, reason }
GET  /health                                            →  { ok, settler, chainId, usdc, domain }
```

Note the status-code convention: a payment that was understood and **rejected** comes back as
`200 {ok:false, reason}`, not a 4xx. `createHttpFacilitator` collapses any non-2xx into
`facilitator-http-<status>` and discards the body, so anything the payer could act on — an expired
authorization, a burned nonce — must return 200 or the reason is lost in transit. 4xx is reserved
for a malformed request, 500 for an internal fault.

### 6.2 Starting it

The server never builds an account. Write a small runner you own that injects one — see
`scripts/live-x402-run.mjs` for a complete working example, including keystore decryption that
keeps the private key out of your environment and your shell history:

```js
import { privateKeyToAccount } from 'viem/accounts';
import { startFacilitatorServer } from './apps/api/src/facilitator-server.mjs';

const account = privateKeyToAccount(/* … your key, never from env … */);
await startFacilitatorServer({
  account,
  publicClient,          // viem PublicClient
  walletClient,          // viem WalletClient built from `account`
  usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  chainId: 84532,
  port: 8403,
});
```

Then point the API at it and keep the API keyless:

```
FACILITATOR=http FACILITATOR_URL=http://127.0.0.1:8403/settle npm run start:api
```

Startup refuses, rather than degrades, on any of three conditions:

| Condition | Why it is fatal |
|---|---|
| No injected account | There is nothing to sign with. A "dry-run" fallback would teach you the flag is optional. |
| `FACILITATOR_I_UNDERSTAND_THIS_SPENDS_FUNDS` ≠ `yes` | This process broadcasts transfers and burns gas. Consent is explicit, mirroring the reference agent's execute gate. |
| The token's EIP-712 domain doesn't reproduce its own `DOMAIN_SEPARATOR()` | Every settlement would fail signature recovery. Better a loud refusal now than an opaque `signer-mismatch` per request. |

### 6.3 The EIP-712 domain is read from the token, never hardcoded

FiatTokenV2 deployments genuinely disagree on the domain `name`. Mainnet USDC reports `"USD Coin"`;
**Base Sepolia's `0x036CbD…F7e` reports `"USDC"`**. Signing under the wrong name does not fail
loudly — it produces a structurally valid signature over a different struct hash, which recovers to
an unrelated address and surfaces as `signer-mismatch`, pointing at the signature rather than at the
config that actually broke.

So the facilitator reads `name()` and `version()` at boot, recomputes the domain separator, and
refuses to start unless it equals what the token reports. Do the same on the payer side rather than
trusting a constant. To check a chain by hand:

```
cast call <usdc> 'name()(string)' --rpc-url <rpc>
cast call <usdc> 'version()(string)' --rpc-url <rpc>
cast call <usdc> 'DOMAIN_SEPARATOR()(bytes32)' --rpc-url <rpc>
```

### 6.4 Per-request path

Shape validation → server-side price re-check → recover signer == `authorization.from` → on-chain
`authorizationState` nonce check → `simulateContract` → `writeContract`. The receipt id returned to
the client is the settlement tx hash.

The **price re-check** is defense in depth, and it is not redundant with the API's own check. The
API's check protects the API from a lying payer; this one protects your funded account from a lying
*caller*. Without it the service is an open relay: anyone who can reach it can have it broadcast any
authorization they hold, to any recipient, at your gas expense. Bind it to a trusted API and do not
expose it publicly — it defaults to `127.0.0.1`.

### 6.5 Replay protection has two independent layers

They fail differently and you should not mistake one for the other:

- **API, local:** an in-memory `seenNonces` set rejects a resubmitted envelope as `replayed-nonce`
  before the facilitator is ever called. Cheap, but process-local — it does not survive a restart
  and does not cover a second API instance.
- **Chain, authoritative:** EIP-3009 burns the nonce per `(authorizer, nonce)`. The facilitator
  checks `authorizationState` and returns `authorization-used`. This is the real guarantee, and it
  holds across processes, restarts and operators.

Both were exercised live; see the report.

---

## 7. Non-custodial guarantees

- The **indexer** is read-only: `getLogs` and `getBlockNumber` only. It never signs or sends.
- The **canary** is read-only too: `eth_call`, `eth_getLogs`, `eth_blockNumber`,
  `eth_getBlockByNumber`. It builds a viem *public* client — there is no wallet client, no account,
  and no key in `packages/canary`. Its `requestExit` probe is an `eth_call` with an impersonated
  `from`, which never touches a key and never changes chain state. Enforced by tests, not just
  documented.
- The **API** holds no key. It only asks a facilitator to `verifyAndSettle`; it serves the resource
  when settlement succeeds. USDC moves via EIP-3009 executed **by the facilitator**, from payer to
  `payTo`, never through the API.
- The **web** browser signer is a dummy against a dev facilitator; real signing is the user's wallet.
- The only key in the whole stack is the settlement key inside the facilitator (yours in §6, or the
  third party's), which is a **relayer** paying gas — it never takes custody of vault funds.
