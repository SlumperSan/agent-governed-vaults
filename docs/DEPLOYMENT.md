# Deployment Runbook

Sprint 9. Covers testnet bring-up (Base Sepolia) and the mainnet bring-up this runbook was actually
used for — Robinhood Chain (chain 4663), 2026-09-05 — the mandatory wiring order, post-deploy
verification, and canary monitoring. Contracts are immutable — there is no upgrade path, so
**getting the constructor args and wiring right is the whole game** (a bad `maxStaleness` or an
unwired registry cannot be fixed after the fact).

> **Testnet fast path:** [TESTNET-CHECKLIST.md](TESTNET-CHECKLIST.md) packages §§1–4 into one
> deploy command (`script/DeployTestnet.s.sol`, config-driven, includes the oracle stack and
> execution adapter) plus one lifecycle smoke-test command (`scripts/smoke-test.mjs`).
>
> **After the contracts are live:** [RUNTIME.md](RUNTIME.md) is the operator runbook for the three
> off-chain processes (indexer → API → web) that turn the deployed addresses into a live product.

> ✅ **Unblocked (Sprint 7).** `VaultFactory` was 27,241 bytes of runtime code against the
> EIP-170 24,576-byte cap, so §1 reverted on-chain and nothing in this runbook could be executed
> ([issue #10](https://github.com/SlumperSan/agent-governed-vaults/issues/10)). Any contract that
> writes `new VaultCore(...)` embeds VaultCore's whole creation code in its own runtime, and the sum
> does not fit: 22,391 B of initcode (2026-09-02) leaves 2,185 B under the cap, against a factory
> whose own logic measures 3,572 B. So the creation code lives in `VaultDeployer`
> — deployed first, then pinned immutably by the factory. The factory measures **3,572 B**
> (2026-09-02; recorded here as 2,718 B until then — re-measure, do not copy) and
> `forge build --sizes` passes. **§1 gained a sixth singleton**; the wiring order is otherwise
> unchanged.

## 0. Preconditions

- Foundry v1.7.1 (`foundryup -v v1.7.1`).
- A funded deployer key on the target chain. **Never commit it.** Use an env var or a hardware
  wallet via `--ledger`. This repo's scripts read `--account`/`--private-key` from the CLI, never
  from a file.
- The canonical USDC address for the chain (Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).
- **Launch oracle (C-6): one genuine Chainlink Data Feed per basket asset**, plus the Base L2
  sequencer uptime feed **on the chains that have one**. These go in `base-mainnet.json`'s
  `chainlinkOracle` block — the Base reference configuration — and are deployed
  as a curated `ChainlinkOracle` in **§1** (the launch model — not the per-vault multi-source
  aggregator, which C-6 retired). Verify every address on-chain (`verify-chainlink-oracle.mjs`)
  before deploying — the oracle is immutable.
- *(Deferred / non-launch only)* the pre-C-6 multi-source stack (Chainlink feed proxies + Uniswap V3
  pools with their `observationCardinality` + Pyth contract & price ids) is drafted in
  [`base-mainnet.json`](../contracts/config/base-mainnet.json) and described in §3; **UNVERIFIED-ON-CHAIN**
  and not for a mainnet launch.

### A second mainnet configuration for chain 4663, and where its deployment is recorded instead (2026-09-04)

**Added 2026-09-04:** [`contracts/config/robinhood-mainnet.json`](../contracts/config/robinhood-mainnet.json),
for Robinhood Chain (chain id 4663). It is modelled key for key on `base-mainnet.json` so the two
diff field by field, and its `chainlinkOracle` block is the launch shape §1 describes: WETH and
cbBTC priced from that chain's own `ETH / USD` and `CBBTC / USD` Chainlink Data Feeds, with USDG as
the pinned settlement token under the historical `usdc` key. Every address, code size, decimal, feed
description, aggregator phase and answer in it was read from chain 4663 by read-only JSON-RPC on
2026-09-04. Those reads are several batches rather than one instant, spanning roughly three minutes
of chain time, and the file records the earliest and latest samples alongside the one its feed ages
are measured against.

**What this file is, and what it is not.** It is configuration evidence for chain 4663, and a
configuration is not an address book: it records what was read off that chain on the date above,
never what exists on it now. What exists on chain 4663 is recorded separately, in
[`contracts/config/deployments/robinhood-mainnet.json`](../contracts/config/deployments/robinhood-mainnet.json),
written from what the chain returned and described in the subsection below, "The chain-4663
deployment, and where it is recorded". **Do not read either file as evidence about the other.** The
one link between them that either file can settle is that the record's
`oracle.sequencerUptimeFeed` and `oracle.maxStalenessSeconds` agree with this file's
`chainlinkOracle` block, and `scripts/test/claims-robinhood-deployment.test.mjs` asserts exactly
that and nothing wider — in particular, nothing here establishes which configuration any broadcast
actually read, and the open questions at the end of this section are the reason that matters.

No contract from this repository exists on Base mainnet. Neither this file nor the deployment on
chain 4663 changes a row of [LAUNCH-READINESS.md](LAUNCH-READINESS.md) — §0 of that file records
which of its gates were not run on that chain, and gates 3 and 6 are still STALE and still hold Base
at NO-GO. What this configuration supplies for chain 4663 is three of §1 step 1's four inputs — real,
on-chain-verified feed addresses (never invented ones), per-asset heartbeats and sane-price
bounds. It deliberately does **not** supply the fourth, that step's L2 sequencer
uptime feed: `chainlinkOracle.sequencerUptimeFeed` is empty under an owner-approved exemption dated
2026-09-04, because Chainlink publishes no L2 Sequencer Uptime Feed for that chain. The file's
`sequencerUptimeFeedNote` states what `ChainlinkOracle` does with a zero feed, and
`scripts/test/config-doc-truth.test.mjs` pins both the emptiness and that behaviour so the note
cannot drift from the code.

Two further questions in it were the owner's, and the owner answered both on 2026-09-05: vault #1
takes the file's 100-unit `minDepositUsdc` (100 USDG, superseding the 0.01 figure an earlier vault-1
note recorded), and the creator Safe holds 100 USDG for the first deposit. Supplying a config is
not a substitute for the rest of this runbook.

### The chain-4663 deployment, and where it is recorded (2026-09-05)

The owner broadcast this runbook's §1 and §2 against Robinhood Chain mainnet on 2026-09-05: ten
transactions from `0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35`, every receipt status 1. The
`ChainlinkOracle` went in alone at block 54,989,143 (`0x79279FBa3b6F6736f07cbBFcB7Cf0559466D5bfB`);
the six singletons and the three wire calls landed together five seconds later at block 54,989,195 —
`OperatorRegistry` `0xE200d63DB7c665F8eead3C7BDF3f0c030d7a6568`, `SubVaultRegistry`
`0x692385262C05df7515560886f167c4eDD0814025`, `FeeEngine`
`0x221D09326DBf6CDb708E7aBEdC9B117d64Ac4232`, `Governance`
`0x790A308f1ac06FeD4C79884BAD25d0C721C5B125`, `VaultDeployer`
`0xc36198FD2c7C62738159ED1FF965679105FAF05a`, `VaultFactory`
`0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1`. Source commit `b1cde122`.

**The address book is
[`contracts/config/deployments/robinhood-mainnet.json`](../contracts/config/deployments/robinhood-mainnet.json),
and it — not this paragraph and not `robinhood-mainnet.json` — is the record.** Every value in it
was read back from the chain with `cast` at block 54,991,182. Read the record before citing any
number here; two things it carries are worth knowing before you open it:

- **Do not rebuild that table from the broadcast JSON.** On this run the `transactions[].hash`
  column of `contracts/broadcast/Deploy.s.sol/4663/run-latest.json` is scrambled — it pairs
  `SubVaultRegistry` with a hash whose receipt returns the OperatorRegistry's address — while the
  same file's `receipts[]` array is correct. This is the Sprint-9 failure `scripts/soak/deployment.mjs`
  documents, and it recurred. The record's identities rest on byte-for-byte bytecode comparison
  against the `b1cde122` artifacts, which no label can mislead.
- **`factory.allowSubVaults()` reads false**, so this deployment is root-vaults-only — the opposite
  of the Base Sepolia record's `true`, and deliberately so in both places.

**Vault #1 does not exist yet.** `factory.vaultCount()` reads 0. Creating it is the Safe
`0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c`'s to do and nobody else's, for the reason §4 gives:
`VaultCore.creator` is immutable and `createVault` takes the creator from `msg.sender`, so an EOA
that creates it cannot hand it back. Until then no deposit, rebalance, fee accrual or exit has been
exercised on chain 4663, no execution adapter is deployed there (§3 — adapters are per-vault, and
`Deploy.s.sol` deploys none), and `scripts/test/claims-robinhood-deployment.test.mjs` stays red.

**No x402 is part of this deployment** (owner, 2026-09-05): none of the ten transactions deploys or
configures an x402 surface, and nothing recorded depends on one.

**None of the seven contracts is source-verified on the explorer, and §9 cannot currently do it.**
`https://robinhoodchain.blockscout.com/api` sits behind a Cloudflare managed bot challenge: a plain
request returns HTTP 403 with a `Just a moment…` interstitial and `Enable JavaScript and cookies to
continue`, never JSON. `forge verify-contract --verifier blockscout --verifier-url
https://robinhoodchain.blockscout.com/api --chain 4663` therefore fails before it submits anything,
at the ABI lookup — `Failed to deserialize response: expected value at line 1 column 1`, then `Error:
Failed to obtain contract ABI for 0x79279FBa…`. This is the explorer refusing an automated client,
not a defect in the source or the constructor arguments, and the challenge must not be worked
around. Retry from a browser session, or when the operator supplies an API key or an allow-listed
endpoint. **Explorer verification is a convenience and is not what establishes these contracts'
identity** — `bytecodeCurrency` in the record does that, by byte-for-byte comparison against the
`b1cde122` artifacts, and it depends on no explorer.

This changes no row of [LAUNCH-READINESS.md](LAUNCH-READINESS.md), whose board is the Base mainnet
launch.

## 1. Deploy and verify the curated oracle FIRST (C-6)

**Read this before §2's oracle subsection — it supersedes it for launch.** Audit finding **C-6**
showed the bespoke multi-source median (`OracleAggregator`) is not Byzantine-safe: two adversarial
sources seize an asset's price once one honest source withholds, and a permissionless creator can
supply exactly that (or a `ChainlinkOracle` over a fake feed). The launch resolution is a **curated
Chainlink-direct oracle** — one genuine Chainlink Data Feed per asset — blessed by the factory
allowlist. So the oracle is deployed **before** the factory:

1. **Populate the oracle config** — fill the placeholders in
   [`base-mainnet.json`](../contracts/config/base-mainnet.json)'s `chainlinkOracle` block with
   **real, on-chain-verified** Base feed addresses (do NOT invent them), the Base L2 sequencer
   uptime feed, per-asset heartbeats and sane-price bounds.
2. **Deploy the ChainlinkOracle** via
   [`DeployChainlinkOracle.s.sol`](../contracts/script/DeployChainlinkOracle.s.sol) with the
   `ORACLE_*` env vars from that config. The band values are copied by hand and nothing
   machine-checks that the env matches the JSON (residual register row 14's `BAND-BINDING` gap) —
   compare them yourself before broadcasting. **The band width is an owner decision (SWARM §10),
   not a deployer default:** an aggregator-swap drift of ±2 decimals is caught only while
   `hi/100 < spot < 100·lo`, a window `10,000 / (hi ÷ lo)` wide, so the shipped ratio-1000 bands
   give the *least* coverage the constructor allows (10x: WETH $1,000..$10,000, cbBTC
   $10,000..$100,000) and a tighter band gives more. Row 14 carries the boundaries and the owner
   memo `Owner Decisions 2026-09-01` §1 the options; do not retune without that decision recorded.
3. **Verify it on-chain** (read-only, no key): `node scripts/verify-chainlink-oracle.mjs` — must
   exit 0 (every feed: code, `decimals ≤ 18`, `answer > 0`, fresh within heartbeat; sequencer feed
   present and answering; and the band bounds a 2-decimal drift **at the live price**, which the
   constructor does not check — it accepts a spot inside the band but outside the covered window).
4. **Export `BLESSED_ORACLES`** = the deployed oracle address (comma-separated for several). §2 below
   (deploy the factory) reads it into the factory's oracle allowlist.

> A Base-mainnet `Deploy.s.sol` run **reverts** if `BLESSED_ORACLES` is empty (`test_baseMainnetDeployRefusesEmptyOracleAllowlist`) — an empty allowlist would ship the C-6 gate disabled. Testnet/local may run empty (permissive). The named test pins Base mainnet specifically, so it says nothing about chain 4663; what the Robinhood Chain factory actually enforces is `factory.oracleAllowlistEnforced()` and `factory.isAllowedOracle(...)` in `contracts/config/deployments/robinhood-mainnet.json`, read back on-chain, and that is the only place to look for it.

### Robinhood Chain 4663 — the sequencer-uptime-feed exemption (owner-approved 2026-09-04)

**Recorded because it weakens a security gate, and the record is the only place that says so.** On
2026-09-04 the owner approved deploying on Robinhood Chain (chain id 4663, an Arbitrum Nitro Orbit
chain) and, on being told that exempting it from the sequencer-uptime-feed requirement weakens a
security gate, answered: *"Approve the sequencer exemption, I'll fund the deployer now"*. Chain 4663
is therefore on `requiresSequencerUptimeFeed`'s exempt allowlist
([`DeployChainlinkOracle.s.sol`](../contracts/script/DeployChainlinkOracle.s.sol), `ROBINHOOD_CHAIN_ID`)
and on `SEQUENCER_EXEMPT_REASONS` in
[`verify-chainlink-oracle.mjs`](../scripts/verify-chainlink-oracle.mjs), so a deploy there runs with
`ORACLE_SEQUENCER` unset and the pre-deploy check passes that row instead of failing it.

**One signal this switches off, and what already stops it mattering.** `SEQUENCER_REQUIRED` is
computed from the *config's* `chainId` (`verify-chainlink-oracle.mjs:137`) and never from the RPC,
while the RPC is resolved `BASE_MAINNET_RPC ?? BASE_RPC ?? DEFAULT_RPC` (`:110`) — so a
`BASE_MAINNET_RPC` left exported from a Base session still decides which endpoint a run launched
with the 4663 config queries. Before this change that misdirected run **failed** the sequencer row,
and something objected; on an exempt chain the row now **passes**, so on its own the exemption would
let a wrong-chain verification come back green. The root cause was the missing chain binding rather
than the exemption, and it was fixed separately and landed first: PR #205
(`fix(verify-chainlink-oracle): bind the run to the chain the config names`) is on `protocol/main`
as `89d0fbb6`, and this change is rebased on top of it. The script now reads `eth_chainId` from
whichever RPC it resolved and refuses the entire run — before any feed is read (`:442`) — when that
id differs from the config's `chainId`, so a misdirected run never reaches the sequencer row at all,
exempt chain or not. Clearing `BASE_MAINNET_RPC` by hand, which
[`robinhood-mainnet.json`](../contracts/config/robinhood-mainnet.json)'s
`chainlinkOracle.verification` list still instructs, remains the right habit: the binding governs
whether a verdict means anything, not which endpoint gets queried.

**Why an exemption rather than a feed address.** Chainlink publishes no L2 Sequencer Uptime Feed for
this chain and states it is no longer expanding that feed set to additional networks
([docs.chain.link/data-feeds/l2-sequencer-feeds](https://docs.chain.link/data-feeds/l2-sequencer-feeds),
read 2026-09-04). There is no address to supply, so the fail-closed default refuses the deploy
outright rather than costing the operator one argument — which is the case the allowlist exists for.

**The residual risk, in plain words.** With `sequencerUptimeFeed` at `address(0)`,
`ChainlinkOracle._requireSequencerUp` returns on its first line
([`ChainlinkOracle.sol:314`](../contracts/src/oracle/ChainlinkOracle.sol)) and never reverts, so
`priceWad` answers normally. A sequencer outage on 4663 would therefore **not** freeze pricing, and
the 3,600-second `GRACE_PERIOD` after a restart (`ChainlinkOracle.sol:79`) never applies there
either. 4663 is a Stage 0 chain with a centralised sequencer
([l2beat.com/scaling/projects/robinhood](https://l2beat.com/scaling/projects/robinhood), retrieved
2026-09-04), so that is the outage shape most likely to occur. What members are left with is the
per-asset heartbeat/staleness bound and the sane-price band — the same two guards that carry every
other bad-price case, now carrying this one alone. The heartbeat is only as tight as the value the
deployer passes: the constructor accepts `[600, 86400]` seconds (`MIN_HEARTBEAT` / `MAX_HEARTBEAT`,
`ChainlinkOracle.sol:97-98`), and a heartbeat set at the 86,400-second maximum admits a full day of
staleness before it fires.

**And that maximum is the value the committed config carries, on measurement rather than on
preference.** [`robinhood-mainnet.json`](../contracts/config/robinhood-mainnet.json) sets
`chainlinkOracle.assets[].heartbeatSeconds` to `86400` on both WETH and cbBTC, which its
`heartbeatNote` records is `ChainlinkOracle.MAX_HEARTBEAT` exactly. The evidence is
`usdcReferenceFeeds.usdgFeedCadenceNote`: the eleven inter-round gaps across this chain's USDG/USD
aggregator rounds 81-92 measured **86,403-86,427 s** (median 86,424), and a stablecoin resting at
1.0000 never trips a deviation threshold, so its publish cadence is this chain's bare Chainlink
heartbeat and nothing else. Read the claim as narrowly as the config states it: the two basket feeds
do **not** publish on that cadence, and `feedCadenceSecondsNote` says so — eleven ETH/USD gaps with
a median of 557 s and eleven CBBTC/USD gaps with a median of 690 s, bursty and deviation-driven — it
is the feeds' behaviour *at rest* that the heartbeat governs, corroborated by the latest round of
each sitting 41,131 s and 37,306 s old at the 2026-09-04 read with no incident. The consequence for
this section is the one the `heartbeatNote` draws: any bound below the published heartbeat can be
breached by a feed behaving exactly to spec, so on 4663 the only remaining staleness guard sits at
its loosest legal setting, and a NAV priced off a feed that may legitimately be a day stale is a
materially different instrument from the Base one. That is an owner decision, and it is recorded
rather than tuned here.

**Two things this exemption does not do.** It does not change any other chain: `DeployChainlinkOracle`
still refuses every id outside the three-entry allowlist unless the feed address is supplied, pinned
by `test_requiresSequencerUptimeFeedIsAnAllowlist` and by the adjacent-id case for 4664. And it did
not, by itself, make a 4663 deploy actionable: the deploy happened on 2026-09-05 and is recorded in
§0 above, under "The chain-4663 deployment, and where it is recorded".

A config for that chain does now exist — #209 landed
[`contracts/config/robinhood-mainnet.json`](../contracts/config/robinhood-mainnet.json), described
in §0 above — and it is worth reading what its own status fields claim, because they claim less than
the filename suggests. Its **top-level `status`** opens *"THE DEPLOYMENT'S CONFIGURATION, NOT ITS
ADDRESS BOOK"*; its **`chainlinkOracle.status`** reads *"VERIFIED-ON-CHAIN 2026-09-04 … VERIFIED
means the addresses, decimals, descriptions, phases and answers below were read from that chain. IT
DOES NOT MEAN DEPLOYED, AND THIS BLOCK IS NOT AN ADDRESS"* — the live `ChainlinkOracle` is
`0x79279FBa…`, in the deployment record. Both fields were rewritten on 2026-09-05: they previously
said nothing was deployed on chain 4663 and that no `ChainlinkOracle` instance existed there, which
was true on the day the config was written and was falsified by the broadcast the next day. What
the config supplies is three of §1 step 1's four inputs — real, on-chain-verified
feed addresses, per-asset heartbeats and sane-price bounds, the same three §0 above enumerates — and
deliberately not that step's fourth, the L2 sequencer uptime feed:
`chainlinkOracle.assets` carries WETH (`0x0bd7…ad73`) priced from that chain's own `ETH / USD` feed
`0x78F3…d3A9`, and cbBTC (`0xcec1…0be4`) priced from its `CBBTC / USD` feed `0x0009…a21a`, with every
address, `decimals()`, `description()`, `phaseId()`, `aggregator()` and `latestRoundData()` read from
chain 4663 by read-only JSON-RPC on 2026-09-04 (`chainlinkOracle.verifiedOnChain`). `sequencerUptimeFeed`
is empty there under this same exemption, and `chainlinkOracle.verification` says the verifier passes
that row only once 4663 is on its exempt allowlist — which is what this change adds.

Four things were blocking when this section was written, and none of them was in that change's
gift. Two have since closed and two remain:

- **The deployment record now exists.** `contracts/config/deployments/` holds `base-sepolia.json`
  and `robinhood-mainnet.json`; the seven contracts on chain 4663 are the ones that record describes
  (§0 above, "The chain-4663 deployment, and where it is recorded"), and no contract from this
  repository exists on any other mainnet.
- **The funding and one immutable launch parameter are decided but not yet executed,** both
  recorded in §0 above: the creator Safe (`creator` `0xC73B…AD4c`) holds 100 USDG for the first
  deposit, and vault #1 takes the config's 100-unit `minDepositUsdc` (the owner's decision of
  2026-09-05). The field is immutable once `createVault` has run, and vault #1 has not been created.
- **The owner broadcast it on 2026-09-05.** §1 step 2 and §2 both need a funded key and
  `--broadcast`, which `docs/SWARM.md` §10 places outside an agent's authority entirely; the owner
  ran both scripts, and the record was written from on-chain readback afterwards.
- **The public claims have been flipped.** All eight pages of `apps/site` used to carry the status
  line *"Not deployed to mainnet."*; the 4663 deploy falsified it the moment it landed, and the
  replacement states the deployment and cites the record in the same sentence, so a reader can check
  it. That flip was its own reviewed change rather than a side effect of this one, and it did not
  touch [LAUNCH-READINESS.md](LAUNCH-READINESS.md)'s **VERDICT: NO-GO**, which is about Base mainnet
  and was not cleared by deploying somewhere else.

`verify-chainlink-oracle.mjs` does have a default RPC for 4663 as the tree stands: #205 put
`4663: https://rpc.mainnet.chain.robinhood.com` in `DEFAULT_RPC` (`:104-109`), so a run against this
config no longer exits 1 for want of an explicit `BASE_RPC`. What keeps that convenience honest is
the `eth_chainId` binding that arrived in the same PR — whichever endpoint is resolved has to answer
4663 before a single feed is read (`:442`) — so a default can pick an endpoint but never certify one.

## 2. Deploy the singletons + factory (with the oracle allowlist)

The six protocol singletons + their one-shot wiring deploy in one transaction via
[`contracts/script/Deploy.s.sol`](../contracts/script/Deploy.s.sol). Set `BLESSED_ORACLES` from §1:

```bash
cd contracts
BLESSED_ORACLES="$CHAINLINK_ORACLE_ADDR" \
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC" \
  --account deployer \
  --broadcast --verify
```

This deploys `OperatorRegistry`, `SubVaultRegistry`, `FeeEngine`, `Governance`, `VaultDeployer`,
`VaultFactory` and performs the **irreversible** wiring:
`registry.wire(factory, feeEngine)` → `subReg.wire(factory)` → `gov.wireSubVaultRegistry(subReg)`.
`test/Deploy.t.sol` asserts each wire locks; re-running any wire reverts `AlreadyWired`.

Ordering note (#10): `VaultDeployer` **must** be deployed before `VaultFactory`, which pins it
immutably in its constructor. It takes no constructor arguments and needs no wiring — it holds
no authority (see [audit/walkthroughs/VaultDeployer.md](audit/walkthroughs/VaultDeployer.md)).

Record the six addresses printed by the script.

## 3. Execution adapters (per-vault) — and the DEFERRED custom oracle

Execution adapters are per-vault choices. The custom multi-source oracle below is **SUPERSEDED for
launch by §1** (the curated Chainlink-direct oracle) — audit finding **C-6**. Keep the custom
`OracleAggregator` path only for a post-audit release that re-enables permissionless oracle choice
with the `quorum ≥ 2a+1` Byzantine floor; do NOT use it for a mainnet launch (and the factory
allowlist makes it non-selectable there anyway).

> **⚠ These contracts are no longer in `contracts/src/`.** `OracleAggregator.sol`,
> `PythSource.sol`, `UniswapV3TwapSource.sol` and their vendored `FullMath`/`TickMath` were moved
> to **`contracts/test/retired/`**, where they are kept only as the C-4/C-6 exploit evidence. They
> are not part of the deployable set, and the constructor calls below will not resolve against a
> current checkout without moving them back. Read this subsection as the record of a retired
> design, not as a runbook you can execute.

**DEFERRED — the custom multi-source oracle (pre-C-6), do not use for launch:**

1. **The oracle stack — three mechanism classes.** ⚠ **Quorum 2-of-3 is UNSAFE (H-1/C-6):** it lets
   the lower median degenerate to `min()`, and two adversarial sources seize the price. If this path
   is ever revived, it needs ≥5 independent sources and `quorum ≥ 2a+1` — see AI-AUDIT-REPORT.md C-6.
   Deploy the source adapters first, then the aggregator over them.

   `OracleAggregator`'s constructor counts *addresses*; SF-1's listing criterion counts
   *mechanisms*. Three `ChainlinkSourceAdapter`s over three Chainlink feeds satisfy the former
   and defeat the latter — a single upstream wearing three hats. That is exactly the
   `testnetCompromise` recorded in
   [`base-sepolia.json`](../contracts/config/base-sepolia.json), acceptable only because Base
   Sepolia has one feed per pair and no real capital. **A BASE mainnet stack is:** (Base-shaped, and
   not the universal mainnet shape — the Robinhood Chain stack has no sequencer leg at all and runs
   its feeds at the 86,400 s `MAX_HEARTBEAT` ceiling)

   | Class | Adapter | Fails when | `updatedAt` |
   | --- | --- | --- | --- |
   | push | `ChainlinkSourceAdapter` | the aggregator pauses or hits a circuit limit | feed's `updatedAt` |
   | spot TWAP | `UniswapV3TwapSource` | the pool goes quiet or thin | `block.timestamp` (see below) |
   | pull | `PythSource` | no keeper pays to post an update | Pyth `publishTime` |

   with **quorum 2** — the strict-majority floor for a 3-source set, and the only value that
   both satisfies the constructor and leaves one source of failure headroom (quorum 3 lets any
   single dark source freeze the asset). Order per asset:

   ```solidity
   // a. push
   new ChainlinkSourceAdapter(IAggregatorV3(feedProxy));
   // b. spot TWAP — poolB is address(0) when poolA already quotes USDC
   new UniswapV3TwapSource(asset, usdc, poolA, poolB, 1800, 900, 3600);
   // c. pull
   new PythSource(IPyth(pythContract), priceId, 100 /* max 1% confidence band */);
   // d. the aggregator over all three, quorum 2
   new OracleAggregator(assets, sources, maxStaleness, quorum);
   ```

   Three things will bite, in decreasing order of how quietly:

   - **`maxStaleness` is no longer a pure volatility knob.** The old advice here — "pick it
     tight (minutes)" — is correct for a push-only stack and wrong the moment a pull oracle is
     in the set. Pyth's on-chain price only advances when a keeper *pays* to post, so a
     60-second bound drops that leg on most reads and silently demotes 2-of-3 into 2-of-2 with
     no headroom. Choose it against the **observed on-chain publish cadence** of the pinned
     price ids (base-mainnet.json pins 1 hour), or fund a keeper at a known cadence. It still
     bounds the EE-5 latency-arb window, so do not simply max it out — this is now a real
     tradeoff rather than "as tight as you can stand".
   - **Grow the V3 pools' `observationCardinality` before deploying.** A pool writes at most
     one observation per block, only on a swap; covering a 1800-second window on 2-second
     blocks needs ~900 slots. `increaseObservationCardinalityNext` is permissionless but paid
     per slot. `UniswapV3TwapSource`'s constructor **rejects a pool that cannot already serve
     its window** — that failure is the feature: without it the source would return a
     one-block-manipulable spot price wearing a TWAP's name, permanently fresh.
   - **`UniswapV3TwapSource` pins USDC to $1.00** rather than measuring it. A sustained depeg
     mis-prices that leg by exactly the depeg; the cross-class median is the only mitigation.
     Monitor USDC/USD off-chain (the reference feeds are listed in base-mainnet.json).

   The three classes are integration-tested together in
   `contracts/test/MixedOracleSources.t.sol`: mixed classes reach quorum and median correctly,
   any one class going dark leaves the breaker un-tripped, and every *pair* going dark trips it
   (K-4, deliberately — the freeze includes exits and there is no hatch).

2. **AggregationRouterAdapter**: `new AggregationRouterAdapter(router, allowedSelectors[])` pinned
   to the chain's 0x/1inch router with only the swap selectors allow-listed (EX-1..3).

   > ✅ **Resolved 2026-09-03 by redeploy.** The live Base Sepolia adapter is
   > `0x68be942cab962ac8f9064b45489f35fbd6f617d5`, deployed at `sourceCommit 8a0e1155`, and it
   > carries **both** fixes. Checked by ancestry rather than asserted — both of these succeed:
   > `git merge-base --is-ancestor 8a2afc3e 8a0e1155` (#101's mutex) and
   > `git merge-base --is-ancestor 29996eaf 8a0e1155` (#108's scoped refund). Neither the donation
   > DoS nor the cross-order theft is reachable on it. The soak has **not** been re-run yet (gate 3
   > is still STALE and needs the owner's key); when it is, it will run against this fixed shape
   > rather than the old one.
   >
   > **The constraint that forced the redeploy has not gone away.** `VaultCore.isAllowedAdapter`
   > is populated in the constructor and never written again, so vaults are permanently bound to
   > the adapter they were created against. That is why fixing this on Sepolia required a fresh
   > adapter *and* fresh vaults rather than a repoint, and it is why the finding was a deploy gate
   > in the first place. Mainnet must deploy the fixed bytecode; there is no repair after the fact.
   >
   > *What was here before, retained because the consequence list is the record:* the previous
   > adapter `0xf3e08c8b00281750d531a48473d053009038a9b1` (`sourceCommit 5934ef22`) contained no
   > `_lock` / `nonReentrant` at all, and so carried **two** exploits of one root cause — (1) the
   > **donation DoS**, a revert: anyone could `transfer` USDC to that address and the next
   > `executeRebalance` leg through it reverted `Panic(0x11)`; and (2) **#101's cross-order
   > theft**, a LOSS OF FUNDS: with no mutex, a counterparty reached through the route re-entered
   > with a 1-unit order and the nested whole-balance sweep handed it the outer order's in-flight
   > `tokenIn`, which `test/AdapterReentrancy.t.sol::test_nestedSwapCannotSweepTheOuterOrdersInput`
   > proves. Reachability was low (governance chooses `routeData`), but low reachability is a
   > different statement from the consequence list. The smoke vault of that era,
   > `0x4d60e49d451117b9ab8f9fb9be56454ab7f01a0f`, was bound to it and was superseded with it.
   > Both are described in [the walkthrough](audit/walkthroughs/AggregationRouterAdapter.md).

## 4. Create a vault

```solidity
factory.createVault(VaultFactory.VaultParams({
  usdc: USDC, basketAssets: [...], oracle: aggregator,
  capacityCapUsdc: ..., minDepositUsdc: ..., exitFeeMaxBps: <=100,
  exitFeeDecayPeriod: ..., allowedAdapters: [adapter]
}));
```

> **`minDepositUsdc` is a governance-security parameter, not just dust control (H-8).** The
> `<5`-member signer quorum regime counts any address with shares > 0, so a cheap minimum deposit
> lets an attacker buy the regime flip (`minDepositUsdc` to reach 5 members and pass a plurality
> alone) or park dust seats to grief a small vault into ungovernability. There is no safe
> contract-level floor (a fraction-of-stake floor repeats M-6's liveness cliff). **Set
> `minDepositUsdc` to an economically meaningful value relative to `capacityCapUsdc`** so that
> manufacturing ~4 dust members costs a materially non-trivial sum. 1 USDC (the testnet smoke value)
> is NOT acceptable for a real vault; the mainnet reference template uses 100 USDC. See
> AI-AUDIT-REPORT.md H-8 and THREAT-MODEL.md CM-7.

Then the creator registers governance config in a second tx:
`governance.registerVault(vault, GovConfig{...})` (quorum ≥ 25% floor; a child's quorum must be
≥ its parent's — SV-6). Until this second tx lands, no proposals exist and exits settle Mode I.

Child vaults use `createChildVault(params, parent)` — basket must be a subset of the parent's
(same USDC), depth ≤ 3, stacked exit-fee ≤ 2.5%.

> **Sub-vaults are DISABLED at launch (Critical C-1 remediation, "root vaults only").** The former
> manual warning here is now an enforced contract invariant: `Deploy.s.sol` constructs
> `VaultFactory` with `allowSubVaults = false` — a constructor immutable, so it binds that factory
> rather than the protocol. On it `createChildVault` reverts `SubVaultsDisabled` and every vault it
> deploys is wired `subVaultRegistry = address(0)` — intrinsically root-only. This closes C-1
> ([#33](https://github.com/SlumperSan/agent-governed-vaults/issues/33)) and the sub-vault-only
> Highs (H-5/H-6/H-7/H-9) as a class. **Why disabled rather than patched:** a child funded only by
> its parent has an empty electorate (the parent is excluded by GA-1), and there is no
> purely-internal fix — the correct mechanism (parent casts the child's vote) is a post-launch,
> post-audit feature. To enable sub-vaults you must deploy a factory with `allowSubVaults = true`,
> which is only appropriate once that mechanism has shipped and been audited. See
> [LAUNCH-READINESS.md](LAUNCH-READINESS.md) §2 and [INCIDENTS.md](INCIDENTS.md) §8. The protocol is
> **NO-GO for BASE mainnet on the OPERATIONAL gates** (soak + canary, which need a funded testnet key), and those two gates were not run before the Robinhood Chain mainnet deployment of 2026-09-05 either; the
> security gates are cleared and the external audit is complete on owner attestation. Enabling
> sub-vaults is additionally gated on the post-launch look-through mechanism shipping and being audited.
>
> **This is not a ban on testnet sub-vault drills** — the Base Sepolia drills already run
> ([SOAK-REPORT.md](SOAK-REPORT.md) drill 2) stand as evidence, and re-running them against the
> corrected contracts is step 3 of LAUNCH-READINESS §6's path to GO. Throwaway funds on a testnet
> are exactly where this should be exercised. The constraint is on mainnet and on any deployment
> holding members' money — and since 2026-09-05 there is a mainnet deployment to apply it to, though
> no vault has been created on it yet and so nothing there holds anyone's money. Confirm
> `VaultFactory.allowSubVaults()` on the Robinhood Chain factory before assuming it holds there;
> the value read back at deployment is in that chain's address book under
> `verifiedWiring["factory.allowSubVaults()"]`.

## 5. Post-deploy verification (before any real capital)

Run each check against the live addresses:

- [ ] `registry.factory()`, `registry.feeEngine()`, `subReg.factory()`, `gov.subVaultRegistry()`
      all resolve; re-wiring reverts.
- [ ] `factory.createVault` from a fresh EOA attests it: `registry.operatorOf(vault) != 0`.
- [ ] A test deposit → 4h window → `activate` mints shares; `navWad()` excludes the pending amount.
- [ ] `oracle.priceWad(asset)` returns a sane price for **every** basket asset, and reverts
      `StaleOracle(asset)` for an asset the oracle does not list (the breaker's own verdict).
- [ ] Re-run `node scripts/verify-chainlink-oracle.mjs` against the **deployed** oracle
      (read-only, no key): every feed carries code, `decimals() <= 18`, `answer > 0`, is fresh
      within its configured heartbeat, and its `description()` is an ASSET/**USD** pair — not
      ASSET/ETH. Base publishes a `CBETH / ETH` feed and no cbETH/USD one; wiring it would read an
      ETH-denominated number as USD, permanently.
- [ ] `oracle.feedOf(asset)` matches the config for each asset: right feed address, right
      heartbeat, and a sane-price band that brackets the current price with room for a real move
      but not for a deprecated min/maxAnswer clamp value.
- [ ] `oracle.sequencerUptimeFeed()` — **on a chain that has one.** On Base it must be the Base L2
      sequencer uptime feed and not `address(0)`; confirm `latestRoundData()` answers `0` (up) and
      that `block.timestamp - startedAt > 3600` (outside the grace period), or `priceWad` will
      revert for every asset. A deploy without it has no sequencer guard at all, and that is the
      accepted state on **Robinhood Chain (4663)**, where Chainlink publishes no uptime feed and
      has said it will not add one: `address(0)` there is the intended configuration, nothing
      compensates for the missing guard, and this checklist item is satisfied by confirming the
      zero rather than by finding a feed.
- [ ] `factory.isAllowedOracle(<oracle>)` is true and `factory.oracleAllowlistEnforced()` is true
      — the C-6 curation gate. An unenforced allowlist on mainnet ships the finding.
- [ ] **Know what has no check:** there is exactly one feed per asset, so there is nothing to
      cross-check the price against. The heartbeat, the band and the sequencer gate are the only
      defences, and a feed deprecation fails that asset closed with no fallback and no rotation
      lever. That is gate 5's named residual, accepted deliberately.
- [ ] A full governance dry-run on testnet: propose → commit → reveal → finalize → execute a
      no-op rebalance; confirm a Mode-F exit during reveal settles at post-execution NAV.
- [ ] Exit path: instant Mode-I exit pays pro-rata; exit fee accrues to remainers, never the operator.

## 6. Indexer + API

- Point `packages/indexer/src/chain.mjs` at the RPC and the deployed factory/registry addresses;
  run the poller from block = deploy block.
- Set `CHAIN_ID` for `apps/api`. It resolves whether that chain meters reads over x402 from
  `contracts/config/<chain>.json`, and the rest of this bullet depends on the answer:
  - **Chains that meter** (Base Sepolia; anything with no `x402` block, which is the default):
    deploy `apps/api` behind the x402 facilitator for the chain (Coinbase x402 facilitator on
    Base). Set the price spec (asset = USDC, payTo = your treasury, network).
  - **Chain 4663 (Robinhood Chain)** declares `x402.enabled: false` — the owner's decision of
    2026-09-05. There is no facilitator to deploy behind and no price spec to set: the same reads
    are served with no 402 gate. `PRICE_ASSET`/`PRICE_PAYTO` are still required env (the API
    validates them at startup, unchanged) but are never quoted to a caller. Set
    `RATE_LIMIT_PER_SEC`/`RATE_LIMIT_BURST` deliberately here rather than taking the defaults:
    with metering off they are the only limit on the read routes, where payment used to be.

## 7. Canary monitoring (post-launch)

Watch continuously; page on any breach. Every row below is implemented in `packages/canary` and runs
as a service — see **[CANARY.md](CANARY.md)** for thresholds, tuning, and the response to each:

```bash
RPC_URL=… OPERATOR_REGISTRY_ADDRESS=… STATE_PATH=./data/indexer-state.json npm run start:canary
```

It is silent while healthy, emits one line per signal transition, and is read-only against the chain
(no key, never sends). `docker compose up` starts it alongside the indexer and API.

> **The canary watches the launch oracle on two axes: freshness since #89, and feed IDENTITY since
> #103.** The `oracle-freshness` signal probes the deployed oracle and measures `ChainlinkOracle`
> directly: `priceWad(asset)` is ground truth and a revert *is* the incident, attributed to the
> sequencer, the heartbeat, the sane-price band, an unlisted asset or a dead feed. A detector that
> cannot run is reported `DETECTOR BROKEN` and re-asserted on a backoff rather than going quiet.
> The `feed-identity` signal (G2's on-chain half, [CANARY.md](CANARY.md) §3(g)) compares each
> feed's live `decimals()` against the **cached `scale` the deployed oracle actually multiplies
> by**, read from `feedOf(asset)`, re-runs the constructor's USD-denomination predicate against the
> live `description()`, and reads which `aggregator()` / `phaseId()` is behind the proxy. The two
> **harm** legs (decimals, denomination) compare chain against chain, so they have nothing to pin
> and nothing that can go stale; only the **identity** leg (aggregator, phaseId) keeps a remembered
> value, pinned on first sight into the canary's own state. Note the routing, because it decides
> who sees it: `feed-identity` is the one signal whose ALERTs are not all one severity, so since
> #121 it routes on a predicate (`CONDITIONAL_PAGE` in `packages/canary/src/sinks.mjs`) — it
> **PAGES** when `detail.harm` is `'decimals'` or `'denomination'`, the two latching cases where
> every price is silently wrong, and **LOGS** when `harm` is `null`, the benign aggregator swap
> that self-clears next sweep. That is a stronger check than the
> recurring script below, which tests Chainlink's 8-decimal *convention* rather than the number
> this oracle uses — **the canary now continuously re-runs the two construction-time proofs an
> immutable contract can never re-run itself.**
>
> What the recurring check below still adds, and why it is not redundant: a **git-tracked** pin
> (the canary pins on first sight, so a benign swap during canary downtime is adopted silently on
> restart), and the deprecation **announcement**, which is off-chain by nature and remains a weekly
> human item — up to 7 days of exposure, by choice, per the gap analysis's own build-vs-buy call.

### 7a. Recurring feed check — run this on a cadence, not only before deploying

```bash
node scripts/verify-chainlink-oracle.mjs
```

Read-only and keyless, so it is safe to run against a live deployment as often as you like. Run it
**weekly, and after any Chainlink feed announcement** — with
`--strict`, so an aggregator swap exits non-zero instead of scrolling past as a notice nobody
reads. Two things it catches that nothing on-chain
can:

- **Aggregator-swap drift** (residual register row 14). Chainlink swaps the aggregator behind a
  configured `EACAggregatorProxy` as routine operation, and `ChainlinkOracle` cached
  `scale = 10**(18 - decimals)` once, at construction, from a value that lives on the *aggregator*.
  The script's `decimals() == 8` check is a complete test of that residual **at the sampling
  instant**: if a feed reports 8 when you run it, the cached scale was correct however many swaps
  had happened by then. It says nothing about the interval between runs — a swap that drifts and
  reverts between two weekly runs is invisible — so the exposure window is the run interval, and
  the cadence is the control. Each
  feed's `aggregatorPin` in the config makes the swap itself **visible** — reported as a `DRIFT`
  notice, never a failure, because a swap is legitimate. A `DRIFT` line alongside a passing decimals
  check is the reassuring outcome: it moved, and it re-checked clean. Update the pin and move on.
- **A `FAIL` on decimals is the alarming outcome** and needs the [INCIDENTS.md §1a](INCIDENTS.md)
  response (residual register **row 14**), not a config edit:
  every vault priced by that oracle is now mis-scaled by a power of ten, no on-chain lever can fix
  it (the vault's oracle is `immutable` — row 12), and members should be told to exit. **On a vault with
  no sub-vaults, exits still settle correctly under drift** — `_settleExit` sizes the in-kind
  slice pro-rata from `assetBalance` and only *values* it through the oracle, which is what
  `test_harmModel_driftDoesNotRobAnExitingMember` demonstrates. That is the shape the proof
  covers, and it is the launch shape (`Deploy.s.sol` sets `allowSubVaults = false`). **With
  children present it is unproven**: `childValTotalWad` is oracle-derived and enters the *sizing*
  of the cash leg, not only its valuation. Do not tell a member with a sub-vault parent that
  their exit is unaffected.

| Signal | Alert condition |
| --- | --- |
| Oracle health | any basket asset whose `priceWad` reverts `StaleOracle` — aged past its heartbeat, outside its sane-price band, feed dead or unlisted — or the L2 sequencer down / inside its grace period ([CANARY.md §3(a)](CANARY.md)) |
| NAV vs. token balances | `navWad` diverges from independently-computed holdings > 0.5% |
| Share conservation | `Σ sharesOf != totalShares` (indexer vs. chain read) |
| Exit liveness | any `requestExit` reverting for a non-gate reason (H-1 regression sentinel) |
| Fee routing | any USDC leaving a vault to an operator address outside the FeeEngine claim flow |
| Module-call failures | `ModuleCallFailed` and `SliceEscrowed` events (a creator-chosen module or a basket token misbehaving) |
| Governance watch | a proposal entering any phase — commit, reveal, awaiting finalize, timelock, executable, lapsed — with the reveal deadline and earliest `execute` in `detail` ([CANARY.md §3(h)](CANARY.md)) |

## 8. Mainnet gate

Do **not** deploy to mainnet before: (a) an external audit consuming
[AUDIT-HANDOFF.md](AUDIT-HANDOFF.md), (b) audit findings remediated + re-reviewed, (c) a
staged-value guardrail period on testnet, (d) `capacityCapUsdc` set conservatively for the
initial vaults.

**What was satisfied for the Robinhood Chain mainnet deployment of 2026-09-05, stated
rather than left to inference** (added 2026-09-04): (a) the external audit was commissioned and
owner-attested against the launch tree, so it was satisfied for the source but not for the
`requiresSequencerUptimeFeed` change made after it; (b) the pre-audit and audit findings were
remediated and re-reviewed on that same tree; (c) a staged-value guardrail period on testnet was
**NOT** completed — gates 3 and 6 have no current evidence on any chain: the five drills and the
canary alongside them ran on Base Sepolia on 2026-08-24/25 and passed 5/5
([SOAK-REPORT.md](SOAK-REPORT.md)), but against bytecode that has since changed, and they have not
been re-run; (d) no vault has been created on chain 4663, so no `capacityCapUsdc` has been fixed
there yet — the cap vault #1 is created with will be immutable and readable on-chain from the
moment the creator Safe creates it. The deployment proceeded on the owner's decision of
2026-09-04 with (c) outstanding.

## 9. Source-verifying a LIVE deployment (read this before running `forge verify-contract`)

**`HEAD` is not guaranteed to reproduce a historical deployment's bytecode — only the exact
commit it was built from is.** `contracts/foundry.toml` sets no `bytecode_hash`, so solc's
default `ipfs` metadata mode applies: every compiled contract's runtime bytecode ends with a CBOR
trailer whose IPFS hash is a digest of the compiler's `sources` map, keyed by **source path**.
Moving, renaming, or re-pathing *any* file in a contract's compiled dependency graph — including
one it only imports indirectly, and including a file that has nothing to do with the contract's
own logic — changes that trailer, even though not one opcode changed. Deployed bytecode is fixed
forever; `HEAD` keeps moving. The two drift apart the first time a relevant path changes.

**This already happened once, silently.** The 2026-08-29 retired-oracle prune
(`chore/prune-retired-oracle-stack`) moved five files out of `contracts/src/` into
`contracts/test/retired/` and rewrote `ChainlinkOracle.sol`'s import of one of them.
`ChainlinkOracle.sol` itself did not move and its logic did not change, but its compiled metadata
trailer did — found only because a reviewer went looking after the fact. Measured on 2026-09-01
against what was then the live Base Sepolia deployment
(`ChainlinkOracle` at `0x6371E14C0682882e75E8382caf0216545B1f43C6`, at `sourceCommit 5934ef22`).
**That deployment has since been replaced** — the current record pins `sourceCommit 8a0e1155` with
the oracle at `0x3a8bd8a6599c3fdd0b3a269e0142e6b468ddd935` — so the addresses and commits in the
two bullets below are the worked example, not the current instance. The mechanism they demonstrate
is unchanged and is exactly why the procedure that follows exists:

- Building `ChainlinkOracle` at `protocol/main` and masking its two immutable slots (`usdc`,
  `sequencerUptimeFeed` — the only non-deterministic bytes a fresh build can never match, since
  they are baked in at construction, not compile time) still leaves a **32-byte divergence in the
  trailing CBOR metadata** (the IPFS hash) against the deployed runtime code. Everything else —
  every opcode, all 1,532 bytes of runtime length — is identical.
- Building at the commit that deployment record pinned as **`sourceCommit`** (`5934ef22`)
  reproduces the deployed runtime bytecode **byte-for-byte, including the trailer**. Zero bytes
  differ, not even under masking. The same rule applies to the current record: build at
  `8a0e1155`, read from
  [`config/deployments/base-sepolia.json`](../contracts/config/deployments/base-sepolia.json),
  never at `HEAD`. On the current deployment the divergence has a second cause worth naming,
  because it is the least obvious one: the only `contracts/src/` change between `8a0e1155` and
  `protocol/main` is a **comment-only** edit to `VaultDeployer.sol` (#151), and since the trailer
  hashes source text, that alone moves `VaultDeployer`'s trailer while leaving every opcode and
  its 938 B length untouched. A metadata divergence does not imply a code difference.

So the finding is a **documentation gap, not a code defect**: nothing on-chain is wrong, the
deployed contract behaves exactly as its source says, and it can still be source-verified — the
missing piece was ever writing down that verification must build at the pinned commit, not at
whatever `main` happens to be when you get around to it.

### The procedure

1. **Read `sourceCommit` from the deployment record** for the chain you're verifying against
   (`contracts/config/deployments/<chain>.json`). If the field is missing, stop — there is
   nothing to pin to, and verifying against `HEAD` is a coin flip that happens to work until the
   next file move.
2. **Check out that commit into its own worktree**, so you never disturb whatever branch you're
   actually working on (this is a shared worktree — see `docs/SWARM.md` §8):
   ```bash
   git worktree add ../verify-<chain>-<sourceCommit> <sourceCommit>
   cd ../verify-<chain>-<sourceCommit>/contracts
   forge build --skip test --skip script
   ```
3. **Recover the constructor arguments** the same way the deploy script did — from that SAME
   commit's config file, not today's. For `ChainlinkOracle` on Base Sepolia,
   `script/DeployTestnet.s.sol` builds them from `config/base-sepolia.json`'s `chainlinkOracle`
   block (`assets[].asset` / `.feed` / `.heartbeatSeconds` / `.minPriceWad` / `.maxPriceWad`,
   `usdcPin`, `sequencerUptimeFeed`), in that array order — read that script's `_deployOracle`
   helper at the pinned commit if the shape has since changed. (As of this writing the
   `chainlinkOracle` block's *values* are unchanged since `5934ef22`, and the whole file is
   blob-identical between the currently pinned `8a0e1155` and `protocol/main` at
   `b91cb18f9725` — so today's committed config still reconstructs the right arguments; that was
   checked, not assumed, and may not stay true forever.) Alternatively, skip
   manual reconstruction and pass `--guess-constructor-args` (see `forge verify-contract --help`)
   to have `forge` extract them from the on-chain creation transaction directly.
4. **Verify from the pinned-commit worktree**, not your working tree, so the compiler sees that
   commit's file layout:
   ```bash
   forge verify-contract --chain 84532 <address> \
     src/oracle/ChainlinkOracle.sol:ChainlinkOracle \
     --constructor-args <abi-encoded-args-or---guess-constructor-args> \
     --etherscan-api-key "$ETHERSCAN_API_KEY" --watch
   ```
5. **Remove the scratch worktree** when done (`git worktree remove ../verify-<chain>-<sourceCommit>`).

### What to expect from each verifier

This repo has not run a real verification submission against either explorer as part of this
finding (no API key was available; only the pinned-commit rebuild above was measured). What
follows is documented, standard verifier behavior, not a repo-specific measurement — treat it as
guidance, and expect the pinned-commit build to be the reliable path either way:

- **A pinned-commit build should verify cleanly everywhere**, since the bytecode — trailer
  included — matches exactly what step 2 above proved.
- **Basescan/Etherscan-family explorers** generally require the submitted source to compile to
  bytecode that matches the deployed contract; a metadata-only mismatch (built at `HEAD` instead
  of the pinned commit) is the most common reason a "the source is definitely right" submission
  still comes back unverified. If a `HEAD`-built submission is ever rejected only on the trailer,
  that is this exact issue — rebuild at `sourceCommit` and resubmit.
- **Sourcify** distinguishes a "full match" (bytecode identical including metadata) from a
  "partial match" (identical except metadata) and accepts both as verified, labeling which one you
  got — by protocol design, precisely to handle non-reproducible metadata hashes like this one. A
  `HEAD`-built submission there may succeed as a partial match even without pinning; a
  pinned-commit build should come back a full match. This was not tested against a live endpoint
  for this finding — confirm before relying on it.

### Keeping this reproducible: `node scripts/verify-deployment-reproducibility.mjs` (standalone, not wired into `npm run gate`)

This checks, offline and without touching an RPC,
that every `contracts/config/deployments/*.json`'s `sourceCommit` still resolves in local git
history **and** is still reachable from `origin/protocol/main` — the one part of this procedure
that can rot silently (a rebase or a pruned branch can make a previously-valid `sourceCommit`
unreachable long after the deployment it describes is still live). It does **not** and cannot
detect metadata drift itself — drift is expected any time `contracts/` changes under `ipfs` mode
and is not, on its own, a defect. It is deliberately **not** one of `scripts/gate.mjs`'s 9 CI-mirroring
steps (that file's own header states it must mirror `.github/workflows/ci.yml`, not add to it —
wiring this in would mean editing both, and the check has nothing to do with whether the current
diff is mergeable). Run it by hand before cutting a new deployment record, or whenever
`contracts/src/` moves files around and a live deployment references the old layout.
