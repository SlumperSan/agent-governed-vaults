# Mainnet Deploy Runbook — measured gas, and the exact commands

**What this is.** A *measured* answer to "can I start the vault with only $10 in ETH?", plus a
numbered, copy-pasteable Windows PowerShell runbook for the Base mainnet bring-up.

**What this is not.** Nothing here was broadcast. Every number below comes from **fork simulation
against Base mainnet with no key, no funded account and no transaction** (`forge script --fork-url`
without `--broadcast`, and a fork-only `forge test` harness). No contract was deployed.

| | |
|---|---|
| tree measured | `origin/protocol/main` @ `4619f17a` (that commit touches nothing in `contracts/`, so the bytecode is identical to `0c196581`) |
| fork | Base mainnet, chainId 8453, block ~50,794,500–50,795,071 |
| foundry | v1.7.1, `via_ir = true`, `optimizer_runs = 800`, `evm_version = cancun` |
| `npm run gate` on this tree | **PASSED** (fmt, syntax, build, opscheck, backend, test, snapshot, sizes; slither advisory-only) |
| `verify-chainlink-oracle.mjs` | **26/26, exit 0**, keyless |

---

## 0. The answer

**Yes — $10 of ETH is enough, with a ~52x margin.**

Deploying the working stack costs **16,268,712 gas**. That is 8 contracts + 3 wiring calls + vault
#1, where vault #1 is created *through the Safe* and *with an execution adapter* — i.e. a vault that
can actually rebalance. See findings B and D for why both of those are load-bearing rather than
optional.

At the Base base fee observed across 4,104 blocks sampled over 28 days — which sat on the
**0.005 gwei floor at p50 and p90**, with a p99 of 0.0116 gwei and a 28-day sampled maximum of
0.0132 gwei:

| scenario | gas price | L2 cost | + L1 data fee | **total** |
|---|---|---|---|---|
| quiet (observed p50/p90, the floor) | 0.005 gwei | 0.00008134 ETH | 0.00000057 ETH | **0.0000819 ETH ≈ $0.20** |
| busy (observed p99 over 28 days) | 0.0116 gwei | 0.00018872 ETH | 0.00000057 ETH | **0.0001893 ETH ≈ $0.45** |
| stress, 10x the floor | 0.05 gwei | 0.00081344 ETH | 0.00000057 ETH | **0.0008140 ETH ≈ $1.94** |
| stress, 100x the floor | 0.50 gwei | 0.00813436 ETH | 0.00000057 ETH | **0.0081349 ETH ≈ $19.42** |

**$10 runs out at a gas price of 0.2575 gwei — about 52x the observed floor and 22x the 28-day
sampled p99.** Base has not been near that in the sampled window.

### Fund two accounts, not one

The deployer EOA and the Safe pay different parts of this. They are different addresses and both
need ETH before you start.

| account | pays for | gas | at floor | at 100x floor |
|---|---|---:|---:|---:|
| **deployer EOA** | steps 5–6: oracle, adapter, 6 singletons, 3 wiring calls | 11,649,746 | $0.14 | $13.90 |
| **the Safe** `0xC73B…AD4c` | step 7: `createVault` via `execTransaction` | 4,618,966 | $0.06 | $5.51 |

Fund the **deployer EOA with 0.01 ETH (~$24)** and make sure the **Safe holds at least 0.005 ETH
(~$12)**. Two reasons for the headroom, neither of them the gas estimate being wrong: `forge script`
submits each transaction with a **1.3x gas limit buffer** (you are only *charged* gas used, but the
account must *hold* limit x price at send time), and it costs nothing to have slack on a one-shot
irreversible deploy.

> **Stated limitation.** The 28-day sample is 8 half-hour windows, not continuous coverage. It will
> miss a short congestion spike. That is why the stress rows are there and why the break-even
> figure — 0.2575 gwei — is given: check `cast gas-price --rpc-url https://mainnet.base.org` on the
> day and compare it against that number, rather than trusting this table's date.

**$10 in ETH is gas only.** The vault's deposit asset is USDC. Separately from gas you need the
USDC seed — and specifically the H-8 operational mitigation the four-values decision commits to:
**hold >50% of vault #1's stake until it has at least 5 members.** `CREATOR_MIN_STAKE_BPS` is
`500` = 5% (`VaultCore.sol:53`), so that majority is *not* automatic; it is a thing the owner must
actually do. That is USDC, in a different asset, and it is not covered by any number on this page.

