# Base Sepolia Testnet Checklist

Companion to the [Deployment Runbook](DEPLOYMENT.md). This is the operational, zero-code-edit
path: fund a key, run **one command to deploy** and **one command to smoke-test** the full
lifecycle. Everything chain-specific lives in the committed
[`contracts/config/base-sepolia.json`](../contracts/config/base-sepolia.json). Once the addresses
exist, [RUNTIME.md](RUNTIME.md) takes over: point the indexer and API at them and the stack is live.

> ⛔ **Do not start yet (v0.1.0-rc1).** `VaultFactory` exceeds the EIP-170 runtime size cap
> (27,241 / 24,576 bytes), so the deploy command in §3 reverts before any vault exists — you would
> burn faucet funds for nothing. See
> [issue #10](https://github.com/SlumperSan/agent-governed-vaults/issues/10); everything else in
> this checklist is verified and stays valid once the factory fits.

## 1. What you need

| Item | Amount | Where |
| --- | --- | --- |
| Base Sepolia ETH (gas) | ≥ 0.05 ETH | [Coinbase Developer Platform faucet](https://portal.cdp.coinbase.com/products/faucet) or [Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia) |
| Base Sepolia USDC | ≥ 10 USDC | [Circle faucet](https://faucet.circle.com) → network “Base Sepolia”. Canonical token: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Foundry v1.7.1 | — | `foundryup -v v1.7.1` |
| Node ≥ 20 | — | for the smoke runner (zero npm dependencies) |
| Basescan API key | optional | for `--verify`; [basescan.org/myapikey](https://basescan.org/myapikey) (Etherscan v2 keys work) |

**Key handling.** Import your deployer key into Foundry's encrypted keystore once:

```bash
cast wallet import deployer --interactive
```

You type the key into `cast` directly; nothing in this repo ever reads, stores, or logs it. All
commands below sign via `--account deployer`. To avoid repeated password prompts during the
multi-hour smoke run, put the keystore password in a file outside the repo (e.g.
`~/.secrets/deployer.pw`, `chmod 600`) and use `--password-file` as shown below. A Ledger works
too: replace the account flags with `--ledger` everywhere.

## 2. Environment

```bash
export BASE_SEPOLIA_RPC="https://base-sepolia-rpc.publicnode.com"   # or your own endpoint
export ETHERSCAN_API_KEY="<your key>"                               # only needed for --verify
export SMOKE_SIGNER_ARGS="--account deployer --password-file $HOME/.secrets/deployer.pw"
```

The official `https://sepolia.base.org` endpoint intermittently returns 503s; publicnode has
been reliable. Any Base Sepolia RPC works — the scripts assert `chainId == 84532` before
sending anything.

## 3. Deploy (one command)

```bash
cd contracts && forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url "$BASE_SEPOLIA_RPC" --account deployer --password-file "$HOME/.secrets/deployer.pw" --broadcast --verify
```

This deploys, in one broadcast:

1. the five protocol singletons (`OperatorRegistry`, `SubVaultRegistry`, `FeeEngine`,
   `Governance`, `VaultFactory`) with their **irreversible** one-shot wiring — identical to
   `Deploy.s.sol`;
2. three `ChainlinkSourceAdapter` instances per basket asset (WETH, LINK) over the verified
   Chainlink feeds below;
3. one `OracleAggregator` (3 sources per asset, 2-of-3 quorum, `maxStaleness = 1 day`);
4. one `AggregationRouterAdapter` pinned to Uniswap SwapRouter02 with only
   `exactInputSingle`/`exactInput` selectors allow-listed.

Addresses are printed at the end and recorded in
`contracts/broadcast/DeployTestnet.s.sol/84532/run-latest.json` (gitignored) — the smoke
runner reads them from there automatically. Drop `--verify` if you have no API key and verify
later (§5).

### Wired Base Sepolia addresses (all verified on-chain 2026-08-19)

| What | Address | Note |
| --- | --- | --- |
| USDC (settlement) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | canonical Circle testnet USDC, 6 decimals |
| WETH (basket) | `0x4200000000000000000000000000000000000006` | OP-stack predeploy, 18 decimals |
| LINK (basket) | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` | Chainlink's Base Sepolia LINK, 18 decimals |
| Chainlink ETH/USD | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | proxy, 8 decimals |
| Chainlink LINK/USD | `0xb113F5A928BCfF189C998ab20d753a47F9dE5A61` | proxy, 8 decimals |
| Uniswap SwapRouter02 | `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` | pinned router for the execution adapter |

> **Testnet oracle compromise (deliberate, documented).** The `OracleAggregator` constructor
> enforces ≥3 sources with a strict-majority quorum, but Base Sepolia has exactly **one**
> Chainlink feed per pair. The config therefore lists the same feed three times, deploying
> three distinct adapter instances over it (2-of-3 quorum). This exercises every code path but
> is **not** SF-1 mechanism diversity — a mainnet config must list ≥3 genuinely independent
> sources (Chainlink push + TWAP + pull-oracle class). Likewise `maxStaleness` sits at the
> 1-day ceiling because testnet feeds only heartbeat on deviation or ~24h; mainnet wants
> minutes (DEPLOYMENT.md §2).

## 4. Smoke test (one command)

```bash
node scripts/smoke-test.mjs
```

Drives the **full lifecycle** against the live deployment, with real wall-clock waits
(total ≈ 6–7 h — it sleeps between phases):

| Phase | Wait before it | What is asserted |
| --- | --- | --- |
| preflight | — | chain id, balances, re-wiring reverts (locks hold), `priceWad` sane through the real feeds |
| createVault | — | `VaultCreated`, vault attested in `OperatorRegistry` |
| registerVault | — | governance config accepted (quorum 25% floor, commit/reveal 1h/1h, timelock 0) |
| deposit | — | USDC escrowed as pending; `navWad() == 0` (pending excluded, EE-1) |
| activate | **4 h** observation window | shares minted at activation NAV; `navWad() > 0` |
| propose | — | no-op rebalance proposal (adapter + zero orders), `actionHash` pins the payload |
| commit | — | commit accepted (salt persisted *before* the tx — a reveal can never be stranded) |
| reveal | **1 h** commit phase | reveal matches commitment |
| finalize | **1 h** reveal phase | proposal **Passed** (signer regime: 1-of-1 revealed) |
| execute | — | `hasPendingExecution` true→false, `RebalanceExecuted` emitted by the vault |
| exit | — | Mode-I instant exit, all shares burned, **exact** USDC round trip (sole-holder fee waiver) |

Progress persists to `scripts/.smoke-state.json` (gitignored): **Ctrl+C and re-run any time**
— it resumes at the pending phase, and if a resumed run finds the execution window lapsed it
expires the proposal cleanly and re-runs the governance leg. `SMOKE_RESET=1` starts a fresh
lifecycle. If a keystore password prompt appears mid-run, it is `cast` asking — the runner
never touches the key.

A passing run ends with `SMOKE TEST PASSED` and the per-phase transaction hashes — that plus
the §5 verification closes the "post-deploy verification" gate in DEPLOYMENT.md §4 for
everything except the multi-member checks (breaker trip below quorum, Mode-F exit settlement
at post-execution NAV), which need a second agent and stay manual for now.

## 5. Basescan verification

With `ETHERSCAN_API_KEY` set, `--verify` in the deploy command verifies every contract during
broadcast. To verify later (or after a partial failure):

```bash
cd contracts && forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url "$BASE_SEPOLIA_RPC" --resume --verify
```

Manual fallback for a single contract (constructor args from the broadcast JSON):

```bash
forge verify-contract --chain 84532 <address> src/OracleAggregator.sol:OracleAggregator --watch
```

Then check on [sepolia.basescan.org](https://sepolia.basescan.org): each address shows a green
“Contract Source Code Verified” badge, and `VaultFactory → Read` resolves `registry`,
`governance`, `feeEngine`, `subVaultRegistry`.

## 6. Troubleshooting

- **RPC 503 / “no backend healthy”** — the default `sepolia.base.org` endpoint is flaky; use
  publicnode (§2) or a provider key. The smoke runner is resumable, so a mid-run RPC outage
  costs nothing: re-run the same command.
- **`StaleOracle` warning in preflight** — a testnet feed idled past 24 h. The breaker is
  working as designed (K-4). The no-op lifecycle never prices a non-zero basket balance, so
  the run continues; the warning is still worth noting in the run record.
- **`ChainIdMismatch` on deploy** — your `--rpc-url` points at the wrong chain. Nothing was
  sent.
- **Proposal expired during a long pause** — the runner auto-expires it (`markExpired`) and
  repeats propose→commit→reveal→finalize (~2 h). This is EE-10 behaving as specified.
- **`cast` not on PATH (Windows)** — `set PATH=%USERPROFILE%\.foundry\bin;%PATH%` or point the
  `CAST` env var at `cast.exe`.

## 7. After the smoke test

- Point `packages/indexer/src/chain.mjs` at the RPC + deployed factory/registry addresses
  (DEPLOYMENT.md §5) and replay from the deploy block.
- Keep `scripts/.smoke-state.json` (or its tx hashes) as the run record for the mainnet-gate
  paper trail (DEPLOYMENT.md §7).
- The remaining §4 runbook checks that need >1 member — oracle breaker trip below quorum and a
  Mode-F exit settling at post-execution NAV — require a second funded key against the same
  deployment.
