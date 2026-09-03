# Runtime guide — running the live stack

This is the operator runbook for the three runtime processes that turn deployed contracts into a
live product: the **indexer**, the **API**, and the **web** front end. Everything here is
**non-custodial** — no process in this repo holds a private key or moves funds. Payment settlement
is delegated to an external **facilitator**.

**Running it is §1–§7; keeping it running is [§8 Operations](#8-operations)** — log format, backup
and restore, rate limits, metrics, the `ops-check` script and an incident quick-table.

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

`docker-compose.yml` runs `indexer` (writes `/data/indexer-state.json`), `api` (reads it, publishes
`:8402`) and `canary` against a shared `vault-state` volume. All three are `restart: unless-stopped`
and carry a **healthcheck** that reads that service's own heartbeat file (§8.2), so a process that
is up but wedged — the failure a restart policy never notices — shows as `unhealthy` in
`docker compose ps`. Each also has a `stop_grace_period` long enough for its shutdown hooks (§8.6).

Every service's `command:` is the **exec-form array running `node` directly**, so `node` is PID 1
and receives Docker's SIGTERM. `command: npm run start:*` puts **npm** at PID 1, and npm does not
forward the signal — the hooks §8.6 describes then never run, and `stop_grace_period` becomes dead
configuration. The compose file carries the measurement; do not "simplify" those lines back to npm.

The volume Compose creates is named **`<project>_vault-state`**, not `vault-state` — see §8.3
before pointing any `docker run` at it.

Production notes:
- Put the API behind TLS (a reverse proxy). `CORS=1` is required if the browser front end is served
  from a different origin than the API.
- Size `CONFIRMATIONS` for your reorg tolerance and `POLL_INTERVAL_MS` (~one Base block ≈ 2s; the
  default 12s is conservative). `BATCH_BLOCKS` caps each `getLogs` range for RPC limits.
- The API serves **stale-but-valid** state if a snapshot reload ever fails (corrupt/partial write),
  and logs it — it never serves a torn read (snapshots are written temp-then-rename).
- Back up / persist the snapshot volume to avoid a full re-index on a fresh host (or set
  `START_BLOCK` to the deploy block so a cold start skips empty history). The rotating backup ring
  and the restore procedure are in §8.3.
- Set `TRUST_PROXY=1` **only** when that reverse proxy overwrites `x-forwarded-for`; otherwise the
  per-IP rate limiter buckets every client together. See §8.4 — the header is client-spoofable, so
  the wrong answer here is worse than either default.

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
| `FEE_ENGINE_ADDRESS` | | — | FeeEngine. The **zero address counts as unset** (it is a valid 20-byte address and truthy, so a placeholder would otherwise suppress the warning below). **Unset is almost always a mistake** — every deploy script deploys one. Without it `FeeAssessed` / `FeeCredited` / `FeesClaimed` are not indexed and the indexer logs a `indexer.feeEngine.unset` warning at startup. Take it from `singletons.FeeEngine` in `contracts/config/deployments/<chain>.json`. |
| `ADAPTER_ADDRESSES` | | — | Comma-separated execution adapters. Polled unconditionally and **exempt from the 64-adapter discovery ceiling**, so an adapter you name here can never be crowded out by adapters an attacker stood up first (`createVault` is permissionless and `allowedAdapters` is caller-supplied). Adapters are a **per-vault** choice (`docs/DEPLOYMENT.md` "Execution adapters (per-vault)"), so their distinct count scales with creators — name yours rather than relying on discovery. Unset = discovery only; the indexer logs `indexer.adapterCap.hit` once per batch when it declines one. |
| `CHAIN_ID` | | `8453` | `8453` Base, `84532` Base Sepolia |
| `CHAIN_NAME` | | `base` | label for the viem chain |
| `START_BLOCK` | | `0` | deploy block — skip empty history on a cold start |
| `STATE_PATH` | | `./data/indexer-state.json` | snapshot file (share with the API) |
| `CONFIRMATIONS` | | `5` | blocks to lag behind head (reorg safety) |
| `BATCH_BLOCKS` | | `2000` | max blocks per `getLogs` batch |
| `POLL_INTERVAL_MS` | | `12000` | poll cadence once caught up |
| `SNAPSHOT_BACKUPS` | | `3` | rotating backup copies kept (§8.3); `0` disables |
| `SNAPSHOT_BACKUP_INTERVAL_MS` | | `300000` | minimum spacing between backups — not per write |
| `HEARTBEAT_DIR` | | dirname of `STATE_PATH` | where `indexer.heartbeat.json` is written (§8.2) |
| `LOG_FORMAT` | | TTY-dependent | `json` or `pretty` (§8.1) |
| `LOG_LEVEL` | | `info` | `debug` \| `info` \| `warn` \| `error` |

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
| `RATE_LIMIT_PER_SEC` | | `5` | per-IP sustained rate on the FREE routes; `0` disables (§8.4) |
| `RATE_LIMIT_BURST` | | `60` | per-IP burst on the free routes |
| `RATE_LIMIT_MAX_IPS` | | `10000` | cap on tracked IPs |
| `TRUST_PROXY` | | off | honour `x-forwarded-for` — ONLY behind a proxy that overwrites it |
| `MAX_URL_BYTES` | | `2048` | longer request-target → `414` |
| `MAX_BODY_BYTES` | | `8192` | larger request body → `413` |
| `MAX_HEADER_BYTES` | | `16384` | Node's header cap |
| `HEARTBEAT_DIR` | | dirname of `STATE_PATH` | where `api.heartbeat.json` is written (§8.2) |
| `LOG_FORMAT` / `LOG_LEVEL` | | | as above (§8.1) |

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
| `PAGE_WEBHOOK_URL` | | — | POST one JSON body per **PAGE-tier** transition — the wake-a-human set (docs/CANARY.md §5.3) |
| `LOG_WEBHOOK_URL` | | — | POST one JSON body per **LOG-tier** transition — everything else |
| `ALERT_WEBHOOK_URL` | | — | back-compat fallback for whichever of the two above is unset; set only this and behaviour is pre-tiering |
| `DEADMAN_PING_URL` | | — | off-host dead-man's switch, `GET` once per successful sweep that watched **at least one vault** (docs/CANARY.md §5.3) |
| `CANARY_TEST_ALERT_ON_START` | | off | `1`/`true`: fire the alert self-test at startup. **Fires on every restart** — see docs/CANARY.md §5.3 |
| `NAV_DIVERGENCE_BPS` | | `50` | NAV composition bar, 50 = 0.5% |
| `ORACLE_MIN_MARGIN` | | `0` | retired-oracle deployments only — alert when fresh sources minus quorum <= this |
| `ORACLE_FEED_CADENCE_SECONDS` | | — | `ChainlinkOracle` only — `addr:seconds` feed cadences that drive the derived early-warning bar (docs/CANARY.md §3a) |
| `ORACLE_STALENESS_WARN_PCT` | | unset (derived) | `ChainlinkOracle` only — manual override of that bar; unset lets it derive from the cadence above |
| `HEARTBEAT_MS` | | `3600000` (one hour) | periodic "still watching" line (distinct from the heartbeat FILE in §8.2). Non-negotiable per security-ops.md §5.2; set `0` to explicitly opt out |
| `SNAPSHOT_BACKUPS` / `SNAPSHOT_BACKUP_INTERVAL_MS` | | `3` / `300000` | backup ring for the canary state file too (§8.3) |
| `HEARTBEAT_DIR` | | dirname of `STATE_PATH` | where `canary.heartbeat.json` is written (§8.2) |
| `LOG_FORMAT` / `LOG_LEVEL` | | | as above (§8.1) |

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

---

## 8. Operations

Everything in §1–§7 gets the stack running. This section is about keeping it running: what the logs
look like, how to back up and restore, what the API refuses and why, what to scrape, and what to do
at 3am. One person should be able to run, monitor, back up, restore and restart the whole off-chain
stack from this section alone.

The shared plumbing lives in [`packages/oplog`](../packages/oplog/) — a logger, heartbeat files, an
`ops-check` script and a shutdown helper, all dependency-free. **viem remains the only runtime
dependency in the repo**, and none of these four modules import it.

### 8.1 Log format

Every service emits **one JSON object per line** with the same four fields plus event-specific ones:

```json
{"ts":"2026-08-20T14:03:22.481Z","level":"info","service":"indexer","event":"batch.indexed","from":8204001,"to":8204113,"events":3}
```

| Field | Meaning |
|---|---|
| `ts` | ISO-8601 UTC, millisecond precision |
| `level` | `debug` \| `info` \| `warn` \| `error` |
| `service` | `indexer` \| `api` \| `canary` |
| `event` | dotted event name — the thing to grep for |

`warn` and `error` go to **stderr**, everything else to **stdout**, so `2>` gives a pure problem
feed. When stdout is a **TTY** the same records render as human lines instead:

```
14:03:22.481 INFO  indexer batch.indexed  from=8204001 to=8204113 events=3
```

That means `npm run start:indexer` in a shell is readable and the identical command under Docker
(no TTY) emits JSON, with no flag to remember. Force either with `LOG_FORMAT=json|pretty`; raise or
lower the floor with `LOG_LEVEL`.

Events worth knowing:

| Event | Service | Means |
|---|---|---|
| `starting` / `listening` | all | boot, with the resolved config on the line |
| `batch.indexed` (via `indexer.progress`) | indexer | a block range was folded and snapshotted |
| `poll.failed` / `sweep.failed` | indexer, canary | one cycle failed; it will retry |
| `sweep.no_vaults` | canary | the canary is UP and watching **nothing** — the dead-man ping is withheld until this clears |
| `snapshot.reload_failed` | api | serving **stale-but-valid** state — see the incident table |
| `http.rate_limited` | api | a free route returned 429 |
| `canary.transition` | canary | a signal changed state — **the** line to page on |
| `heartbeat.failed` | all | could not write the heartbeat file (disk?) |
| `shutdown.begin` / `.step` / `.complete` | all | a clean stop, hook by hook |
| `shutdown.timeout` / `.forced` | all | a stop that did **not** finish cleanly |

Transitions are also delivered as structured JSON to `PAGE_WEBHOOK_URL` / `LOG_WEBHOOK_URL` by
severity tier (`ALERT_WEBHOOK_URL` is the single-endpoint fallback), and each body carries its own
`tier` field — the log is not the only path (see [CANARY.md](CANARY.md) §5.3).

### 8.2 Heartbeats and `ops-check`

`restart: unless-stopped` catches a process that **crashes**. It does nothing about one that is
**wedged** — up, holding its port, indexing nothing. So each service writes
`<HEARTBEAT_DIR>/<service>.heartbeat.json` on every successful work cycle, and `ops-check` fails
when one goes stale.

"Successful" is load-bearing. The heartbeat means *I am doing my job*, not *my process exists*:

| Service | Beats when | So it goes stale if |
|---|---|---|
| `indexer` | boot, then after each poll cycle | it stops polling or wedges on an RPC call |
| `api` | after each **successful** snapshot reload | it loses or cannot parse the snapshot |
| `canary` | after each **successful** sweep | it cannot reach the chain — i.e. is not watching |

Each file carries its own `staleAfterMs`, written by the service that knows its cadence (three
missed cycles, floored). Nothing has to be kept in sync by hand.

```bash
node packages/oplog/src/ops-check.mjs --dir=./data
```

Exit **0** with one line per service when all are fresh; exit **1** listing the bad ones otherwise
(**2** on a usage error, so a broken invocation is never mistaken for a healthy stack):

```
ops-check: 1 of 3 service(s) UNHEALTHY: canary(stale)
FAIL canary   stale      age=612s  last beat 612s ago, limit 90s — canary is down or wedged
ok   indexer  fresh      age=4s    pid=12 lastBlock=8204113 vaults=7
ok   api      fresh      age=2s    pid=14 lastBlock=8204113 vaults=7
```

`missing`, `unreadable` and `future` (clock skew) are failures too, each named separately because
each has a different fix.

**Cron it** — this is the whole-stack view:

```bash
*/5 * * * * cd /srv/vaults && node packages/oplog/src/ops-check.mjs --dir=./data || mail -s 'vault stack unhealthy' you@example.com
```

**Compose already runs it**, but per-service: each container healthchecks only *its own*
heartbeat. A whole-stack check inside the indexer container would mark the indexer unhealthy
because the *canary* died, and Docker would restart the wrong process.

```bash
docker compose ps          # STATUS column shows healthy / unhealthy per service
```

Override every service's own budget with `--max-age-ms=N`, or pick services positionally
(`ops-check.mjs indexer api`).

### 8.3 Backups and restore

Both state files — the indexer snapshot and the canary's transition state — are written
temp-then-rename (atomic: a crash never truncates) **and** kept in a rotating backup ring
(`SNAPSHOT_BACKUPS=3`, `SNAPSHOT_BACKUP_INTERVAL_MS=300000`):

```
data/indexer-state.json      ← live
data/indexer-state.json.1    ← newest backup (~5 min old)
data/indexer-state.json.2
data/indexer-state.json.3    ← oldest, ~15 min
```

Atomicity survives a crash. The ring survives the other way state dies: **a write that succeeded
and was wrong.** Backups are spaced by *time*, not per write — the indexer snapshots every batch,
so a per-write ring would give a 36-second horizon, useless when corruption is noticed minutes
later. The live file is *copied* into slot 1, never renamed, so it never blinks out of existence
under the API's reload timer.

Tune the horizon: `SNAPSHOT_BACKUPS × SNAPSHOT_BACKUP_INTERVAL_MS` is how far back you can go.
Defaults give 15 minutes. `SNAPSHOT_BACKUPS=0` disables the ring; writes stay atomic.

**Inspect before you act.** `verify` loads a state file and reports it without starting a poller
and without an RPC — it needs no environment at all, which matters because whoever is verifying a
snapshot after a crash has none of the six indexer variables set.

**Bare metal** (Linux/macOS, or Windows via WSL2) — the state files are where `STATE_PATH` /
`CANARY_STATE_PATH` put them:

```bash
node packages/indexer/src/index-runner.mjs verify ./data/indexer-state.json
node packages/canary/src/canary-runner.mjs  verify ./data/canary-state.json
```

**Docker (Compose)** — there is **no `./data` on the host**; the state lives in the named volume
(see the ⚠ box under *Restore procedure* below for why that distinction is dangerous). Run `verify`
inside a throwaway container that Compose attaches to the right volume for you:

```bash
docker compose run --rm --no-deps indexer node packages/indexer/src/index-runner.mjs verify /data/indexer-state.json
docker compose run --rm --no-deps indexer node packages/canary/src/canary-runner.mjs  verify /data/canary-state.json
```

`run --rm` because the container is disposable, and `--no-deps` so Compose starts nothing else
alongside it — the whole point is to inspect a stack you have deliberately stopped. Both commands
work whether the services are up or down, and both mount the same volume the services do, because
Compose resolves it from `docker-compose.yml` rather than from a name you typed.

Either form prints the same report:

```
snapshot ./data/indexer-state.json: OK
  cursor      lastBlock=8204113 lastLogIndex=-1 → resumes from block 8204114
  counts      vaults=7 operators=12 proposals=3 shareBooks=7 holders=64 activeProposals=1
  file        184213 bytes, written 2026-08-20T14:03:22.481Z (11s ago)
  backups     3 (newest first)
    .1  lastBlock=8202901 vaults=7 183902 bytes  2026-08-20T13:58:20.114Z
    .2  lastBlock=8201640 vaults=7 183511 bytes  2026-08-20T13:53:19.882Z
    .3  lastBlock=8200388 vaults=6 182004 bytes  2026-08-20T13:48:19.630Z
```

Exit 0 if usable, 1 if not. Each backup is parsed and reported with **its own** cursor and counts,
so "restore from which one?" is answerable at a glance, and a corrupt rung is flagged individually
rather than poisoning the rest.

**Restore procedure** (indexer snapshot; the canary's is identical with its own paths).

> ⚠ **Every step below is given in BOTH forms — Docker and bare metal — and you must not mix
> them.** Under Compose the state files live in the `vault-state` **named volume**: there is no
> `./data` directory on the host at all. Running the bare-metal `verify` of step 2 against a
> perfectly healthy Compose stack prints
> `UNUSABLE — no snapshot at ./data/indexer-state.json — a fresh indexer would start from
> START_BLOCK`, `backups none on disk`, and **exits 1** — while the live file and a full 3-rung
> ring are sitting safely in the volume. That reads as total loss and points at the multi-hour
> rebuild-from-`START_BLOCK` path at the bottom of this section, for nothing. Measured, on a
> healthy stack, in `docs/RESTORE-DRILL.md` §10 finding 6. **Pick your column at step 1 and stay
> in it.**

1. **Stop the writer.** Nothing else may be writing while you swap files.
   ```bash
   docker compose stop indexer
   ```
   Look for `shutdown.begin` → `shutdown.step … ok:true` → `shutdown.complete` in
   `docker compose logs indexer`; the stop also takes a final snapshot, which is why step 2 says to
   read the cursors rather than assume `.1`. **No `shutdown.complete` means the hooks did not run
   and there was no final snapshot** — §8.6 has the two reasons that happens.
   **Bare-metal equivalent (Linux/macOS):** `kill -TERM $(cat /path/to/indexer.pid)`, or Ctrl-C in
   the foreground terminal — either delivers a real `SIGTERM`/`SIGINT` that the process's shutdown
   hooks (§8.6) observe. **Bare-metal Windows cannot do this.** Confirmed empirically
   (`docs/RESTORE-DRILL.md` §5 finding 2, re-confirmed 2026-09-01): neither Git Bash `kill`, nor
   Node's own `child_process.kill('SIGTERM'|'SIGINT')`, nor `taskkill /PID` without `/F` deliver a
   signal a Node process's `process.on('SIGTERM'|'SIGINT')` handler observes — Windows silently
   hard-terminates every time (`taskkill` without `/F` even refuses outright: *"This process can
   only be terminated forcefully"*). The one native exception, a genuine interactive Ctrl-C
   keystroke in the process's own console window, is real but not scriptable/reproducible as a
   drill. **On Windows, run the stack inside WSL2** (with or without Docker — WSL2 alone gives a
   real Linux kernel, so `kill -TERM` works there exactly as on Linux/macOS above) to exercise this
   step at all.
2. **Verify the candidates** and pick a rung by its printed cursor, not by its number. `.1` is
   usually the one you want, but a clean shutdown takes a final snapshot, which **can** push the
   ring along by one — so read the `lastBlock` and `vaults=` on each rung rather than assuming.
   *Can*, not *does*: the snapshot always happens, but **rotation is spaced by
   `SNAPSHOT_BACKUP_INTERVAL_MS`** and is a separate step from the write, so a stop that lands
   inside that window leaves the ring exactly where it was. Both were observed on 2026-09-02 —
   the shutdown snapshot advanced the live file's `lastBlock` well past `.1`, and `.1` did not
   move. Which is precisely why you read the cursors.
   ```bash
   # Docker (Compose)
   docker compose run --rm --no-deps indexer node packages/indexer/src/index-runner.mjs verify /data/indexer-state.json
   ```
   ```bash
   # Bare metal (Linux/macOS, or Windows via WSL2)
   node packages/indexer/src/index-runner.mjs verify ./data/indexer-state.json
   ```
3. **Keep the bad file.** It is the only evidence of what went wrong, and it is what the ring is
   about to overwrite.
   ```bash
   # Docker (Compose) — single quotes, so $(date) runs INSIDE the container, not in your shell
   docker compose run --rm --no-deps indexer sh -c 'mv /data/indexer-state.json /data/indexer-state.json.bad-$(date +%s)'
   ```
   ```bash
   # Bare metal
   mv ./data/indexer-state.json ./data/indexer-state.json.bad-$(date +%s)
   ```
   The `.bad-<epoch>` suffix is deliberate: `listBackups` only walks `.1`…`.N`, so the evidence file
   never consumes a ring slot.
4. **Put the backup in place** — copy, do not move, so the ring stays intact if step 5 fails.
   ```bash
   # Docker (Compose)
   docker compose run --rm --no-deps indexer cp /data/indexer-state.json.1 /data/indexer-state.json
   ```
   ```bash
   # Bare metal
   cp ./data/indexer-state.json.1 ./data/indexer-state.json
   ```
5. **Verify the restored file** and note the cursor it will resume from.
   ```bash
   # Docker (Compose)
   docker compose run --rm --no-deps indexer node packages/indexer/src/index-runner.mjs verify /data/indexer-state.json
   ```
   ```bash
   # Bare metal
   node packages/indexer/src/index-runner.mjs verify ./data/indexer-state.json
   ```
6. **Start the writer.** It resumes from `lastBlock + 1` and re-indexes the gap; the projection is
   a pure fold over events, so replaying the range that the backup was missing rebuilds exactly the
   state that was lost. Catch-up is bounded by `BATCH_BLOCKS` per poll.
   ```bash
   docker compose start indexer
   docker compose logs -f indexer      # watch batch.indexed reach the head
   ```
   **Bare-metal equivalent (Linux/macOS, or Windows via WSL2):**
   ```bash
   node --env-file=.env packages/indexer/src/index-runner.mjs
   ```
   Watch for `"resumed at block <N> (<M> vaults)"` with `M` matching the restored file's `counts`,
   then `indexed [<lastBlock+1>..…]` closing the gap. No bare-metal-Windows path exists for this
   step either, for the same reason as step 1 — see above.

> **If every backup is bad**, delete the snapshot and set `START_BLOCK` to the **factory deploy
> block**. The indexer rebuilds from chain history — slow, never wrong. Do **not** set a later
> block to save time: vaults created before `START_BLOCK` are never discovered and their events go
> unindexed forever. The indexer warns loudly when you do this on a fresh snapshot.

> **Restoring the canary's state is optional.** Deleting it costs one duplicate page per signal
> that is currently firing, and nothing else. If the alternative is a stale cursor causing an event
> scan gap, delete it.

**The canary's procedure is the same six steps with its own service and paths** — substitute
`canary` for `indexer`, `/data/canary-state.json` (bare metal: `./data/canary-state.json`) for the
snapshot path, and `packages/canary/src/canary-runner.mjs` for the runner. Its `verify` is under
"Inspect before you act" above.

#### The volume name is `<project>_vault-state`, not `vault-state`

Compose namespaces every volume with the project name — and the project name is the directory name
**after normalisation**: lower-cased, with everything outside `[a-z0-9_-]` stripped. A checkout in
`x402/` gives `x402_vault-state`, but one in `Gate7.Fixer_DIR/` gives `gate7fixer_dir_vault-state`.
Do not reconstruct that name by hand. **`docker run -v <name>:/data` does not check: given a name
that does not exist it silently CREATES an empty volume and mounts that.** A command naming the
bare `vault-state` therefore reads a brand-new empty directory and reports whatever "empty" looks
like — for the off-host backup below, an **87-byte archive containing one entry, `./`, exit 0**
(`docs/RESTORE-DRILL.md` §10 finding 8).

Ask Docker which volume **Compose** created, by the labels Compose stamps on the ones it makes:

```bash
docker volume ls --filter label=com.docker.compose.volume=vault-state \
                 --format '{{.Label "com.docker.compose.project"}}  {{.Name}}'
```

> ⚠ **Not `--filter name=vault-state`.** `name=` is a **substring** match, so as soon as you have
> run the restore at the end of this section it also returns `vault-state-restored` — and every
> gate below passes just as happily on the wrong one: `docker volume inspect` succeeds, the `:ro`
> mount is satisfied, and the `tar tzf | wc -l` belt reports twelve entries. You get a plausible
> archive of stale state, which is exactly the silent success this subsection exists to close.
> The label filter cannot make that mistake: the restore target is created with
> `docker volume create`, outside Compose, so it carries no Compose labels at all.

Everything under *Restore procedure* above uses `docker compose run`, which resolves the namespaced
name from `docker-compose.yml` for you and cannot get this wrong. **A raw `docker run` cannot**, so
where one is unavoidable, resolve the name from those labels into a variable and **gate on it** —
on there being exactly one candidate, and on that candidate existing:

```bash
VOL=$(docker volume ls -q --filter label=com.docker.compose.volume=vault-state)
[ "$(printf '%s\n' "$VOL" | grep -c .)" -eq 1 ] || { printf 'not exactly one candidate:\n%s\n' "$VOL" >&2; exit 1; }
docker volume inspect "$VOL" >/dev/null || { echo "no such volume: $VOL" >&2; exit 1; }
```

`docker volume inspect` **fails with exit 1 and creates nothing** — that is the whole reason it
comes first. Never let the `docker run` be the thing that discovers the name is wrong.

**A tripped count gate has not guessed; it is asking you to choose.** Zero candidates means no
Compose project on this host has ever brought this stack up. More than one means more than one copy
of it is running — or that someone restored into a *second Compose project*, which does carry the
labels. The display command above prints the project beside each name, so name the project you want
and the ambiguity is gone:

```bash
VOL=$(docker volume ls -q --filter label=com.docker.compose.volume=vault-state \
                          --filter label=com.docker.compose.project=<project>)
```

This reads back what Compose actually did instead of predicting it, so it holds however the project
got its name — `-p`, `COMPOSE_PROJECT_NAME`, a top-level `name:` in the compose file, or the
normalised directory name.

Read a state file with a throwaway container (the `docker compose run` form above is preferred; use
this when you are not standing in the repo):

```bash
docker run --rm -v "$VOL":/data:ro vault-runtime node packages/indexer/src/index-runner.mjs verify /data/indexer-state.json
```

**Back the volume up off-host as well** — the ring protects against a bad write, not a dead disk.
`docker compose run` is deliberately *not* used here: it would create the volume too, and a backup
must never invent its own source.

```bash
VOL=$(docker volume ls -q --filter label=com.docker.compose.volume=vault-state)
[ "$(printf '%s\n' "$VOL" | grep -c .)" -eq 1 ] || { printf 'backup ABORTED — not exactly one candidate:\n%s\n' "$VOL" >&2; exit 1; }
docker volume inspect "$VOL" >/dev/null || { echo "backup ABORTED — no such volume: $VOL" >&2; exit 1; }
ARCHIVE="vault-state-$(date +%F).tar.gz"
docker run --rm -v "$VOL":/data:ro -v "$PWD":/backup alpine tar czf "/backup/$ARCHIVE" -C /data .
tar tzf "$ARCHIVE" | wc -l    # sanity: more than 1 entry, or the volume was empty
```

Mounted `:ro` because a backup has no business writing to its source. The final `tar tzf` is the
second belt: the `inspect` gate catches a *missing* volume, the entry count catches an *existing
but empty* one — the two ways this command can succeed at nothing. Note what neither belt catches,
and why the label filter above is doing the real work: against the **wrong but populated** volume
every belt here passes, and you carry home a healthy-looking archive of stale state.

**Restoring it** into a fresh volume (verified end-to-end, `docs/RESTORE-DRILL.md` §10 finding 8):

```bash
docker volume create vault-state-restored
docker run --rm -v vault-state-restored:/data -v "$PWD":/backup alpine tar xzf "/backup/$ARCHIVE" -C /data
docker run --rm -v vault-state-restored:/data vault-runtime node packages/indexer/src/index-runner.mjs verify /data/indexer-state.json
docker run --rm -v vault-state-restored:/data vault-runtime node packages/canary/src/canary-runner.mjs  verify /data/canary-state.json
```

Both must print `OK` and exit 0. `docker volume create` here is correct and intended — this is the
one place a new volume is the goal. Because it is created outside Compose it carries none of the
`com.docker.compose.*` labels, which is why the discovery above can never hand you this volume by
mistake even though its name contains `vault-state`. Leaving it on the host is therefore safe; if
you would rather not, remove it by exact name (`docker volume rm vault-state-restored`) and **never
with `docker volume prune`**, which deletes every unused volume on the host, not just yours.

### 8.4 Rate limits and request caps

The API applies a **per-IP token bucket to the free routes only** — `/health`,
`/.well-known/x402`, `/metrics`:

| Var | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_PER_SEC` | `5` | sustained requests per second per IP; **`0` disables the limiter** |
| `RATE_LIMIT_BURST` | `60` | burst an IP may take at once |
| `RATE_LIMIT_MAX_IPS` | `10000` | cap on tracked IPs |

Over the limit returns **429** with `retry-after` and `x-ratelimit-limit`.

**The paid routes are deliberately unlimited: x402 *is* their rate limiter.** Every metered read
costs the caller real USDC through a facilitator settlement, so flooding `/vaults` is a purchase,
not a denial-of-service. An *unpaid* request to a metered route returns 402 without a facilitator
call, a state read or a disk touch, so it is not a lever worth pulling either.

Memory is bounded because an unbounded per-IP map would itself be the denial-of-service. Buckets
that have fully refilled are pruned first — they carry no information — and only under sustained
pressure does it fall back to evicting the least-recently-used, which does hand that IP a fresh
burst. That trade is deliberate: remembering an attacker perfectly is not worth letting them choose
the heap size.

**Behind a reverse proxy, set `TRUST_PROXY=1`.** Without it every request appears to come from the
proxy and all clients share one bucket. **Do not set it when the API is reachable directly**:
`x-forwarded-for` is client-spoofable, so trusting it without a proxy that overwrites the header
lets one attacker mint a fresh bucket per request and defeat the limiter entirely.

Request caps, applied before any handler work:

| Var | Default | Over the limit |
|---|---|---|
| `MAX_URL_BYTES` | `2048` | `414 URI Too Long` |
| `MAX_BODY_BYTES` | `8192` | `413 Payload Too Large` (declared *and* chunked) |
| `MAX_HEADER_BYTES` | `16384` | connection refused by Node |

This is a GET-only read API, so a request body is already a sign of something wrong. Non-`GET`
gets `405`.

### 8.5 Metrics

`GET /metrics` returns Prometheus text exposition format — free, rate-limited, and readable with
plain `curl`, which is the case that matters during an incident.

```bash
curl -s localhost:8402/metrics
```

| Metric | Type | Meaning |
|---|---|---|
| `vault_api_requests_total` | counter | requests received |
| `vault_api_payment_required_total` | counter | 402s issued |
| `vault_api_settlements_total` | counter | payments verified + settled |
| `vault_api_rate_limited_total` | counter | 429s issued |
| `vault_api_rejected_total` | counter | refused on method/size/URL limits |
| `vault_api_errors_total` | counter | unhandled errors turned into a 500 |
| `vault_api_snapshot_reload_failures_total` | counter | reloads that failed, leaving stale state serving |
| `vault_api_uptime_seconds` | gauge | seconds since this process started serving |
| `vault_indexer_last_block` | gauge | last block in the snapshot being served |
| **`vault_indexer_snapshot_age_seconds`** | gauge | **seconds since the indexer last wrote the snapshot — the lag signal** |
| `vault_api_rate_limit_buckets` | gauge | per-IP buckets currently tracked |
| `vault_api_seen_nonces` | gauge | payment nonces held for local replay defence |

Counters read `0` before their first event rather than being absent: a missing series and a zero
series look identical in a graph, and only one of them is good news.

> **`/metrics` is rate-limited like every other free route**, and a scraper usually shares an IP
> with the operator debugging next to it. During an incident that is exactly when you burn the
> bucket on `curl` and get a 429 from the endpoint you most need. Give the burst room
> (`RATE_LIMIT_BURST`), or set `RATE_LIMIT_PER_SEC=0` on a deployment whose only clients are yours.

**On indexer lag.** The API has **no RPC client by design** — it serves the snapshot and nothing
else — so it cannot know the chain head and must not claim a blocks-behind figure. It reports how
long ago the snapshot was written, which is the number that actually tells you the indexer stopped,
and the metric is named for exactly that. Alert on it:

```
vault_indexer_snapshot_age_seconds > 5 × POLL_INTERVAL_MS/1000     # for 2 minutes
```

For true blocks-behind, compare `vault_indexer_last_block` against your own RPC's head — the
indexer is the process that has an RPC connection, not the API.

### 8.6 Restarting safely

All three services handle `SIGTERM` (and `SIGINT`), running ordered hooks before exiting:

| Service | On SIGTERM |
|---|---|
| `indexer` | finishes the **current batch**, snapshots, exits. The batch loop checks for the signal *between* batches, so a cold-start backlog does not swallow the signal. |
| `api` | stops reloading, stops accepting, drains in-flight responses (`closeIdleConnections` bounds the wait), logs a final metrics line. |
| `canary` | finishes the in-flight sweep, then **flushes** its transition state so the restart does not re-page every standing alert. |

A hook that throws is logged and the remaining hooks still run — a failed snapshot must not block
the API drain. A **second** signal exits immediately, and a watchdog force-exits if the hooks never
finish, so the process cannot outlive its own shutdown.

Compose sets `stop_grace_period` per service (indexer 45s, api 30s, canary 60s) so Docker waits for
the hooks instead of `SIGKILL`ing through them.

**This only works because `node` is PID 1 in every container** (`docker-compose.yml` uses the
exec-form `command: ["node", …]`). Until 2026-09-02 those lines read `command: npm run start:*`,
which made **npm** PID 1 — and npm does not forward SIGTERM. Every stop killed npm in ~1s, node
never saw the signal, none of the hooks in the table above ran, and the grace periods were dead
configuration. It was invisible because nothing errored: the shutdown lines were simply absent.
`docs/RESTORE-DRILL.md` §10 finding 7 has the A/B. The invariant is about the **program, not the
syntax**: whatever a `command:` line looks like, PID 1 has to end up being `node`. Keep the array
form, because it states the argv literally with nothing to mis-quote — but do not keep it in the
belief that it is holding a shell back. Compose normalises a string `command:` to the same argv
list the array form gives: `docker compose config` prints an identical list for
`command: node x.mjs` and `command: ["node", "x.mjs"]`, and `/proc/1/cmdline` reads `node …` for
both (measured on Compose v5.4.0 against `node:24-slim`, 2026-09-02). Nothing inserts `/bin/sh`.
So if you ever change one of those lines, check the process and the behaviour rather than the
punctuation: `docker compose stop <svc>` must still print `shutdown.complete`, and PID 1 must
still be `node`.

```bash
docker compose restart indexer      # clean stop, clean resume from the snapshot
docker compose down                 # stops all three cleanly; the volume survives
docker compose exec indexer cat /proc/1/cmdline   # sanity: must be `node`, never `npm`
```

**Bare-metal equivalent (Linux/macOS, or Windows via WSL2):** `kill -TERM <pid>` (or Ctrl-C in the
foreground) delivers the same signal the hooks in the table above listen for. **This document's
runtime target is Linux/Docker.** Bare-metal Windows cannot exercise graceful shutdown at all — no
scripted or interactive-from-another-window method reaches a `node.exe` process's signal handlers
short of a real interactive Ctrl-C in that exact console (see the restore procedure above and
`docs/RESTORE-DRILL.md` §5 for how this was confirmed, twice, a Docker-only environment apart).

Look for `shutdown.complete` in the logs. `shutdown.timeout` or `shutdown.forced` means the stop
was **not** clean — verify the snapshot before restarting. **On bare-metal Windows this line will
never appear**, by the platform limitation above, not because the stop was dirty — do not read its
absence there as a signal of anything.

### 8.7 Incident quick-table

| Symptom | Most likely | Do this |
|---|---|---|
| `ops-check` says a service is **stale** | crashed or wedged | `docker compose ps` / `logs --tail=100 <svc>`. Restart it: `docker compose restart <svc>`. If it goes stale again quickly, the RPC is the usual culprit — check `poll.failed`/`sweep.failed` lines. |
| `ops-check` says **missing** | never started, or wrong `HEARTBEAT_DIR` | Confirm the service is up at all, then that `HEARTBEAT_DIR` (or `dirname(STATE_PATH)`) matches what you passed `--dir`. |
| `ops-check` says **future** | clock skew between checker and service | Fix NTP on the host. Do not raise the threshold — a wrong clock also corrupts every `ts` in the logs. |
| `vault_indexer_snapshot_age_seconds` climbing | indexer stopped or is stuck on the RPC | `ops-check` the indexer; check its logs for `poll.failed`. The API keeps serving the last good block, correctly and staleley — it is not the broken piece. |
| API logs `snapshot.reload_failed` | torn, corrupt, or version-mismatched snapshot | The API is serving **stale-but-valid** state — no torn read reaches a client. `verify` the snapshot (§8.3); if it is bad, restore and restart the indexer. The API picks the fix up on its next reload with no restart. |
| `verify` says snapshot **UNUSABLE** | bad write, or a schema change | Restore from `.1` per §8.3. Keep the bad file. |
| Every backup is unreadable | disk or filesystem fault | Delete the snapshot, set `START_BLOCK` to the **factory deploy block**, let it rebuild from chain history. Then check the disk — this should not happen. |
| API returning 429s to your own front end | one shared IP behind a proxy | Set `TRUST_PROXY=1` **iff** a reverse proxy overwrites `x-forwarded-for`; otherwise raise `RATE_LIMIT_BURST`. Never set `TRUST_PROXY` on a directly-reachable API (§8.4). |
| `/metrics` returning 429 mid-incident | your own `curl`s share the scraper's bucket | Wait one refill, or raise `RATE_LIMIT_BURST`. `ops-check` and `verify` read files, not HTTP, so they keep working when the API will not answer you (§8.5). |
| API returning 402 to a paying agent | asset/network/amount mismatch, or a dead facilitator | `curl -s <api>/.well-known/x402` and compare against what the agent signs. Then check `FACILITATOR_URL` is reachable — a failed settlement is reported as a 402. |
| Canary silent for a long time | healthy — silence *is* the healthy state | Confirm with `ops-check canary`, or set `HEARTBEAT_MS` for a periodic "still watching" line. |
| Canary logs `event scan gap` | it was down longer than one `MAX_LOG_SPAN_BLOCKS` window | Those blocks were **not** scanned for module/fee events. Raise `MAX_LOG_SPAN_BLOCKS` and sweep the named range by hand before it scrolls away. |
| Canary re-pages everything after a restart | its state file was lost or not flushed | Harmless but noisy. Check for `shutdown.timeout` on the last stop; `verify` the canary state (§8.3). |
| Logs are prose, not JSON | stdout is a TTY | Expected. Set `LOG_FORMAT=json` to force JSON anywhere. |
| `shutdown.timeout` in the logs | a hook wedged | Verify the state file before restarting — the clean-stop guarantee did not hold for that stop. |
