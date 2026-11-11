# Ethereum v2 deploy dry run, 2026-10-21

A rehearsal of the v2 (same-address CREATE2) bring-up on Ethereum, run on a local anvil with no real
key and nothing sent to any network. It covers `contracts/script/DeployChainlinkOracle.s.sol` and
`contracts/script/Deploy.s.sol`, plus a real Safe v1.4.1 set up 2 of 3 as the vault creator. First run
at `protocol/main` `c3277fc` on 2026-10-21.

**Re-run on 2026-10-22 at `protocol/main` `627230b`**, after the agent registry (#468), the factory's
100 USDC minimum deposit floor (#500) and the agent vault path (#483) landed, and after the FeeEngine
A1 treasury split (#477). Foundry 1.7.1 with native solc 0.8.26. The transcript, every address and
every gas figure below are from that re-run. Two harness changes were needed for it to run on the
current set, both in this folder and neither in `contracts/`:

- `Deploy.s.sol` now refuses unless `RWAllyAgentRegistry` already has code at the address in
  `contracts/config/agent-registry-create2.json`. The harness gained step 2c, which sends
  `salt || initcode` from that record to the Arachnid proxy (permissionless, any key) and checks the
  initcode hash against the record. It deploys the registry's code only; the registry's own
  `initialize` is a separate owner step and was not run. `plan.tmpl.json` gained the `agentRegistry`
  field the initialisation preflight now requires.
- `safe-2of3.mjs` asked for a 10 USDC `minDepositUsdc`, which the factory now refuses
  (`MinDepositBelowFloor`); it asks for the 100 USDC floor.

Before those changes the re-run at `627230b` failed at step 3c (`Deploy: the agent registry at
config/agent-registry-create2.json has no code on this chain; deploy it first`) and at step 8.

**Result at `627230b`: the run completes. 63 checks pass, 0 fail** (57 at `c3277fc`). One blocker
changed the method (no mainnet fork, see below), and three gaps in the scripts and runbook need a
decision before the freeze. The checklist at the end is for the freeze, after the harness is re-run
on the frozen commit.

- Harness, re-runnable: [`2026-10-21-deploy-dry-run/run-all.sh`](2026-10-21-deploy-dry-run/run-all.sh)
- Full transcript of the run summarised here: [`2026-10-21-deploy-dry-run/transcript.txt`](2026-10-21-deploy-dry-run/transcript.txt)
- Read-back, also usable against a real RPC: [`2026-10-21-deploy-dry-run/readback.sh`](2026-10-21-deploy-dry-run/readback.sh)
- Safe 2 of 3 route: [`2026-10-21-deploy-dry-run/safe-2of3.mjs`](2026-10-21-deploy-dry-run/safe-2of3.mjs)

## Blocker: no mainnet fork from this session

The 2026-10-22 re-run kept the same fresh-anvil method so its transcript compares line for line with
the first run; the harness has no fork option. Public Ethereum RPCs did serve historical state to the
re-run machine (the ERC-8004 import ceiling was re-read at block 26221001 the same day), so a fork is
now possible but was not run. The rest of this section describes the first run.

The task asked for a fork of Ethereum mainnet. The first run's cloud egress policy refuses every
Ethereum RPC host tried (publicnode, llamarpc, cloudflare-eth, ankr, merkle, 1rpc, blastapi,
tenderly gateway, flashbots), and also `foundry.paradigm.xyz` and `binaries.soliditylang.org`. So:

- **Chain.** A fresh anvil at **chain id 1** with the **Osaka** hardfork, not a fork. Chain id 1 is
  what matters for the scripts: every policy branch in them keys on `block.chainid`, and they took
  the Ethereum branch (band mandatory, sequencer feed exempt, non-empty allowlist required).
- **Mainnet state that was needed, stood in for.** Anvil ships Arachnid's proxy at
  `0x4e59b44847b379578588920cA78FbF26c0B4956C` with the 69-byte runtime shown in the transcript. The
  Chainlink feeds and tokens were replaced by small stand-in contracts etched at the real mainnet
  addresses (ETH / USD `0x5f4e…8419`, BTC / USD `0xF403…E88c`, WETH, WBTC, USDC), answering
  `description()`, `decimals()` and an always-fresh `latestRoundData()`. **Nothing about the real
  feeds was read: their code, heartbeats, aggregator pins and live prices are unverified by this
  run.** Those addresses are placeholders for a basket the repo has not yet configured (gap 1).
- **Tooling.** Foundry 1.7.1 came from the `@foundry-rs/*` npm packages. solc 0.8.26 came from the
  `solc` npm package (the WebAssembly build) behind a small `--standard-json` shim, passed to forge
  with `--use`. **The build is byte-identical to native solc:** `node scripts/update-create2-manifest.mjs --check`
  passes, so every initcode hash and address in `contracts/config/create2-manifest.json` was
  reproduced. On the freeze machine use native solc; nothing here depends on the shim.

What a real fork would add, and this run does not prove: that each predicted address is empty on
Ethereum today, that the real proxy's runtime matches, that `PROTOCOL_INITIALIZER` holds enough ETH,
and that the real feeds pass `DeployChainlinkOracle`'s denomination checks. All four are reads,
listed in the checklist.

## Transcript summary

| Step | What ran | Outcome |
|---|---|---|
| 0 | chain id, proxy runtime, predicted addresses | chain id 1, Osaka; proxy 69 bytes; all seven manifest addresses empty |
| 2a | `DeployChainlinkOracle` with no price band | **refused**: band required on every chain except 31337 and 84532 |
| 2b | `DeployChainlinkOracle`, throwaway anvil key, bands at ratio 200 | `ChainlinkOracle` at `0x5FC8…5707`; both feeds `feed OK`; sequencer feed `address(0)` |
| 2c | `RWAllyAgentRegistry` via the Arachnid proxy, throwaway key | initcode hash equals the record; code at `0x1337f59A…3D2C`, the recorded address; gas used 3,038,833, under the cap |
| 3a | `Deploy.s.sol` with empty `BLESSED_ORACLES` | **refused** before any send (C-6 guard) |
| 3b | `Deploy.s.sol` signed by the throwaway key | **refused** before any send: the broadcast is pinned to `PROTOCOL_INITIALIZER` |
| 3c | `Deploy.s.sol` as `PROTOCOL_INITIALIZER` (anvil impersonation, no key) | 13 transactions, all status 1; seven addresses equal the manifest; the script read the agent registry address from its record |
| 4 | per-transaction gas against the EIP-7825 cap (16,777,216) | largest gas limit 7,314,100 (`AgentVaultDeployer`); all 14 under the cap (1 oracle + 13 deploy-script transactions) |
| 5 | read-back: immutables, wires, oracle config, replays | 40 of 40 pass, including `FeeEngine.treasury` and the `FeeEngine.initialize` replay; three runtimes equal the local build |
| 6 | `scripts/protocol-initialize-preflight.mjs`, two endpoints | `preflight ok` (agent path pinned to the plan's registry); negative plan exits 1 |
| 7 | `update-create2-manifest.mjs --check` | matches |
| 8 | real Safe v1.4.1, 2 of 3, creates and registers the first vault | one signature **refused** (`GS020`); `registerVault` from any non-creator refused; two of three succeed; creator and operator are the Safe |

Addresses at `627230b` that differ from the first run: `FeeEngine` `0x9108…8E12` (was `0x71b7…6999`),
`VaultFactory` `0xe31e…2547` (was `0xcAa8…0e0d`), and the new `AgentVaultDeployer` `0x1c82…ef5b`.
`OperatorRegistry`, `SubVaultRegistry`, `Governance` and `VaultDeployer` are unchanged.

Anvil does not enforce EIP-7825 (a 16,777,217 gas transaction was accepted when tried by hand in
this session), so the harness checks the cap itself in step 4.

### Gas, as measured

All gas figures in this table are from the 2026-10-22 re-run at `627230b`; re-measure at freeze if
`contracts/src` changes again.

| Sender | Transactions | Gas used (2026-10-22 re-run at `627230b`) |
|---|---|---|
| any key (oracle deploy, plain CREATE) | 1 | 537,930 |
| any key (`RWAllyAgentRegistry` via the Arachnid proxy) | 1 | 3,038,833 |
| `PROTOCOL_INITIALIZER` (seven CREATE2, then six one-shot calls) | 13 | 16,495,241 |
| creator Safe (`createVault`, `registerVault`, via `execTransaction`) | 2 | 4,826,534 |

`Deploy.s.sol` sends 13 transactions: seven CREATE2 creates, then the six one-shot calls
(`factory.initialize`, `factory.initializeAgentPath`, `registry.wire`, `subReg.wire`,
`governance.wireSubVaultRegistry`, `feeEngine.initialize`). A full rehearsal is 1 + 1 + 13 + 2 = 17
transactions. Forge sets each gas limit at 130% of its estimate, so the key needs that headroom on hand
when each transaction is sent. At 1 gwei the `PROTOCOL_INITIALIZER` batch costs about 0.0165 ETH of
gas used; the cost scales linearly with the day's gas price. The registry deploy is not in that batch
and its sender need not be `PROTOCOL_INITIALIZER`; the registry's own `initialize` (not run here)
is sent by `PROTOCOL_INITIALIZER` and is not counted.

## Constructor arguments, role grants and ownership

**Constructor arguments.** Two singletons take any. Both were read back from the deployed immutables
at `627230b` (`FeeEngine` additionally has a one-shot `initialize(treasury)`, below):

- `FeeEngine(registry)`: `registry()` is the `OperatorRegistry` address. The constructor argument is
  fixed by the CREATE2 initcode, so it is not a free choice.
- `VaultFactory(registry, governance, feeEngine, subVaultRegistry, vaultDeployer, allowSubVaults)`:
  all five addresses match the set, and `allowSubVaults()` is `false` (C-1, root vaults only).
- `ChainlinkOracle(assets, feeds, heartbeats, minWad, maxWad, usdc, sequencer)`: `feedOf(asset)`
  returned the feed, heartbeat, `scale` 1e10 and both band edges exactly as passed; `usdc()` is the
  pinned USDC; `sequencerUptimeFeed()` is `address(0)`, the Ethereum exemption.

The other five take none. Three have runtime code equal to the local build byte for byte
(`OperatorRegistry`, `SubVaultRegistry`, `Governance`); `VaultDeployer` and `AgentVaultDeployer`
carry immutables, so they are covered by their initcode hashes instead.

**Role grants: there are none to make.** `contracts/src` contains no `Ownable`, no `AccessControl`,
no `onlyOwner`, no `grantRole` and no `transferOwnership`. On the same-address (v2, CREATE2) set built
from the current source, the privileged caller is the constant `PROTOCOL_INITIALIZER` (`0x0f80…9f35`),
with six one-shot calls: `VaultFactory.initialize`, `VaultFactory.initializeAgentPath`, the three
wires and `FeeEngine.initialize` (the per-chain treasury, `FEE_TREASURY`; `docs/DEPLOYMENT.md` counts
the same six). (The live Arc set, v1 by plain CREATE, has no `initialize`.) The re-run at `627230b`
proved five of them spent: replayed from that address after bring-up, `VaultFactory.initialize` and
`FeeEngine.initialize` revert `AlreadyInitialized` and the three wires revert `AlreadyWired` /
`AlreadyWiredSubRegistry`. `readback.sh` does not replay `initializeAgentPath`; `VaultFactory.sol`
reverts a second call with `AgentPathAlreadyInitialized`, unexercised by this run. The
`RWAllyAgentRegistry` has its own one-shot `initialize`, also callable only by `PROTOCOL_INITIALIZER`;
this run deployed its code without calling it. `ChainlinkOracle` and the execution adapters have no
admin at all.

**Ownership handoff to the 2 of 3: there is no protocol ownership to hand off.** Nothing in the
singleton set can be transferred to a Safe, and `PROTOCOL_INITIALIZER` cannot be a Safe either: it
is a literal in every singleton's initcode, so changing it moves every address on every chain. Where
the multisig does belong is the **vault creator**, which the factory also attests as the vault's
**operator** (`OperatorRegistry.attestVault(vault, msg.sender)`). That attestation has no rebind, so
the creator address is permanent for that vault, including as the recipient of its operator fees.
Step 8 proved the route end to end against real Safe bytecode: `vault.creator()` and
`operatorAddressOf(operatorOf(vault))` both read back the Safe; `registerVault` from
`PROTOCOL_INITIALIZER` or from the throwaway key reverts `NotVaultCreator` (selector `0x9db30794`); through the Safe it lands
and `configOf` reads back the Arc launch tuple. The Safe transaction hash was recomputed locally by
`scripts/lib/safe-exec.mjs` and matched the Safe's own `getTransactionHash` before anything was
signed.

## Findings

1. **No Ethereum config exists in the repo.** There is no `contracts/config/ethereum-mainnet.json`,
   so the basket, feed proxies, heartbeats, bands, aggregator pins and USDC for Ethereum are
   undecided in the tree, and `scripts/verify-chainlink-oracle.mjs` has nothing to verify against.
   The dry run's WETH + WBTC basket, 3,600 s heartbeats and ratio 200 bands are placeholders only.
   The band also stays hand-typed into `ORACLE_MIN_WAD` / `ORACLE_MAX_WAD` (the `BAND-BINDING` gap in
   `docs/LAUNCH-READINESS.md`); `readback.sh` shows the `feedOf` comparison that closes it after the
   fact.
2. **`Deploy.s.sol` wires in the same broadcast as `initialize`, but `docs/DEPLOYMENT.md` §10 says to
   run the initialisation preflight between them** ("Only when it passes send the three wires"). Run
   as written, the script makes the three irreversible wires before any preflight can look. The
   factory still refuses vaults until it is initialised, and the script checks `initialized()` after
   the fact, but the preflight's job (catching a wrong or extra blessed oracle before the set is
   locked to that factory) is skipped. Not changed here: it alters the signing sequence. Two ways to
   close it are in the checklist.
3. **The sign queue has no v2 builder.** `scripts/sign-queue/arc-deploy.mjs` mirrors the Arc v1
   bring-up: plain CREATE, addresses predicted from the deployer's nonce. Nothing builds the v2
   CREATE2 transactions (calls to the Arachnid proxy with `salt || initcode`) for Ethereum, so today
   the freeze would have to run `forge script` from the signing machine.
4. **`docs/DEPLOYMENT.md` §2's command is Base Sepolia's** (`--rpc-url "$BASE_SEPOLIA_RPC"`,
   `--verify`). For Ethereum it needs an Ethereum RPC and an Etherscan key for `--verify`.
5. **A rehearsal at chain id 1 writes where the real run will.** forge records to
   `contracts/broadcast/<script>/1/run-latest.json` and `contracts/cache/<script>/1/`, the paths a
   real mainnet run (and `forge script --resume`) reads. The harness sets `FOUNDRY_BROADCAST` to a
   scratch directory and deletes the chain 1 cache entries on exit; a hand-run rehearsal does neither.
6. **Fixed in this PR: a stale heartbeat bound in `DeployChainlinkOracle.s.sol`'s header.** It said
   the constructor bounds a heartbeat to `[600, 86400]`; `ChainlinkOracle` sets `MAX_HEARTBEAT` to
   `90_000`. Comment only.
7. **Tooling, not a protocol issue.** `npm ci` on npm 10.9.4 refuses the lockfile (`Missing:
   utf-8-validate@5.0.10 from lock file`). `npm install` works. Worth confirming the freeze machine
   uses the same npm as CI.

## Checklist for the real freeze

Read every chain value on **two RPC endpoints** and treat a failed read as a failure.

**Decisions first**

- [ ] Ethereum basket, feeds, heartbeats and bands decided and committed as
      `contracts/config/ethereum-mainnet.json`; `CONFIG=contracts/config/ethereum-mainnet.json node scripts/verify-chainlink-oracle.mjs --strict` passes (finding 1).
- [ ] Preflight ordering decided (finding 2): either split `Deploy.s.sol` into a deploy + `initialize`
      entrypoint and a wires entrypoint with the preflight between them, or accept the one broadcast
      and record the decision in `docs/DEPLOYMENT.md` §10.
- [ ] Signing path decided (finding 3): `forge script` from the signing machine, or a v2 builder for
      the sign queue.
- [ ] Creator Safe owners decided: three distinct keys, held apart. Recommended: `PROTOCOL_INITIALIZER`
      is **not** one of them (the Arc creator Safe was 1 of 1 with that key as its owner).

**Build**

- [ ] Native solc 0.8.26; `forge build` in `contracts/`; `node scripts/update-create2-manifest.mjs --check` passes.
- [ ] `npm run gate` green on the frozen commit.
- [ ] No `contracts/broadcast/*/1/` or `contracts/cache/*.s.sol/1/` left from any rehearsal (finding 5).
- [ ] No stale RPC variables exported in the signing shell.

**Chain reads before anything is sent**

- [ ] `eth_chainId` is 1.
- [ ] Code at `0x4e59b44847b379578588920cA78FbF26c0B4956C` equals the 69-byte runtime in the transcript.
- [ ] Each of the seven manifest addresses has empty code. If one has code, someone has run the same
      public initcode first; the script will then revert in simulation. Compare that runtime with the
      local build and finish the remaining creates by hand, per `docs/DEPLOYMENT.md` §10.
- [ ] `RWAllyAgentRegistry` has code at the address in `contracts/config/agent-registry-create2.json`
      and is initialised for this chain; `Deploy.s.sol` refuses without the code.
- [ ] `PROTOCOL_INITIALIZER` balance covers the 13-transaction batch at the day's fee, with 30%
      headroom. Gas used: 16,495,241 at `627230b`; re-measure if `contracts/src` changed since.
- [ ] `FEE_TREASURY` decided: the real per-chain treasury address, non-zero, set once and never
      changed. The harness uses a placeholder (`0x…fEE1`) that is not the real treasury.
- [ ] Each feed proxy: code present, `description()` ends in `/ USD`, `decimals()` is 8, answer
      inside its band, aggregator pin recorded.

**Send**

- [ ] `DeployChainlinkOracle.s.sol` with the committed config (any key; the oracle has no admin).
      Read `feedOf(asset)` back and compare with the config (finding 1).
- [ ] `Deploy.s.sol` with `BLESSED_ORACLES=<that oracle>` and `FEE_TREASURY=<the treasury>`, signed as
      `PROTOCOL_INITIALIZER`. Expect 13 transactions (seven creates, then the six one-shot calls
      listed under Gas), all under 16,777,216. The largest gas limit was 7,314,100 at `627230b`
      (`AgentVaultDeployer`).
- [ ] `node scripts/protocol-initialize-preflight.mjs --plan <plan>` with two real endpoints: `preflight ok`.
- [ ] `R=<rpc> ORA=<oracle> FEE_TREASURY=<the treasury> docs/audits/2026-10-21-deploy-dry-run/readback.sh`
      on each endpoint, with the `feedOf` expectations edited to the frozen config: 0 fail. It reads
      the six addresses from the manifest and checks `FeeEngine.treasury()` and that
      `FeeEngine.initialize` replays as a revert.

**Creator Safe and first vault**

- [ ] Safe deployed on Ethereum: code present, `VERSION()` 1.4.1, `getThreshold()` 2, `getOwners()`
      the three decided keys.
- [ ] `createVault` then `registerVault`, each through the Safe's `execTransaction` with two
      signatures via `scripts/lib/safe-exec.mjs` (the local hash recompute must match).
- [ ] `vault.creator()` and `operatorAddressOf(operatorOf(vault))` are the Safe;
      `governance.vaultRegistered(vault)` is true; `configOf(vault)` is the decided tuple.

**After**

- [ ] Deployment record `contracts/config/deployments/ethereum-mainnet.json` written from two-endpoint
      reads; `docs/NOW.md` updated in the same commit.
- [ ] `PROTOCOL_INITIALIZER` key back in cold storage. It has spent its six one-shot calls on Ethereum, but
      it still makes the six one-shot calls on every chain where the v2 set is not yet initialised.

## Re-running this

```bash
# forge, cast and anvil on PATH; contracts/ built
SAFE_ARTIFACTS=<node_modules>/@safe-global/safe-contracts/build/artifacts/contracts \
  docs/audits/2026-10-21-deploy-dry-run/run-all.sh
```

The harness exports `FEE_TREASURY` to `Deploy.s.sol` (default: the placeholder `0x…fEE1`, override
with your own). `readback.sh` and `safe-2of3.mjs` read the six singleton addresses from
`contracts/config/create2-manifest.json`.

`SAFE_ARTIFACTS` comes from `npm i @safe-global/safe-contracts@1.4.1-build.0`; without it step 8 is
skipped and says so. `SOLC=<path>` passes a local solc to forge with `--offline`. Every key in the
harness is a public anvil test key, and every address it sends to is on `127.0.0.1`.
