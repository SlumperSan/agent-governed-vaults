# Arc deploy runbook

<!-- historical-record: no -->

Written 2026-09-18 by a session holding no key and no funded account on Arc. Everything below is
preparation; nothing in it has been run.

## Read this first: the deploy is blocked, and not on authorisation

Two facts, and the second is the one that stops work:

1. **`docs/SWARM.md` §10 puts this out of an agent's hands.** Anything needing a private key, a
   funded account or `--broadcast` escalates to the owner. That is why the commands below are for
   you to run.
2. **The basket has no agreed shape, and that is a decision rather than a lookup.** The Arc survey
   (`docs/evidence/arc-mainnet-survey.json`) resolved the chain binding, the settlement token, four
   Chainlink feeds, the Uniswap v3 router and the one basket-eligible asset Arc has. What it cannot
   resolve is what the basket should *be*: **Arc has a BTC leg and no ETH leg**, so the two-asset
   design does not port, and `docs/SWARM.md` §10 puts launch parameters with the owner.

So §§1-2 below are results to read, not work to do. §§3-5 are still real work, and all of them wait
on the basket decision.

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

## Prerequisites — what is settled, and what is not

Sections 1 and 2 were open questions when this runbook was written. Both were answered on
2026-09-18 by direct RPC on chain 5042, cross-checked on four endpoints. They are recorded here as
results rather than as steps, because re-deriving them costs a session and one of them already did.

### 1. Uniswap v3 SwapRouter02 — RESOLVED

| | |
|---|---|
| SwapRouter02 | `0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77` |
| v3Factory | `0xf0db7b58379503491d857db50ac9ece64c653918` |
| NonfungiblePositionManager | `0x39654a85a4c05127f5fd6ed22caec077a0fb1377` |

`router.factory()` resolves to the factory above, and both allow-listed selectors are present in the
router runtime: `0x04e45aaf` (`exactInputSingle`) and `0xb858183f` (`exactInput`).

**Do not take the canonical cross-chain addresses.** Both were read on 5042 and neither is Uniswap:
`0x1F98431c8aD98523631AE4a59f267346ea31F984` and `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` each
carry 2,747 bytes and return empty for `owner()`, `getPool()`, `factory()` and `WETH9()`. Neither is
a proxy. This is the same address-squatting hazard `robinhood-mainnet.json` had to verify around.

Still read `allowedSelector(bytes4)` back off the deployed adapter before a deploy — the addresses
being right does not mean the adapter was configured with them.

Note that **Uniswap v4 is not a substitute**. `AggregationRouterAdapter` and `UniswapV3Adapter` both
target a v3-shaped router, not a v4 PoolManager singleton, so the confirmed PoolManager at
`0x8366a39cc670b4001a1121b8f6a443a643e40951` cannot be pointed at directly.

### 2. Basket assets — ANSWERED, and the answer is not two assets

**Arc has a BTC leg and no ETH leg.** cirBTC is `0x171a4217b86a807a64eb94757db6849fb4bdbaa0`,
8 decimals, Circle FiatToken stack, $7.40M USDC against 73.38 BTC in a single pool, with AMM spot
within 0.20% of the Chainlink feed.

**There is no ETH representation on Arc in any form.** A complete `PoolCreated` scan of the real
factory — 26,286 pools, 26,187 tokens, zero window errors — read all 52 ETH-or-BTC-family symbols
and found 51 of them to be 18-decimal squatters worth under $452. Circle's whole Arc token set,
enumerated from `MinterConfigured` and `MasterMinterChanged` across all history, is USDC, EURC,
cirBTC, USYC, MXNB, TRYB and three unnamed contracts. There is no cirETH.

Arc publishes an ETH/USD feed that prices nothing on this chain. **A published feed is evidence
about Chainlink's coverage, not evidence that an asset trades here** — that inference is the one
this runbook's earlier draft made, and it was wrong.

So the 4663 basket of WETH + cbBTC does not port, and this is no longer a lookup:

> **The basket shape is an owner decision.** Single-asset cirBTC; cirBTC plus a thin second leg from
> Arc's remaining Circle tokens, none of which is a crypto index constituent; or not launching the
> index on Arc yet. `docs/SWARM.md` §10 puts launch parameters on the escalate list.

**One trap to carry into the config.** Chainlink publishes `cirBTC Reserves` at
`0xEB0884a871ea1f6483B5FC10fd3D7dC5806411fc` — a proof-of-reserve feed structurally identical to a
price feed (9,571 bytes, 8 decimals, version 6, fresh positive answer) reporting 786.98 where
CBBTC/USD reports 81,110.58. It is the only Arc feed whose description contains the basket asset's
ticker, so it sorts first when the feed list is searched. `ChainlinkOracle._requireUsdQuote` rejects
it, and that was mutation-tested eight ways: change **only** the description to `cirBTC / USD` and
the identical feed is accepted. The description check is what saves this; the band is not. Populate
`feedDescriptionOnChain` the way `base-mainnet.json` does.

### 3. Choose the sane-price band and the heartbeat

`scripts/test/config-doc-truth.test.mjs` requires `minPriceWad`, `maxPriceWad` (strictly above,
within `MAX_BAND_RATIO`) and `feedDecimals` per asset.

On the heartbeat, read `heartbeatNote` in the survey before choosing. The short version: a single
sample showed the feeds 0.15 h old, which invites a tight bound, and eleven rounds of history show
gaps reaching 14,286 s on CBBTC/USD and 16,956 s on BTC/USD. Anything below roughly six hours is
breachable by a feed behaving exactly to spec, and eleven rounds is a small sample. Arc's genesis is
2026-05-12, so four months of history exist to widen the window with. `ChainlinkOracle.MAX_HEARTBEAT` is 86,400 s.

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
