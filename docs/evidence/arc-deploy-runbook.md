# Arc deploy runbook

<!-- historical-record: no -->

Written 2026-09-18 by a session holding no key and no funded account on Arc. Everything below is
preparation; nothing in it has been run.

## Read this first: the deploy is blocked, and not on authorisation

Two facts, and the second is the one that stops work:

1. **`docs/SWARM.md` §10 puts this out of an agent's hands.** Anything needing a private key, a
   funded account or `--broadcast` escalates to the owner. That is why the commands below are for
   you to run.
2. **The configuration is incomplete, so there is nothing to run them against yet.** The Arc survey
   (`docs/evidence/arc-mainnet-survey.json`) resolved the chain binding, the settlement token and
   four Chainlink feeds. It did **not** resolve the Uniswap v3 router or the basket asset
   addresses. `ChainlinkOracle`'s constructor takes `(asset, feed)` pairs and `VaultCore` takes a
   basket of asset addresses; `Deploy.s.sol` needs a router. Those are missing.

So this runbook has a prerequisite section that is real work, not a formality.

## Why Arc testnet is not the dry run

Measured on chain 5042002 on 2026-09-18, not assumed:

| Dependency | Arc testnet |
| --- | --- |
| USDC predeploy `0x3600…0000` | present, 1,798 B, 6 decimals |
| Permit2, Multicall3 | present |
| Uniswap v3 factory / SwapRouter02 / UniversalRouter | **0 bytes** |
| Pyth receiver | **0 bytes** |
| CCTP TokenMessengerV2 | **0 bytes** |
| Chainlink feeds | **none** — the feed directory has no Arc testnet network at all |

`ChainlinkOracle` requires a genuine feed per asset and fails closed when it cannot produce a
trustworthy price. There is nothing on Arc testnet to point it at. A deploy there could only stand
up against mock feeds and a mock router, which demonstrates that the bytecode is chain-portable and
nothing whatever about oracle or execution behaviour. Base Sepolia remains the functional testbed;
its ten-phase lifecycle evidence is already committed.

## Prerequisites — the unresolved half

### 1. Resolve the Uniswap v3 SwapRouter02 on chain 5042

Uniswap's own announcement says v2, v3, v4 and UniswapX are live on Arc. The UniswapX playbook for
chain 5042 truncates the two addresses that matter (`0xf0db…3918` for the v3 factory, `0x53bf…6f77`
for SwapRouter02), and a truncated address is not an address.

**Do not take the canonical cross-chain addresses.** Both were read on 5042 and neither is Uniswap:
`0x1F98431c8aD98523631AE4a59f267346ea31F984` and `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` each
carry 2,747 bytes and return empty for `owner()`, `getPool()`, `factory()` and `WETH9()`. Neither is
a proxy. This is the same address-squatting hazard `robinhood-mainnet.json` had to verify around.

Once you have a candidate, confirm it before use:

```bash
cast code <router> --rpc-url https://rpc.mainnet.arc.io | wc -c
```

Then check it self-identifies — `factory()` must return a factory whose `getPool` resolves the pools
you intend to trade — and confirm both allow-listed selectors appear in its runtime: `0x04e45aaf`
(`exactInputSingle`) and `0xb858183f` (`exactInput`).

Note that **Uniswap v4 is not a substitute**. `AggregationRouterAdapter` and `UniswapV3Adapter` both
target a v3-shaped router, not a v4 PoolManager singleton, so the confirmed PoolManager at
`0x8366a39cc670b4001a1121b8f6a443a643e40951` cannot be pointed at directly.

### 2. Resolve the basket asset addresses

Chainlink publishes ETH/USD, BTC/USD and CBBTC/USD on Arc, which is good evidence those assets
trade there — but a feed is not a token address. **Arc has no wrapped-native token**: the native
asset is USDC, so the 4663 basket of WETH + cbBTC does not port by address or by name, and `0x0` as
a Uniswap v4 currency on Arc means native USDC, not native ETH.

Resolve each token by reading the chain, then record `symbol()`, `decimals()` and code size.

### 3. Choose the sane-price band and the heartbeat

`scripts/test/config-doc-truth.test.mjs` requires `minPriceWad`, `maxPriceWad` (strictly above,
within `MAX_BAND_RATIO`) and `feedDecimals` per asset.

On the heartbeat, read `heartbeatNote` in the survey before choosing. The short version: a single
sample showed the feeds 0.15 h old, which invites a tight bound, and eleven rounds of history show
gaps reaching 14,286 s on CBBTC/USD and 16,956 s on BTC/USD. Anything below roughly six hours is
breachable by a feed behaving exactly to spec, and eleven rounds is a small sample on a chain days
old. `ChainlinkOracle.MAX_HEARTBEAT` is 86,400 s.

### 4. Widen the sequencer-feed refusal

Chainlink publishes no L2 Sequencer Uptime Feed for Arc, and Arc is an L1 rather than a rollup.
`DeployChainlinkOracle.s.sol` refuses chains it has no sequencer policy for. That refusal has to be
widened deliberately for 5042 — the same exemption 4663 required, and an owner decision.

### 5. Promote the survey into a config

When 1–4 are done, `docs/evidence/arc-mainnet-survey.json` becomes
`contracts/config/arc-mainnet.json` with the full shape (including the `smoke` block). The moment
it is named `*-mainnet.json` under `contracts/config/`, the shared guards enumerate it and hold it
to the `ChainlinkOracle` constructor bounds. That is the intended gate, not an obstacle — it is
what refused the incomplete version.

## The deploy itself, once the above is done

Environment. Set these in your own shell; nothing in this repository stores a key.

```bash
export ARC_MAINNET_RPC=https://rpc.mainnet.arc.io
```

Gas on Arc is paid in USDC, and the native gas view is 18-decimal over the same balance as the
6-decimal ERC-20 at `0x3600…0000`. They are one pool of funds, not two assets. Fund the deployer
with real USDC for mainnet; `faucet.circle.com` covers testnet only.

1. **Verify the config against the live chain before anything is broadcast.** Read-only, needs no
   key, costs nothing, and refuses on a chain-id mismatch before reading a feed:

   ```bash
   node scripts/verify-chainlink-oracle.mjs
   ```

2. **Deploy the oracle**, then verify it, then pass it as `BLESSED_ORACLES` to the main deploy —
   the order `robinhood-mainnet.json` records.

3. **Read every address back off chain 5042** and write
   `contracts/config/deployments/arc-mainnet.json` from what the chain returned, never from the
   broadcast log. The broadcast JSON's `transactions[].hash` column has been label-scrambled on
   more than one run in this repository; its `receipts[]` array was correct each time. Establish
   contract identity from receipts, not labels.

4. **Do not create a vault with the deployer EOA.** On 4663 both live vaults were created by the
   deployer rather than the creator Safe, `createVault` makes that permanent, and the record's
   `intendedCreator` said it must not happen. The remedy there was a new vault, not a correction.

## What is NOT covered here

Migration of the two live vaults on chain 4663. **There is no contract path that moves member
funds** — that is the design working as specified, not an omission. `VaultCore` exposes no admin
withdrawal, no sweep and no migrate; the only way out is `requestExit`, which each member calls for
themselves. A migration to Arc is therefore a new deployment plus members individually exiting
4663 and depositing on Arc. Nobody can do it on their behalf, including you.