### Redo the arithmetic at a different price

```
total_gas          = 16,268,712                      (measured, table in §1)
L1_data_fee_eth    = 0.00000057                      (measured, Base GasPriceOracle upper bound)

cost_eth  = total_gas x gas_price_gwei x 1e-9 + L1_data_fee_eth
cost_usd  = cost_eth x eth_price_usd

break_even_gwei = ((budget_usd / eth_price_usd) - L1_data_fee_eth) / total_gas x 1e9
```

Prices used above, both read on-chain at measurement time:
- **ETH = $2,387.12** — Chainlink ETH/USD feed `0x50015f8b17fb2C290Dde41fDc246ed0dcEE93a8b`,
  raw answer `238711773585` at 8 decimals.
- **gas price** — `eth_feeHistory` over the block windows described above.

---

## 1. Measured gas, per step

L2 execution gas. The rows marked *(artifact)* are read from the `forge script` dry-run artifact
(`contracts/broadcast/<script>/8453/dry-run/run-latest.json`), run with
`--gas-estimate-multiplier 100` so the figure is the raw simulated cost rather than forge's 1.3x
submission buffer. The rows marked *(harness)* have **no script** — see finding A — and were
measured with the fork harness in §6.

| # | step | paid by | L2 gas | L1 data fee (wei) |
|---|---|---|---:|---:|
| 1 | `ChainlinkOracle` CREATE *(artifact)* | EOA | 587,912 | 45,026,981,461 |
| 2 | `AggregationRouterAdapter` CREATE *(harness)* | EOA | 556,094 | 33,504,051,177 |
| 3 | `OperatorRegistry` CREATE *(artifact)* | EOA | 532,777 | 22,470,104,463 |
| 4 | `SubVaultRegistry` CREATE *(artifact)* | EOA | 400,053 | 16,451,041,430 |
| 5 | `FeeEngine` CREATE *(artifact)* | EOA | 703,804 | 30,563,698,930 |
| 6 | `Governance` CREATE *(artifact)* | EOA | 2,679,326 | 119,622,456,818 |
| 7 | `VaultDeployer` CREATE *(artifact)* | EOA | 5,159,604 | 240,386,610,901 |
| 8 | `VaultFactory` CREATE *(artifact)* | EOA | 858,280 | 46,171,758,688 |
| 9 | `registry.wire(factory, feeEngine)` *(artifact)* | EOA | 77,708 | 1,200,680,330 |
| 10 | `subReg.wire(factory)` *(artifact)* | EOA | 46,830 | 1,200,680,330 |
| 11 | `governance.wireSubVaultRegistry(subReg)` *(artifact)* | EOA | 47,358 | 1,200,680,330 |
| 12 | **vault #1** — `createVault` via Safe `execTransaction` *(harness)* | Safe | 4,618,966 | 13,025,014,911 |
| | **TOTAL** | | **16,268,712** | **570,823,759,769** (0.00000057 ETH) |

Three steps are two thirds of the bill and all three are structural, not accidental:

- **`VaultDeployer` — 5,159,604 gas (32%).** Its *initcode* is 23,808 bytes because it carries
  `type(VaultCore).creationCode` and, in its constructor, writes that blob out as two SSTORE2-style
  data contracts. You are paying ~22 KB of code-deposit plus 23.8 KB of calldata. This is the price
  of the EIP-170 workaround, and it is paid once.
