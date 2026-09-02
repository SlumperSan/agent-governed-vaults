# Verify your own vault

**Member self-service reference — not advice.** Every number the app or a status post shows you can
be read from the chain by you, with no account, no key and no permission from anyone. This page is
the list of those reads, plus the direct-to-contract recipes for the three things a member can do
without the website: deposit, request an exit, and reclaim a pending deposit. Nothing here is an
offer, a solicitation, or financial advice. Whether to deposit, hold or exit is your decision as a
governor; this page only tells you how to read the state and how to act on it yourself.

**Deployment status, stated first.** There is no mainnet deployment. Launch is NO-GO
([LAUNCH-READINESS.md](LAUNCH-READINESS.md)). The addresses below are the **Base Sepolia testnet**
deployment recorded in [`contracts/config/deployments/base-sepolia.json`](../contracts/config/deployments/base-sepolia.json),
and that deployment runs bytecode that is **superseded** by the current source (its own
`sourceCommit` is `5934ef22`; `VaultCore`, `VaultFactory` and `ChainlinkOracle` have changed since).
Testnet USDC has no value. When a mainnet deployment exists its addresses will be published in the
same directory, and §6 shows the placeholder shape.

**What nobody can do for you.** The contracts are immutable: no admin key, no pause, no upgrade,
no undo ([INCIDENTS.md §0](INCIDENTS.md)). If a read below shows a freeze, nobody — including the
project — can unfreeze it, override a price, or move your funds. That is the design, and it is the
same design that stops anyone else moving them either.

Every command on this page was run against the vault that passed launch gate 2, and every output
shown is what came back: the original set on 2026-09-01 at 22:28 UTC, Base Sepolia block 46266737,
and the `claimable` read added later to §5-B at block 46269600. Your outputs will differ, and so
will these — they are live state, and §4 shows what happens when it moves.

---

## 0. What you need

1. **`cast`**, from Foundry. Install: <https://getfoundry.sh>. One binary; nothing else.
2. **No key** for anything in §1–§4. Reads are free and anonymous.
3. **Your own signer** for §5 only — a Foundry keystore (`cast wallet import`), a Ledger or a
   Trezor. Never paste a private key into a terminal command on a machine you share, and note that
   **nobody from this project will ever ask you for a key, a seed phrase, or a signature to "verify"
   anything.** Verification is reading, and reading needs no key.

## 1. Set these once

Pick your shell, paste the block, then every command below pastes unchanged. Only `YOU` is yours;
`VAULT` is the vault you are a member of (the address on the vault's page, or from the `VaultCreated`
event you deposited into). The value shown is the gate-2 smoke vault, so you can test the page as-is.

PowerShell:

```powershell
$RPC    = "https://sepolia.base.org"
$VAULT  = "0x4d60e49d451117b9ab8f9fb9be56454ab7f01a0f"
$YOU    = "0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35"
$ORACLE = "0x6371E14C0682882e75E8382caf0216545B1f43C6"
$GOV    = "0xcd9B2E37D14c57362f005355757bfa6Db450C206"
$USDC   = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
$WETH   = "0x4200000000000000000000000000000000000006"
$LINK   = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410"
```

bash / zsh:

```bash
RPC=https://sepolia.base.org
VAULT=0x4d60e49d451117b9ab8f9fb9be56454ab7f01a0f
YOU=0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35
ORACLE=0x6371E14C0682882e75E8382caf0216545B1f43C6
GOV=0xcd9B2E37D14c57362f005355757bfa6Db450C206
USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
WETH=0x4200000000000000000000000000000000000006
LINK=0xE4aB69C077896252FAFBD49EFD26B5D171A32410
```

Do not trust this page for the addresses either. Check that the vault really points at that
oracle, that governance module and that USDC — the vault's answer is the one that counts:

