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

**Third run on 2026-10-22, both ways, on branch `fix/deploy-path-hardening` at `3041aa6`** (base
`protocol/main` `07d1be0`), Foundry 1.7.1 with native solc 0.8.26. That branch changes
`Deploy.s.sol` without touching `contracts/src`, so every address is unchanged:
`feeEngine.initialize` now goes before `registry.wire`, and the post-broadcast checks read each wired
value. The harness gained a fork mode (`FORK_URL`), step 2d (the agent registry's own `initialize`,
then a repeat that must revert), and read-back of the agent path plus a replay of every one-shot
call. Every figure below from step 2c on is from this run unless it names another commit.

- **Plain anvil** (the default, stand-ins as before): [`transcript.txt`](2026-10-21-deploy-dry-run/transcript.txt).
- **Fork of Ethereum mainnet** at block 26246867 through `https://ethereum-rpc.publicnode.com`
  (`FORK_URL`): [`transcript-fork.txt`](2026-10-21-deploy-dry-run/transcript-fork.txt). The real
  Arachnid proxy, Chainlink feeds, tokens and ERC-8004 registry were used; nothing was etched except
  clearing any code at the four public anvil test accounts.

**Result on both runs: the run completes. 74 checks pass, 0 fail** (63 at `627230b`, 57 at
`c3277fc`; the new ones are step 2d and the read-back of the agent path, the agent registry and two
more replays). The fork found one thing the plain chain cannot show (finding 8:
`PROTOCOL_INITIALIZER` carries an EIP-7702 delegation on Ethereum). The checklist at the end is for
the freeze, after the harness is re-run on the frozen commit.

- Harness, re-runnable: [`2026-10-21-deploy-dry-run/run-all.sh`](2026-10-21-deploy-dry-run/run-all.sh)
- Read-back, also usable against a real RPC: [`2026-10-21-deploy-dry-run/readback.sh`](2026-10-21-deploy-dry-run/readback.sh)
- Safe 2 of 3 route: [`2026-10-21-deploy-dry-run/safe-2of3.mjs`](2026-10-21-deploy-dry-run/safe-2of3.mjs)

## Fork mode, and the first run's blocker

The fork closes three of the four reads the first run could not make: on Ethereum at block 26246867
each of the seven predicted addresses and the recorded agent registry address has no code; the
proxy's runtime is the same 69 bytes; and the real ETH / USD and BTC / USD feeds pass
`DeployChainlinkOracle`'s checks (`description()` ends in `/ USD`, `decimals()` 8, answers 2,424.39
and 82,175.14, each updated within the hour). The fourth, whether `PROTOCOL_INITIALIZER` holds
enough ETH, it answered no: it holds 34,654,906,438,668 wei (about 0.0000347 ETH) against a batch of
16,495,241 gas (finding 8). The fork run impersonated it with its real code in place, and the
broadcast still completed.

The rest of this section describes the first run, which could not fork. The task asked for a fork
of Ethereum mainnet. The first run's cloud egress policy refuses every
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

Outcomes are the same on both runs except where a cell says otherwise.