- **`createVault` — 4,618,966 gas (28%).** It CREATEs a full `VaultCore` (20,650 bytes of runtime
  code deposited at 200 gas/byte ≈ 4.13M gas on its own). **Every additional vault costs this
  again** — relevant because the ratified plan is horizontal growth (vault #2, #3, #N), not a
  bigger vault #1.
- **`Governance` — 2,679,326 gas (16%).**

### Two variants of the total, so the labelling is unambiguous

| variant | what it is | gas |
|---|---|---:|
| **full (headline)** | with the execution adapter, `createVault` sent through the Safe | **16,268,712** |
| minimal | no adapter, `createVault` sent directly by an EOA | 15,644,670 |

The minimal figure is what you get by following `Deploy.s.sol` literally and passing an empty
`allowedAdapters`. **It is the cost of a vault that can never rebalance, created by the wrong
address.** It is recorded only so the difference is visible; do not quote it.

The three components of the 624,042-gas difference, all measured:

| | gas |
|---|---:|
| `AggregationRouterAdapter` deployment (finding D) | 556,094 |
| one extra `allowedAdapters` entry inside `createVault` | 23,016 |
| Safe `execTransaction` overhead over a direct call (finding B) | 44,932 |

### Why the harness figures are trustworthy

`createVault` and the adapter are not in any dry-run artifact, so they were modelled as
`gasleft() delta + 21,000 intrinsic + EIP-2028 calldata cost`. The same harness reproduces two
figures that *are* in the artifacts, as a control:

| control | harness model | script artifact | error |
|---|---:|---:|---:|
| `OperatorRegistry` CREATE | 533,342 | 532,777 | +0.11% |
| `ChainlinkOracle` CREATE | 589,923 | 587,912 | +0.34% |

Both overshoot slightly (the harness's `new` pays memory expansion a top-level creation
transaction does not), so the totals here are **conservative**. Treat the harness rows as accurate
to about ±0.5%.

The Safe row is a genuine `execTransaction` against the **real Safe at
`0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c` on the fork** — Safe v1.4.1, threshold 1, single owner
`0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35`, all read on-chain. The harness signs with Safe's
pre-validated-signature form (`v = 1`, `r = owner`) under `vm.prank(owner)`, which is what a 1-of-1
Safe accepts. **If the Safe's threshold or owner set changes before launch, re-measure** — each
additional required signature adds ECDSA verification to that 4,618,966.

### L1 data fee

Base is an OP Stack chain: every transaction pays L2 execution **plus** an L1 data-availability fee
that scales with calldata. Deployments are almost entirely calldata, so this had to be checked
rather than assumed. It was read per transaction from the `GasPriceOracle` predeploy
`0x420000000000000000000000000000000000000F` via `getL1FeeUpperBound(uint256)` — an **upper bound**
(worst-case compression), so it overstates.

It totals **0.00000057 ETH ≈ $0.0014** across all twelve transactions. It does not move the verdict
and it does not move the second decimal place of the dollar figure. Recorded because a silent
omission would be wrong even when it is small.

---

## 2. `forge build --sizes` — EIP-170

Nothing is over the 24,576-byte runtime cap. The full table is long; here is every contract that is
deployed at launch, plus the largest non-launch contract for context.

| contract | runtime B | margin to EIP-170 | init B | margin to EIP-3860 |
|---|---:|---:|---:|---:|
| **VaultCore** | **20,650** | **3,926** | 22,391 | 26,761 |
| Governance | 12,155 | 12,421 | 12,201 | 36,951 |
| VaultFactory | 3,572 | 21,004 | 4,258 | 44,894 |
| FeeEngine | 2,902 | 21,674 | 3,061 | 46,091 |
| OperatorRegistry | 2,219 | 22,357 | 2,265 | 46,887 |
| AggregationRouterAdapter | 1,981 | 22,595 | 2,372 | 46,780 |
| SubVaultRegistry | 1,605 | 22,971 | 1,650 | 47,502 |
| ChainlinkOracle | 1,532 | 23,044 | 3,868 | 45,284 |
| **VaultDeployer** | 938 | 23,638 | **23,808** | **25,344** |
| *UniswapV3TwapSource* — **deferred, not deployed at launch** (retired custom-oracle stack, finding F) | *5,169* | *19,407* | *7,564* | *41,588* |

**Flagged:**

- **`VaultCore` at 20,650 B has 3,926 B (16%) of headroom.** It is the only contract anywhere near
  the cap and it is the one that grows — it holds the deposit, exit, NAV and rebalance logic. This
  is not currently blocking, but it is the constraint that produced `VaultDeployer` in the first
  place, and any future feature landing in `VaultCore` should be sized against 3,926 B before it is
  designed, not after it is written.
- **`VaultDeployer`'s initcode is 23,808 B against EIP-3860's 49,152 B limit** — 48% consumed,
  25,344 B spare. This number is *derived from* `VaultCore`'s creation code, so **it grows with
  `VaultCore` at roughly 1:1**. `VaultCore` gaining ~3.9 KB would hit EIP-170 first, so EIP-3860 is
  not the binding constraint today — but it is the second wall behind it, and the two-chunk split
  in `VaultDeployer` already exists because the first wall was hit once.
- Nothing else is within 19 KB of a limit.

---

## 3. Findings — read before deploying anything

### A. `Deploy.s.sol` does not create vault #1. There is no script that does.

`Deploy.s.sol` deploys the six singletons and performs the three wiring calls. It stops there. No
file in `contracts/script/` calls `createVault` on mainnet, and none deploys an execution adapter.
The single most important transaction of the launch — the one that writes six irreversible values —
has **no reviewed, tested, committed script behind it**. §5 step 7 supplies a hand-built `cast`
command instead; it is verified against the compiled ABI (selector `0x49af0336`) but it is not the
same thing as a script the gate runs.

### B. The operator payout address is `msg.sender` of `createVault`. There is no payout parameter.

This is the finding most likely to cause an irreversible mistake, because the decision note calls it
"the operator payout address" and there is no field by that name anywhere.

`VaultFactory.createVault` calls `registry.attestVault(vault, msg.sender)`, and `attestVault`
auto-registers `msg.sender` as the operator identity. `FeeEngine` credits fees to
`operatorAddressOf(opId)`. `VaultCore.creator` — the 5% stake lock and gate identity — is also
`msg.sender`. And `OperatorRegistry.registerOperator` explicitly **cannot rebind**
(*"can never rebind an existing operator (CM-4)"*), with no setter anywhere.

**Therefore vault #1 must be created by a transaction sent *from the Safe*
`0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c`.** A `forge script` run from a deployer EOA would
silently make **that EOA** the permanent payout identity and the permanent creator. There is no fix
except deploying vault #2.

The Safe was inspected on-chain and is real: **Safe v1.4.1, threshold 1, single owner
`0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35`.** Routing `createVault` through
`execTransaction` costs **44,932 gas** more than a direct call — measured, not assumed (§1).

### C. `contracts/config/base-mainnet.json` contains no vault-#1 launch-parameter block at all.

The four decided values are not in the config in any form. The only place any of them appears is the
`smoke` block — a smoke-test template, which the decision note itself flags as not authoritative
(*"the competing 3.5-day figure ... lived in the `smoke` block and was never what the 50 bps vault
ran"*).

| parameter | decision | `smoke` block | verdict |
|---|---|---|---|
| operator payout | `0xC73B…AD4c` | **absent** | not in the repo anywhere (grep of `contracts/`, `docs/`, `scripts/`, `apps/` returns nothing) |
| `minDepositUsdc` | `10000` (0.01 USDC) | `100000000` (100 USDC) | **differs 10,000x** |
| `capacityCapUsdc` | `50000000000` (50,000) | `1000000000` (1,000) | **differs 50x** |
| `exitFeeDecayPeriod` | `604800` | `604800` | matches |
| `allowSubVaults` | `false` | — | `Deploy.s.sol:79` passes `false`; **matches** |
| basket | `[WETH, cbBTC]` | — | `chainlinkOracle.assets` = WETH + cbBTC; **matches** |

The `minDeposit` and `capacityCap` differences are **not** the config being wrong. `smoke` is a
different artifact for a different purpose, and the low `minDepositUsdc` is a ratified, documented
trade of H-8's config mitigation for a low access barrier. The finding is the *absence*: **there is
no committed, reviewable place where vault #1's launch parameters live.** They exist only in an
Obsidian note and, after §5 step 7, only on-chain. Whoever types the `cast` command is the only
check. Given every one of them is `immutable`, that is a thin margin — consider recording them in
`contracts/config/base-mainnet.json` under a `vault1` key **before** deploying, so the numbers being
typed can be diffed and reviewed rather than transcribed.

> The decided values were fork-tested and **all are constructor-accepted**: the harness in §6 creates
> vault #1 with exactly `10000` / `50000000000` / `604800` / `50 bps` / `[WETH, cbBTC]` against the
> real blessed `ChainlinkOracle` on a Base mainnet fork, through the real Safe, and reads every one
> of them back correctly. `_requireOracleCoversBasket` passes and both assets price. Nothing reverts.

### D. `allowedAdapters` is a fifth immutable value that no decision covers, and an empty set is permanent.

`VaultCore.isAllowedAdapter` is written **only** in the constructor (`VaultCore.sol:248`). There is
no setter. `executeRebalance` requires `isAllowedAdapter[adapter]` (`VaultCore.sol:889`).

So if vault #1 is created with an empty `allowedAdapters` array — which is what the four-values
decision implies, since it names no adapter — **the vault can never rebalance. Ever.** It could
accept deposits and process exits, but the agent could never execute a swap, which is the product.

**The execution adapter must therefore be deployed BEFORE `createVault` and passed in that array.**
It is included in §1's headline total: `AggregationRouterAdapter` over the configured router
(`config.router` = Uniswap SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`, with
`config.routerAllowedSignatures`) costs **556,094 gas**, and carrying one entry through
`createVault` costs a further **23,016**. Both measured.

**This still needs an owner decision before step 7** — which adapter, over which router, with which
selectors — and it is as irreversible as the other five.

### E. `exitFeeMaxBps` is a sixth immutable the decision does not state.

The decision names four values; the constructor takes six that matter. `exitFeeMaxBps` is not among
the four. `50` was used here, from `base-mainnet.json`'s `smoke` block and consistent with the
decision's own reference to *"the 50 bps vault"* — but it is inferred, not decided. Confirm it
explicitly before step 7.

### F. Resolved: nothing live points at cbETH.

The basket decision left this owed. Checked: every `cbETH` reference in `base-mainnet.json` sits in
the **deferred** custom-aggregator sections (`assets`, `twapDefaults`, their notes), which the file's
own `blockingNote` marks NOT-DEPLOYABLE and which the C-6 factory allowlist makes non-selectable.
The live `chainlinkOracle` block lists **WETH and cbBTC only**, and its `notListed.cbETH` key records
why cbETH is excluded. `verify-chainlink-oracle.mjs` passes 26/26 over exactly that pair.

### G. Count discrepancy, reported not reconciled.

`verify-chainlink-oracle.mjs` reports **26/26 checks passed, exit 0** on this tree, observed
directly. `base-mainnet.json`'s `chainlinkOracleNote` and the basket decision both say **12/12**.
The verifier has evidently grown checks since those were written. Not a defect; the notes are stale.

---

## 4. The rule that governs every check in §5

**Every parameter verified in step 8 is `immutable`, set once at construction. There is no
fix-forward. There is no setter. There is no governance path.**

`RuleChange` — the only proposal type that alters vault settings — decodes to `GovConfig`, whose
eight fields are all governance timing and quorum. The cap, the minimum deposit, the decay period,
the creator, the operator identity and the adapter set are **not among them**. Unanimous consent of
every member cannot change any of them.

**If any check in step 8 fails, the answer is redeploy — a new vault, from step 7, with a new
address.** The wrong vault is simply abandoned; it cannot be repaired, and nothing in it can be
migrated by the protocol. This is repeated at each step below because it is the only remedy.

---

## 5. The runbook (Windows PowerShell)

> PowerShell notes: no bash `&&`, no inline `VAR=x cmd`. Set variables with `$env:NAME = "value"`,
> chain with `;`, and gate on success with `if ($?) { ... }` or `$LASTEXITCODE`.

**Key handling.** These commands deliberately do **not** put a private key in an environment
variable. Use a hardware wallet (`--ledger`) or a Foundry keystore account (`--account <name>`,
which prompts for the password interactively). Never paste a key into a shell, a file or this repo.

### Preflight (read-only, no key, nothing broadcast)

**1. Verify the Chainlink feeds on-chain.** Immutable oracle — a wrong feed prices every vault
wrong forever.

```powershell
cd C:\Users\Micha\desktop\x402
node scripts\verify-chainlink-oracle.mjs
```

Expect `26/26 checks passed` and exit code 0. Confirm with `$LASTEXITCODE`.
**If it fails: stop. Do not deploy.** Fix the config or the feed addresses first.

**2. Confirm nothing is over EIP-170.**

```powershell
cd C:\Users\Micha\desktop\x402\contracts
forge build --sizes
```

Expect no contract over 24,576 B runtime. `VaultCore` should read ~20,650 B (§2).
**If `VaultCore` exceeds the cap: stop.** `createVault` would revert on-chain and you would pay
~4.6M gas to find out.

**3. Run the full gate.**

```powershell
cd C:\Users\Micha\desktop\x402
npm run gate
```

Expect `GATE PASSED` (slither is advisory and does not fail it). **If it fails: stop.**

**4. Check the day's gas price, and both balances.**

```powershell
cast gas-price --rpc-url https://mainnet.base.org
cast balance <YOUR_DEPLOYER_ADDRESS> --rpc-url https://mainnet.base.org
cast balance 0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c --rpc-url https://mainnet.base.org
```

Divide the gas price by 1e9 for gwei and compare against **0.2575 gwei** (§0). Anything below that
and $10 covers the whole deploy. If it is above, wait — nothing here is time-critical.

The EOA needs ~0.01 ETH and **the Safe needs ETH of its own** (~0.005 ETH) because it sends step 7.
A Safe with a zero balance is the most likely way to get halfway through this runbook and stall.

### Deploy

**5. Deploy the blessed `ChainlinkOracle` first.** The factory's allowlist requires its address, and
`VaultFactory`'s constructor rejects a codeless entry — so this must be a *real* deployment before
step 6, not a placeholder.

```powershell
cd C:\Users\Micha\desktop\x402\contracts

$env:ORACLE_ASSETS    = "0x4200000000000000000000000000000000000006,0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"
$env:ORACLE_FEEDS     = "0x50015f8b17fb2C290Dde41fDc246ed0dcEE93a8b,0x32F587986D3fb47601157c19615d568BeD0BCabc"
$env:ORACLE_HEARTBEATS= "3600,3600"
$env:ORACLE_MIN_WAD   = "100000000000000000000,1000000000000000000000"
$env:ORACLE_MAX_WAD   = "100000000000000000000000,1000000000000000000000000"
$env:ORACLE_USDC      = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
$env:ORACLE_SEQUENCER = "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433"

# Dry run FIRST — no --broadcast, no key. Confirm it simulates clean.
forge script script/DeployChainlinkOracle.s.sol:DeployChainlinkOracle `
  --fork-url https://mainnet.base.org

# Then broadcast.
forge script script/DeployChainlinkOracle.s.sol:DeployChainlinkOracle `
  --rpc-url https://mainnet.base.org `
  --ledger --sender <YOUR_DEPLOYER_ADDRESS> `
  --broadcast
```

Every one of those seven values is copied by hand from `contracts/config/base-mainnet.json`'s
`chainlinkOracle` block and **nothing machine-checks that the env matches the JSON.** Diff them
yourself before broadcasting.

Record the deployed address. **The oracle is immutable — a wrong heartbeat, band or feed means
deploying a new oracle and a new vault.**

**6. Deploy the execution adapter (finding D), then the singletons.**

There is no script for the adapter. Deploy it with `forge create`, using the router and selectors
already in `contracts/config/base-mainnet.json`:

```powershell
# Confirm the two selectors first (read-only):
cast sig "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"
cast sig "exactInput((bytes,address,uint256,uint256))"

forge create src/AggregationRouterAdapter.sol:AggregationRouterAdapter `
  --rpc-url https://mainnet.base.org `
  --ledger --from <YOUR_DEPLOYER_ADDRESS> `
  --broadcast `
  --constructor-args 0x2626664c2603336E57B271c5C0b26F421741e481 "[<SELECTOR_1>,<SELECTOR_2>]"
```

**Skip this only with an explicit owner decision that vault #1 will never rebalance** — the adapter
set is fixed at `createVault` and can never be added to.

Then the singletons and the wiring, in one script:

```powershell
$env:BLESSED_ORACLES = "<ORACLE_ADDRESS_FROM_STEP_5>"

# Dry run first.
forge script script/Deploy.s.sol:Deploy --fork-url https://mainnet.base.org

# Then broadcast.
forge script script/Deploy.s.sol:Deploy `
  --rpc-url https://mainnet.base.org `
  --ledger --sender <YOUR_DEPLOYER_ADDRESS> `
  --broadcast
```

`Deploy.s.sol` **reverts on Base mainnet if `BLESSED_ORACLES` is empty** — that guard is deliberate
(an empty allowlist ships the C-6 oracle gate disabled). Record all six addresses it logs.

**If the wiring calls fail or are wired to the wrong address: redeploy the whole singleton set.**
`registry.wire`, `subReg.wire` and `gov.wireSubVaultRegistry` are one-shot with no admin able to
re-point them. That is the property that makes the trust anchor credible, and it is also why there
is no repair.

**7. Create vault #1 — FROM THE SAFE, not from the deployer EOA.** See finding B. The sender of
this transaction becomes the permanent operator payout identity and the permanent vault creator.

Confirm `exitFeeMaxBps` (finding E) before you start; the command below uses `50`.

Build the calldata locally (read-only):

```powershell
cd C:\Users\Micha\desktop\x402\contracts
cast calldata "createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))" `
  "(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,[0x4200000000000000000000000000000000000006,0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf],<ORACLE_ADDRESS>,50000000000,10000,50,604800,[<ADAPTER_ADDRESS>])"
```

The output must begin `0x49af0336` — the `createVault` selector from the compiled ABI. The tuple is,
in order: `usdc`, `basketAssets`, `oracle`, `capacityCapUsdc` (**50000000000** = 50,000 USDC),
`minDepositUsdc` (**10000** = 0.01 USDC), `exitFeeMaxBps` (**50**), `exitFeeDecayPeriod`
(**604800** = 7 days), `allowedAdapters`.

Then submit that calldata **from the Safe** `0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c` as a
transaction to the `VaultFactory` address from step 6, value 0. Use the Safe's own interface
(Transaction Builder → custom transaction → paste the calldata). Measured cost of that
`execTransaction`, against this Safe at its current 1-of-1 configuration: **4,618,966 gas**
(§1) — set the Safe's gas limit above that, with the usual headroom.

**Read the four numbers in the calldata out loud against §3's table before signing.** After this
transaction they cannot be changed by anyone, including unanimous consent of every member.

### Post-deploy verification — by calling the deployed contracts, not by trusting the script

Do not skip these because the script printed success. The script reports what it *intended*.

**8. Verify, in this order.**

```powershell
$FACTORY = "<VAULT_FACTORY_ADDRESS>"
$VAULT   = "<VAULT_1_ADDRESS>"
$REGISTRY= "<OPERATOR_REGISTRY_ADDRESS>"
$ADAPTER = "<ADAPTER_ADDRESS>"
$RPC     = "https://mainnet.base.org"

cast call $FACTORY "allowSubVaults()(bool)"          --rpc-url $RPC   # MUST be: false
cast call $VAULT   "minDepositUsdc()(uint256)"       --rpc-url $RPC   # MUST be: 10000
cast call $VAULT   "capacityCapUsdc()(uint256)"      --rpc-url $RPC   # MUST be: 50000000000
cast call $VAULT   "exitFeeDecayPeriod()(uint256)"   --rpc-url $RPC   # MUST be: 604800
cast call $VAULT   "exitFeeMaxBps()(uint256)"        --rpc-url $RPC   # MUST be: 50
cast call $VAULT   "creator()(address)"              --rpc-url $RPC   # MUST be: 0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c
cast call $VAULT   "parentVault()(address)"          --rpc-url $RPC   # MUST be: 0x0000...0000 (root vault)
cast call $VAULT   "isAllowedAdapter(address)(bool)" $ADAPTER --rpc-url $RPC   # MUST be: true
cast call $VAULT   "locked()(bool)"                  --rpc-url $RPC   # MUST return false, and MUST NOT revert
```

The operator payout address, as actually registered — two calls, because it is stored by id:

```powershell
$OPID = cast call $REGISTRY "operatorOf(address)(uint256)" $VAULT --rpc-url $RPC
cast call $REGISTRY "operatorAddressOf(uint256)(address)" $OPID --rpc-url $RPC
# MUST be: 0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c
```

And confirm the oracle actually prices the basket — a vault whose oracle cannot price an asset is a
brick:

```powershell
cast call <ORACLE_ADDRESS> "priceWad(address)(uint256)" 0x4200000000000000000000000000000000000006 --rpc-url $RPC
cast call <ORACLE_ADDRESS> "priceWad(address)(uint256)" 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf --rpc-url $RPC
# both MUST be > 0
```

**What to do if any of these fails:**

| check | if it is wrong | remedy |
|---|---|---|
| `allowSubVaults()` returns `true` | the factory was deployed with `allowSubVaults = true`; C-1 is live and sub-vault capture is reachable | **redeploy the factory and vault #1.** `allowSubVaults` is immutable on `VaultFactory`. A new factory means a new vault; the old vault stays attested to the old factory. |
| `minDepositUsdc()` ≠ `10000` | wrong access barrier, permanently | **redeploy vault #1.** No setter. |
| `capacityCapUsdc()` ≠ `50000000000` | wrong exposure bound, permanently | **redeploy vault #1.** Not in `GovConfig`; unanimous consent cannot change it. |
| `exitFeeDecayPeriod()` ≠ `604800` | wrong exit-fee decay, permanently | **redeploy vault #1.** |
| `exitFeeMaxBps()` ≠ the decided value | wrong exit fee, permanently | **redeploy vault #1.** |
| `creator()` / operator address ≠ the Safe | the payout and creator identity are on the wrong address, permanently — `OperatorRegistry` has no rebind | **redeploy vault #1, sending `createVault` from the Safe.** This is finding B. |
| `isAllowedAdapter()` is `false` | the vault can never rebalance — the adapter set is constructor-only | **redeploy vault #1** with the adapter in `allowedAdapters`. This is finding D. |
| `parentVault()` ≠ zero | not a root vault. Note this is **not an independent check**: `_deploy` passes `allowSubVaults ? subVaultRegistry : address(0)`, so with `allowSubVaults = false` every vault gets `address(0)` unconditionally. A non-zero value here means the factory was built with `allowSubVaults = true` | **redeploy the factory and vault #1** — same remedy as the `allowSubVaults` row. |
| `locked()` reverts or is absent | the deployed `VaultDeployer` carries a `VaultCore` from **before** the H-9 fix — i.e. the deployment is behind `main`. Singleton codesize comparison cannot detect this, because `VaultDeployer`'s own runtime is only 938 B and the real payload hides in `codeChunkA`/`codeChunkB` | **redeploy `VaultDeployer`, the factory and the vault** from a verified `main` build. |
| `priceWad()` is 0 or reverts | the oracle cannot price a basket asset; the vault is a brick | **redeploy the oracle and vault #1.** Both immutable. |

Redeploying at ~0.005 gwei costs cents (§0). Redeploying is always cheaper than living with a wrong
immutable. **There is no case in this table where the right answer is to work around it.**

**9. Record the launch step the decision commits to.** From `vault1-four-immutable-values.md`: H-8's
config mitigation was deliberately traded away, and its replacement is *operational* —
**seed vault #1 and hold >50% of stake until it has at least 5 members.** `CREATOR_MIN_STAKE_BPS` is
`500` = 5%, so this does not happen by itself. Below 5 members, `Governance.finalize` counts
*addresses with shares > 0*, not stake, and ~4 dust seats cost about $0.04 at
`minDepositUsdc = 10000`. A >50% stake holder cannot be locked out (the stake term is additive in
both sub-five branches) — **but only if someone actually holds >50%.** This is a task, not an
assumption.

---

## 6. Reproducing the measurement

The harness is fork-only: no key, no broadcast, no transaction. It is **not committed** — it fails a
plain `forge test` because it needs `--fork-url`, and it is a measurement tool, not a protocol test.
Save it as `contracts/test/fork/DeployGasFork.t.sol` and run:

```powershell
cd C:\Users\Micha\desktop\x402\contracts
forge test --match-path "test/fork/DeployGasFork.t.sol" --fork-url https://mainnet.base.org -vv
```

It deploys the whole stack on a Base mainnet fork, deploys the adapter, creates vault #1 through the
**real Safe** via `execTransaction`, prints per-step gas, and asserts every §5 step-8 check. The two
control lines reproduce figures from the `forge script` dry-run artifacts so the modelling can be
trusted.

The singleton figures come from the dry-run artifacts directly:

```powershell
cd C:\Users\Micha\desktop\x402\contracts
$env:BLESSED_ORACLES = "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433"   # any codeful address; gas is identical
forge script script/Deploy.s.sol:Deploy --fork-url https://mainnet.base.org --gas-estimate-multiplier 100
# then read broadcast\Deploy.s.sol\8453\dry-run\run-latest.json -- one `gas` field per transaction
```

`--gas-estimate-multiplier 100` matters: forge's default is 130, so without it every figure is
inflated exactly 1.3x (764,285 vs 587,912 for the oracle, for example).