```bash
cast call $VAULT "oracle()(address)" --rpc-url $RPC
```
```text
0x6371E14C0682882e75E8382caf0216545B1f43C6
```
```bash
cast call $VAULT "governance()(address)" --rpc-url $RPC
```
```text
0xcd9B2E37D14c57362f005355757bfa6Db450C206
```
```bash
cast call $VAULT "usdc()(address)" --rpc-url $RPC
```
```text
0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

## 2. Read your position

Shares and NAV are 18-decimal ("WAD") integers. USDC amounts are 6-decimal integers
(`1000000` = 1.000000 USDC). `cast` prints the scientific form in brackets for you.

1. Your shares:
   ```bash
   cast call $VAULT "sharesOf(address)(uint256)" $YOU --rpc-url $RPC
   ```
   ```text
   4000000000000000000 [4e18]
   ```
2. Shares you have already queued for a Mode-F exit (0 = none; see §4):
   ```bash
   cast call $VAULT "queuedExitShares(address)(uint256)" $YOU --rpc-url $RPC
   ```
   ```text
   0
   ```
3. A deposit still in its observation window — amount in USDC units, then the unix time it can be
   activated (`0 0` = nothing pending):
   ```bash
   cast call $VAULT "pendingDeposit(address)(uint256,uint64)" $YOU --rpc-url $RPC
   ```
   ```text
   0
   0
   ```
4. All shares outstanding (your pro-rata slice is line 1 divided by this):
   ```bash
   cast call $VAULT "totalShares()(uint256)" --rpc-url $RPC
   ```
   ```text
   4000000000000000000 [4e18]
   ```
5. The vault's net asset value, in WAD dollars (`4e18` = $4.00; divide by `1e12` for USDC units).
   **If this reverts instead of answering, the vault is frozen — go to §3.**
   ```bash
   cast call $VAULT "navWad()(uint256)" --rpc-url $RPC
   ```
   ```text
   4000000000000000000 [4e18]
   ```
6. NAV per share (WAD). Your slice in dollars = your shares × this ÷ `1e36`. Same freeze rule.
   ```bash
   cast call $VAULT "navPerShareWad()(uint256)" --rpc-url $RPC
   ```
   ```text
   1000000000000000000 [1e18]
   ```
7. Your tenure-decayed exit fee **rate**, in basis points (49 = 0.49%; it falls to zero as your
   tenure reaches the vault's decay period). This is a rate, not the amount you will be charged —
   see the waiver below it:
   ```bash
   cast call $VAULT "exitFeeBpsOf(address)(uint256)" $YOU --rpc-url $RPC
   ```
   ```text
   49
   ```
   **Settlement charges zero if you hold every share of the vault.** The exit path compares your
   whole balance with the supply and waives the fee when they are equal — line 1 against line 4,
   `sharesOf(YOU)` against `totalShares()` — because the fee would otherwise be routed back to
   the only member there is. The comparison is on your balance, not on the amount you exit, so a
   sole holder exiting part of a position is waived too. `exitFeeBpsOf` never applies that waiver;
   it reports the rate. **On the vault shown above both reads are `4e18`, so the fee this member
   would actually pay is `0`, not `49`** — check your own line 1 against your own line 4 before
   you subtract anything.
8. What the vault holds, so you can price it yourself: count, then each asset by index, then the
   vault's own balance of it and the idle USDC.
   ```bash
   cast call $VAULT "basketLength()(uint256)" --rpc-url $RPC
   ```
   ```text
   2
   ```
   ```bash
   cast call $VAULT "basketAssets(uint256)(address)" 0 --rpc-url $RPC
   ```
   ```text
   0x4200000000000000000000000000000000000006
   ```
   ```bash
   cast call $VAULT "assetBalance(address)(uint256)" $WETH --rpc-url $RPC
   ```
   ```text
   0
   ```
   ```bash
   cast call $VAULT "idleUsdc()(uint256)" --rpc-url $RPC
   ```
   ```text
   4000000 [4e6]
   ```
   NAV = idle USDC × `1e12` + Σ (asset balance × `priceWad(asset)` ÷ `assetUnit(asset)`). If your
   arithmetic disagrees with `navWad()`, that is exactly the discrepancy the incident playbook
   treats as a potential contract bug ([INCIDENTS.md §2](INCIDENTS.md)) — publish your numbers.

## 3. Read the price, and recognise a freeze

The vault prices every asset through **one Chainlink Data Feed per asset**, with no fallback and no
one who can repoint it. `priceWad` is the oracle's own verdict on whether an asset is priceable, and
**a revert is the freeze** — there is no separate "frozen" flag to read.

1. Each basket asset's price, in WAD dollars:
   ```bash
   cast call $ORACLE "priceWad(address)(uint256)" $WETH --rpc-url $RPC
   ```
   ```text
   2408539487920000000000 [2.408e21]
   ```
   ```bash
   cast call $ORACLE "priceWad(address)(uint256)" $LINK --rpc-url $RPC
   ```
   ```text
   11175916900000000000 [1.117e19]
   ```
   USDC is pinned to exactly $1.00 inside the oracle, so it always answers `1e18`:
   ```bash
   cast call $ORACLE "priceWad(address)(uint256)" $USDC --rpc-url $RPC
   ```
   ```text
   1000000000000000000 [1e18]
   ```
2. **What a freeze looks like.** This is the same call against an address the oracle has never
   listed, which fails the same way a stale, out-of-band or dead feed fails. The revert data begins
   `0xa2671f4b`, the selector of `StaleOracle(address)`, followed by the asset:
   ```bash
   cast call $ORACLE "priceWad(address)(uint256)" 0x000000000000000000000000000000000000dEaD --rpc-url $RPC
   ```
   ```text
   Error: server returned an error response: error code 3: execution reverted, data: "0xa2671f4b000000000000000000000000000000000000000000000000000000000000dead"
   ```
   If step 1 ever prints this for one of your vault's basket assets, that vault is frozen: deposits
   cannot activate, exits cannot settle, and rebalances cannot execute — until the feed is healthy
   again, at which point everything resumes by itself. The app's own explanation, unchanged:

   > **This vault is frozen, on purpose.** A price source for one of its basket assets went stale,
   > so every path that reads a valuation stops — deposits, activations, exits and rebalances
   > alike. Freezing is the safety mechanism: it is what stops anyone entering or leaving at a
   > price the vault can no longer verify. There is no emergency withdrawal and no admin who can
   > override it, by design. Your shares and history are unchanged and still visible. Capital
   > still in the observation window is not frozen — you can cancel it and take it back right now.

   The cancel is §5-B. It reads no oracle, so a freeze cannot stop it.
3. **Why it is frozen** — the feed configuration the vault is locked to. Five values: the feed
   address, the staleness bound in seconds, the decimal scale, and the sane-price band floor and
   ceiling in WAD dollars (`0 0` = no band):
   ```bash
   cast call $ORACLE "feedOf(address)(address,uint32,uint64,uint128,uint128)" $WETH --rpc-url $RPC
   ```
   ```text
   0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1
   86400 [8.64e4]
   10000000000 [1e10]
   100000000000000000000 [1e20]
   100000000000000000000000 [1e23]
   ```
   Then read the feed itself. The fourth value is `updatedAt`; if now minus `updatedAt` is larger
   than the staleness bound above, that is the cause. The second value is the raw answer (8
   decimals); if answer × scale is outside the band, that is the cause.
   ```bash
   cast call 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1 "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RPC
   ```
   ```text
   18446744073709829540 [1.844e19]
   240853948792 [2.408e11]
   1788301620 [1.788e9]
   1788301620 [1.788e9]
   18446744073709829540 [1.844e19]
   ```
4. **The sequencer gate (mainnet only).** On Base mainnet the oracle also refuses every price while
   the L2 sequencer is down, and for a fixed grace period after it restarts. The resume time is not
   an estimate — it is a contract constant (restart time + 3600 seconds). On Sepolia the gate is
   disabled (the address reads as zero), so this step only means something against a mainnet
   oracle:
   ```bash
   cast call $ORACLE "sequencerUptimeFeed()(address)" --rpc-url $RPC
   ```
   ```text
   0x0000000000000000000000000000000000000000
   ```
   ```bash
   cast call $ORACLE "GRACE_PERIOD()(uint256)" --rpc-url $RPC
   ```
   ```text
   3600
   ```
   When the uptime feed is set, read it with `latestRoundData` as in step 3: second value `0` =
   sequencer up, `1` = down; third value + 3600 = the timestamp pricing resumes.

## 4. Read the exit mode before you exit

`requestExit` settles in one of two ways, and the vault decides which by asking its governance
module one question. Read the answer first:

```bash
cast call $GOV "hasPendingExecution(address)(bool)" $VAULT --rpc-url $RPC
```
```text
false
```

- **`false` — Mode I.** `requestExit(shares)` settles in the same transaction: your pro-rata
  slice of every basket asset plus idle USDC, in kind, at current NAV, less the exit fee the
  settlement path computes — the §2 step 7 rate, or zero if you hold every share. It needs the
  oracle, so it reverts while frozen.
- **`true` — Mode F.** The vault has a live proposal that has reached its **reveal phase** (the
  window opens there — not when a proposal passes — and stays open through a passed proposal's
  execution window). `requestExit(shares)` **queues instead of settling**: the shares are locked,
  lose their vote immediately, and the queue is irrevocable. It settles at the *post-rebalance*
  NAV once the proposal executes, is defeated, or its window lapses — by calling
  `settleQueuedExit` (§5-C step 3). This queue reads no oracle, so it succeeds even while frozen,
  and that is a trap rather than a feature: a queue placed during a freeze cannot settle until
  **both** the proposal resolves **and** the oracle recovers. The app withholds the button in that
  state, on purpose.

Which proposal, if any:

```bash
cast call $GOV "activeProposalOf(address)(uint256)" $VAULT --rpc-url $RPC
```
```text
2
```

**A non-zero proposal id is not Mode F.** This read only names a proposal to go and look at; it
does not tell you the mode, in three separate ways. It is set when a proposal is created and is
never cleared — the next proposal overwrites it and nothing zeroes it — so it keeps naming the last
proposal long after that one executed, was defeated or expired. It is also non-zero through the
whole commit phase, which is Mode I: the window opens at the reveal phase, not at creation and not
at passage. `hasPendingExecution` above is the single read that decides.

**Dry-run your exit without sending anything.** A `cast call` with `--from` executes the exact
transaction as a simulation. A revert tells you why it would fail. `0x` tells you only that **the
call would not revert** — nothing more:

```bash
cast call $VAULT "requestExit(uint256)" 1000000000000000000 --from $YOU --rpc-url $RPC
```
```text
0x
```

**`0x` is not a green light in Mode F.** `requestExit` returns no data, so `0x` is what a
successful simulation looks like in **both** modes; it cannot tell them apart. In Mode F what it is
reporting is that the contract will accept the irrevocable queue described above — not that your
exit settles. Nothing un-queues it: once the shares are queued, the only call that clears them is
`settleQueuedExit`, and that reverts `ExecutionStillPending()` until `hasPendingExecution` reads
`false` again. So the mode read, not the dry-run, is what decides whether sending is what you want.

**Re-read `hasPendingExecution` in the same breath as you send.** It can flip to `true` between
your read and your transaction. That is exactly what happened to the snapshot above: it read
`false` at block 46266737 and `true` at block 46269600, with proposal 2 still the id both times. A
dry-run you took a minute ago is not evidence about the block your transaction lands in.

Revert data you may see, and what it means (selectors computed from the source and confirmed
against the live contract):

| Data begins | Error | Meaning |
| --- | --- | --- |
| `0xa2671f4b` | `StaleOracle(asset)` | Frozen (§3). Mode-I settlement cannot price your slice. |
| `0x39996567` | `InsufficientShares()` | You asked for more shares than `sharesOf` (§2 step 1). |
| `0xf2698fc0` | `ExitAlreadyQueued()` | You already have a Mode-F exit queued — one at a time (§2 step 2). |
| `0x1f2a2005` | `ZeroAmount()` | Shares must be greater than zero. |
| `0xa428ab2d` | `CreatorStakeGate()` | Vault creator only: this exit would take the creator below the 5% withdrawal gate while other members remain. |
| `0x885cf1d7` | `ExecutionStillPending()` | `settleQueuedExit` was called too early — the proposal is still pending. |
| `0xe752017c` | `NoQueuedExit()` | `settleQueuedExit` for an address with nothing queued. |
| `0xda7557bc` | `NoPending()` | `cancelPending` with no deposit in the window. |
| `0x96ec8e54` | `BelowMinDeposit()` | Deposit is under the vault's minimum (§5-A step 1). |
| `0x9ff41fe0` | `CapacityExceeded()` | Deposit would take the vault past its cap. |
| `0x4b1a898d` | `PendingExists()` | You already have a first deposit in the window; cancel or activate it first. |
| `0x8e3e8125` | `WindowNotElapsed()` | `activate` before the observation window ended. |

## 5. Act without the website — direct-to-contract recipes

These send transactions. Replace `--account member` with your own signer: a Foundry keystore name
(`--account <name>`), `--ledger`, or `--trezor`. You pay the gas. Every recipe is the same call the
app would make; the app is a convenience, not a gatekeeper. Dry-run any of them first by changing
`cast send` to `cast call` and `--account member` to `--from $YOU`, exactly as in §4.

### A. Deposit

1. Read the vault's minimum, in USDC units:
   ```bash
   cast call $VAULT "minDepositUsdc()(uint256)" --rpc-url $RPC
   ```
   ```text
   1000000 [1e6]
   ```
2. Approve the vault to pull exactly that much USDC (this example: 1.000000 USDC). The vault
   measures what it actually receives; it never trusts the number you pass.
   ```bash
   cast send $USDC "approve(address,uint256)" $VAULT 1000000 --account member --rpc-url $RPC
   ```
3. Deposit. **Your first deposit into a vault mints nothing yet**: it sits in escrow for the
   observation window (14,400 seconds, 4 hours — `OBSERVATION_WINDOW()`), counts toward no vote and
   no NAV, and can be reclaimed in full at any moment with step B. Repeat deposits by an address
   that already holds shares mint immediately at current NAV.
   ```bash
   cast send $VAULT "deposit(uint256)" 1000000 --account member --rpc-url $RPC
   ```
   A repeat deposit can carry a floor on the shares minted, so a NAV that moved between your read
   and your transaction cannot mint you fewer than you accept (`0` opts out; it has no effect on a
   first deposit, which prices at activation instead):
   ```bash
   cast send $VAULT "deposit(uint256,uint256)" 1000000 0 --account member --rpc-url $RPC
   ```
4. After the window, activate. Anyone may call this for anyone; shares mint at activation-time
   NAV, so it reverts while frozen (`StaleOracle`) and simply waits:
   ```bash
   cast send $VAULT "activate(address)" $YOU --account member --rpc-url $RPC
   ```

### B. Reclaim a pending deposit — works during a freeze

The one action a freeze cannot block. It reads no oracle: it deletes your escrow record and
returns the whole pending amount, with no fee deducted from it. It only applies to a deposit still
in its observation window (§2 step 3 shows a non-zero amount); activated shares are exited with C.

```bash
cast send $VAULT "cancelPending()" --account member --rpc-url $RPC
```

**Where that amount lands has two branches, and only one of them is a transfer.** The refund is a
bounded token transfer, and if the transfer itself fails — the case this branch was built for is an
address USDC has blacklisted since the deposit — the call does not revert and does not roll back.
It credits the amount to your `claimable` balance inside the vault and emits `SliceEscrowed`
instead. Your escrow record is still deleted and the whole amount is still yours; it is a balance
to claim rather than USDC in your wallet. So if `cancelPending` succeeds and no USDC arrives, read
the balance:

```bash
cast call $VAULT "claimable(address,address)(uint256)" $YOU $USDC --rpc-url $RPC
```
```text
0
```

and, **only if that read is non-zero** (claiming nothing reverts), pull it out:

```bash
cast send $VAULT "claimEscrowed(address)" $USDC --account member --rpc-url $RPC
```

### C. Exit

1. Read the mode (§4) and your shares (§2 step 1). Then request the exit for a share amount, in
   WAD (this example: all four shares of the smoke vault). In Mode I this settles now, in kind; in
   Mode F it queues irrevocably.
   ```bash
   cast send $VAULT "requestExit(uint256)" 4000000000000000000 --account member --rpc-url $RPC
   ```
2. Mode I only: you are done. Your slice of each basket asset and the idle USDC is in your wallet.
   If a transfer of one asset to you failed at settlement (a token that rejected the transfer, for
   example), the vault holds that slice for you — read it and claim it, any time:
   ```bash
   cast call $VAULT "claimable(address,address)(uint256)" $YOU $WETH --rpc-url $RPC
   ```
   ```text
   0
   ```
   ```bash
   cast send $VAULT "claimEscrowed(address)" $WETH --account member --rpc-url $RPC
   ```
3. Mode F only: once §4 reads `false` again, settle. Anyone may call this for anyone — nothing
   settles it for you as a side effect, so somebody must:
   ```bash
   cast send $VAULT "settleQueuedExit(address)" $YOU --account member --rpc-url $RPC
   ```

## 6. Mainnet — placeholders, not addresses

No mainnet deployment exists, so there is nothing to paste yet. The known constants from
[`contracts/config/base-mainnet.json`](../contracts/config/base-mainnet.json) are the RPC, Circle-native
USDC, and the Chainlink L2 sequencer uptime feed; every contract address is a placeholder until a
deployment record is published beside the Sepolia one. **Do not fill these from any other source** —
a page, a message or a post that hands you a "mainnet vault address" before that record exists is
not from this project.

```bash
RPC=https://mainnet.base.org
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
SEQUENCER_FEED=0xBCF85224fc0756B9Fa45aA7892530B47e10b6433
VAULT=<from contracts/config/deployments/base-mainnet.json — does not exist yet>
ORACLE=<same record>
GOV=<same record>
YOU=<your address>
```

Every command in §1–§5 then applies unchanged. On mainnet the sequencer gate in §3 step 4 is
active: after a Base outage, expect `priceWad` to revert for exactly one hour past the restart
timestamp, and expect the app to show the vault frozen for that hour. Check it yourself:

```bash
cast call $SEQUENCER_FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RPC
```

Second value `0` = sequencer up; third value + 3600 = the timestamp pricing resumes.

## 7. Where this page comes from

Every function name above exists in `contracts/src` at the commit this page was written against
([`VaultCore.sol`](../contracts/src/VaultCore.sol), [`ChainlinkOracle.sol`](../contracts/src/oracle/ChainlinkOracle.sol),
[`Governance.sol`](../contracts/src/Governance.sol)), and the read commands were executed against
the public Base Sepolia RPC with the outputs pasted verbatim. The freeze explanation is the app's
own text. The exit-mode wording matches [AGENT-QUICKSTART.md](AGENT-QUICKSTART.md) and is enforced by
the same test that guards the marketing site, so this page cannot drift from the contract without
turning the build red. The incident messages you may receive point here for the "verify it
yourself" step: [INCIDENTS.md](INCIDENTS.md).