| Step | What ran | Outcome |
|---|---|---|
| 0 | chain id, proxy runtime, predicted addresses | chain id 1, Osaka; proxy 69 bytes; all seven manifest addresses and the agent registry address empty. `PROTOCOL_INITIALIZER`: no code, nonce 0 on the plain chain; **23 bytes of code (an EIP-7702 delegation) and nonce 16 on the fork** (finding 8) |
| 1 | mainnet feeds and tokens | plain: stand-ins etched at the real addresses. Fork: the real feeds and tokens, read back (decimals 8 / 8 and 18 / 8 / 6) |
| 2a | `DeployChainlinkOracle` with no price band | **refused**: band required on every chain except 31337 and 84532 |
| 2b | `DeployChainlinkOracle`, throwaway anvil key, bands at ratio 200 | both feeds `feed OK`; sequencer feed `address(0)`. Oracle at `0x5FC8…5707` (plain) or `0x0243…Be78` (fork; the throwaway key's mainnet nonce differs) |
| 2c | `RWAllyAgentRegistry` via the Arachnid proxy, throwaway key | initcode hash equals the record; code at `0x1337f59A…3D2C`, the recorded address; gas used 3,038,833, under the cap |
| 2d | `RWAllyAgentRegistry.initialize` as `PROTOCOL_INITIALIZER`, then the same call again | first lands (owner, fee token USDC, treasury placeholders); the repeat **reverts** `AlreadyInitialized` (`0x0dc149f0`). Plain: no outside registry (nothing is at the ERC-8004 address). Fork: the real ERC-8004 registry with the recorded Ethereum import ceiling 54,274 |
| 3a | `Deploy.s.sol` with empty `BLESSED_ORACLES` | **refused** before any send (C-6 guard) |
| 3b | `Deploy.s.sol` signed by the throwaway key | **refused** before any send: the broadcast is pinned to `PROTOCOL_INITIALIZER` |
| 3c | `Deploy.s.sol` as `PROTOCOL_INITIALIZER` (anvil impersonation, no key) | 13 transactions, all status 1, `feeEngine.initialize` before `registry.wire`; seven addresses equal the manifest; the script's new read-back of every wired value passed |
| 4 | per-transaction gas against the EIP-7825 cap (16,777,216) | largest gas limit 7,314,100 (`AgentVaultDeployer`); all 14 under the cap (1 oracle + 13 deploy-script transactions) |
| 5 | read-back: immutables, wires, agent path, oracle config, replays | 49 of 49 pass, including the agent registry and agent deployer the factory pinned, and a replay of all seven one-shot calls (`factory.initialize`, `initializeAgentPath`, the registry's `initialize`, the three wires, `feeEngine.initialize`), each reverting; three runtimes equal the local build |
| 6 | `scripts/protocol-initialize-preflight.mjs`, two endpoints | `preflight ok` (agent path pinned to the plan's registry); negative plan exits 1 |
| 7 | `update-create2-manifest.mjs --check` | matches |
| 8 | real Safe v1.4.1, 2 of 3, creates and registers the first vault | one signature **refused** (`GS020`); `registerVault` from any non-creator refused; two of three succeed; creator and operator are the Safe |

Addresses at `627230b` that differ from the first run: `FeeEngine` `0x9108…8E12` (was `0x71b7…6999`),
`VaultFactory` `0xe31e…2547` (was `0xcAa8…0e0d`), and the new `AgentVaultDeployer` `0x1c82…ef5b`.
`OperatorRegistry`, `SubVaultRegistry`, `Governance` and `VaultDeployer` are unchanged. The third
run's seven addresses equal `627230b`'s.

Anvil does not enforce EIP-7825 (a 16,777,217 gas transaction was accepted when tried by hand in
this session), so the harness checks the cap itself in step 4.

### Gas, as measured

All gas figures in this table are from the third run at `3041aa6`; re-measure at freeze if
`contracts/src` changes again. The `PROTOCOL_INITIALIZER` batch equals `627230b`'s to the unit: the
reorder moved one transaction, and the new read-back runs after the broadcast, so it costs nothing on
chain.

| Sender | Transactions | Gas used, plain anvil | Gas used, mainnet fork |
|---|---|---|---|
| any key (oracle deploy, plain CREATE) | 1 | 537,930 | 565,030 |
| any key (`RWAllyAgentRegistry` via the Arachnid proxy) | 1 | 3,038,833 | 3,038,833 |
| `PROTOCOL_INITIALIZER` (`RWAllyAgentRegistry.initialize`) | 1 | 130,973 | 200,812 |
| `PROTOCOL_INITIALIZER` (seven CREATE2, then six one-shot calls) | 13 | 16,495,241 | 16,495,241 |
| creator Safe (`createVault`, `registerVault`, via `execTransaction`) | 2 | 4,826,534 | 4,859,098 |

The fork's registry `initialize` writes three more non-zero slots (outside registry, import ceiling,
import end). Its oracle deploy and `createVault` call into the real feeds and tokens instead of the
stand-ins, so their figures differ.

`Deploy.s.sol` sends 13 transactions: seven CREATE2 creates, then the six one-shot calls
(`factory.initialize`, `factory.initializeAgentPath`, `feeEngine.initialize`, `registry.wire`,
`subReg.wire`, `governance.wireSubVaultRegistry`). A full rehearsal is 1 + 1 + 1 + 13 + 2 = 18
transactions. Forge sets each gas limit at 130% of its estimate, so the key needs that headroom on hand
when each transaction is sent. At 1 gwei the `PROTOCOL_INITIALIZER` batch costs about 0.0165 ETH of
gas used; the cost scales linearly with the day's gas price. The registry deploy is not in that batch
and its sender need not be `PROTOCOL_INITIALIZER`; the registry's own `initialize` is sent by
`PROTOCOL_INITIALIZER` and is counted in its own row.

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
the same six). (The live Arc set, v1 by plain CREATE, has no `initialize`.) The
`RWAllyAgentRegistry` has its own one-shot `initialize`, also callable only by `PROTOCOL_INITIALIZER`.
The third run proved all seven spent on both chains: replayed from that address after bring-up,
`VaultFactory.initialize`, `FeeEngine.initialize` and the registry's `initialize` revert
`AlreadyInitialized` (`0x0dc149f0`), `initializeAgentPath` reverts `AgentPathAlreadyInitialized`
(`0xe255696b`), and the three wires revert `AlreadyWired` (`0xda7c0e55`) /
`AlreadyWiredSubRegistry` (`0x828cea67`). `ChainlinkOracle` and the execution adapters have no admin
at all.

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
2. **Closed on `fix/deploy-path-hardening`: `docs/DEPLOYMENT.md` §10 now describes the one-broadcast
   order the script sends,** with the preflight after the broadcast and before any vault or
   announced address. It used to say to run the preflight between `initialize` and the wires, which
   the script cannot pause for. The pause would not have made a wrong `initialize` recoverable (it is
   one-shot, and the recovery is a new salt either way); it would only have saved the gas of the
   remaining one-shot calls. In the same change `feeEngine.initialize` moved ahead of
   `registry.wire`, so no vault can exist while the engine takes no fee, and the script now reads
   back each wired value, not only the `initialized()` flags.
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
8. **`PROTOCOL_INITIALIZER` carries an EIP-7702 delegation on Ethereum, and almost no ETH.** Read on
   the fork at block 26246867 and again directly from `https://ethereum-rpc.publicnode.com` the same
   day: its code is `0xef0100` followed by `0x63c0c19a282a1b52b07dd5a65b58948a07dae32b`, its nonce is
   16 and its balance is 34,654,906,438,668 wei. The delegate reports `NAME()`
   `EIP7702StatelessDeleGator`, `VERSION()` `1.3.0` and `entryPoint()` the ERC-4337 v0.7 EntryPoint
   (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`). The same address has no code and nonce 0 on Base,
   Arbitrum One and Polygon (publicnode, same day). Every one-shot gate compares `msg.sender` with this
   address, so on Ethereum any path the delegate offers for making calls *as* this address (its own
   execute functions, user operations through the EntryPoint, and any delegation the key has signed)
   is a path to the seven one-shot calls before the real deploy lands. Not changed here: it is key
   custody, not code. The fork's broadcast completed with the delegation in place, so it does not block
   the script itself. The checklist asks for a decision before anything is sent.

## Checklist for the real freeze

Read every chain value on **two RPC endpoints** and treat a failed read as a failure.

**Decisions first**

- [ ] Ethereum basket, feeds, heartbeats and bands decided and committed as
      `contracts/config/ethereum-mainnet.json`; `CONFIG=contracts/config/ethereum-mainnet.json node scripts/verify-chainlink-oracle.mjs --strict` passes (finding 1).
- [x] Preflight ordering decided (finding 2): one broadcast, preflight after it, recorded in
      `docs/DEPLOYMENT.md` §10.
- [ ] `PROTOCOL_INITIALIZER`'s EIP-7702 delegation on Ethereum decided (finding 8): cleared, or kept
      with every delegation the key has signed accounted for. Re-read its code on every target chain
      before sending.
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
- [ ] `PROTOCOL_INITIALIZER` balance covers the 13-transaction batch plus the registry's
      `initialize` at the day's fee, with 30% headroom. Gas used: 16,495,241 and 200,812 on the fork at
      `3041aa6`; re-measure if `contracts/src` changed since. On 2026-10-22 it held 34,654,906,438,668
      wei on Ethereum (finding 8), far short.
- [ ] `PROTOCOL_INITIALIZER` code on this chain is what was decided under finding 8 (run-all.sh step 0
      prints it).
- [ ] `FEE_TREASURY` decided: the real per-chain treasury address, non-zero, set once and never
      changed. The harness uses a placeholder (`0x…fEE1`) that is not the real treasury.
- [ ] Each feed proxy: code present, `description()` ends in `/ USD`, `decimals()` is 8, answer
      inside its band, aggregator pin recorded.

**Send**

- [ ] `DeployChainlinkOracle.s.sol` with the committed config (any key; the oracle has no admin).
      Read `feedOf(asset)` back and compare with the config (finding 1).
- [ ] `Deploy.s.sol` with `BLESSED_ORACLES=<that oracle>` and `FEE_TREASURY=<the treasury>`, signed as
      `PROTOCOL_INITIALIZER`. Expect 13 transactions (seven creates, then the six one-shot calls
      listed under Gas), all under 16,777,216, and the script's post-broadcast read-back to pass. The
      largest gas limit was 7,314,100 at `3041aa6` (`AgentVaultDeployer`).
- [ ] `node scripts/protocol-initialize-preflight.mjs --plan <plan>` with two real endpoints: `preflight ok`.
- [ ] `R=<rpc> ORA=<oracle> FEE_TREASURY=<the treasury> FROM_BLOCK=<deploy block> docs/audits/2026-10-21-deploy-dry-run/readback.sh`
      on each endpoint, with the `feedOf` expectations edited to the frozen config: 0 fail. It reads
      the seven addresses from the manifest and the agent registry from its record, checks every
      wired value and `FeeEngine.treasury()`, and replays all seven one-shot calls as reverts. Its
      registry `initialize` replay sends placeholder arguments, which is enough: the registry checks
      the one-shot flag before any argument.

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
# the same against a fork of Ethereum mainnet (optionally pin FORK_BLOCK=<n>)
FORK_URL=https://ethereum-rpc.publicnode.com SAFE_ARTIFACTS=... docs/audits/2026-10-21-deploy-dry-run/run-all.sh
```

The harness exports `FEE_TREASURY` to `Deploy.s.sol` (default: the placeholder `0x…fEE1`, override
with your own). `readback.sh` and `safe-2of3.mjs` read the singleton addresses from
`contracts/config/create2-manifest.json`. Without `FORK_URL` the chain is a fresh anvil with
stand-ins, as in the first two runs. With it, anvil forks mainnet, nothing is etched at the feed and
token addresses, any code at the four public anvil test accounts is cleared (on 2026-10-22 all four
carried the same EIP-7702 delegation on mainnet, to `0x8a67…408a`), and every log query starts at the fork block, so no log range is asked of
the public endpoint.

`SAFE_ARTIFACTS` comes from `npm i @safe-global/safe-contracts@1.4.1-build.0`; without it step 8 is
skipped and says so. `SOLC=<path>` passes a local solc to forge with `--offline`. Every key in the
harness is a public anvil test key, and every address it sends to is on `127.0.0.1`; in fork mode
anvil also reads state from `FORK_URL`.
