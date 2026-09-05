# Testnet soak report — Sprint 12

<!-- doc-claims: historical record. The `file:line` citations below describe the pre-C-6 deployment this run was made against and are deliberately NOT re-pointed as the code moves; re-pointing them would falsify the record. `scripts/check-doc-claims.mjs` skips this file. -->

> [!warning] SUPERSEDED DEPLOYMENT (noted 2026-08-30). This report is a faithful record of a run
> against the **pre-C-6 deployment** (`deployBlock` 45,784,186, the custom multi-source
> `OracleAggregator`). That stack was retired and Base Sepolia was **redeployed on 2026-08-29**
> around `ChainlinkOracle` (`deployBlock` 46,111,530). Drills 1, 2, 3 and 5 exercise contracts the
> pivot did not change and their evidence stands. **Drill 4 does not:** its verdict is stated in
> quorum-margin terms (`freshSources` never below 3, quorum 2, margin never below +1) that have no
> meaning on a single-feed oracle, and its "testnet compromise" paragraph describes three
> `ChainlinkSourceAdapter`s that are no longer deployed. The instrument was rewritten for the live
> oracle on 2026-08-30; **launch gates 3 and 6 are re-earned by a re-run, not by this document.**
> The re-run is **not blocked on a key**: `docs/NOW.md`'s soak entry records **NOT BLOCKED** — both
> password files exist (`.soak.pw`, `.soak-agent.pw`), and `scripts/soak/run-soak.ps1`'s own header
> says *"Nothing needs a human once the password files are in place."* What is outstanding is the
> run itself — the five drills executing against the current deployment, with the canary observed
> alongside; see the gate 3 and gate 6 rows of `docs/LAUNCH-READINESS.md`.

**Date:** 2026-08-24 → 2026-08-25 · **Chain:** Base Sepolia (84532) · **Issue:** [#21](https://github.com/SlumperSan/agent-governed-vaults/issues/21)

The Sprint-9 run proved the happy path once, with one member. This soak stress-ran the same
deployment: a second vault with deliberately different economics, a sub-vault allocate/redeem
round trip through governance, the Mode-F exit seam live, an oracle-staleness watch with the
freeze-safety property **executed** rather than merely asserted, and the reference agent running
`mode: 'execute'` against the real deployment for the first time.

Every claim below is backed by a transaction hash or a committed data file, and the runner's own
output was never treated as evidence — each drill re-reads the chain after every write, in the
Sprint-9 tradition. The drills are committed under `scripts/soak/` and are resumable; the raw
state files carry every hash cited here.

| Drill | Verdict | The one-line result |
| --- | --- | --- |
| 1 — multi-vault | **PASS** | leaderboard aggregates two genuinely different vaults; indexer AND canary discovered vault B dynamically |
| 2 — sub-vault | **PASS** | parent NAV **unchanged to the wei** across allocate; round trip drift **0** |
| 3 — Mode-F exit | **PASS** | exit during reveal **queued** (not settled), settlement refused while pending, settled after execution |
| 4 — oracle freeze | **PASS (no event)** | no staleness in the window — worst age 1.4% of the bound; `cancelPending` **executed live**, escrow returned exactly |
| 5 — agent execute | **PASS** | agent joined, activated, committed AND revealed live, then **exited Mode F on its own policy decision** |

---

## 0. Environment and discipline

- Deployment: the Sprint-9 address book, `contracts/config/deployments/base-sepolia.json`,
  **re-proven on-chain at every drill start** (9/9 wiring reads match; a drill refuses to sign
  against a drifted book).
- Signer: the human's Foundry keystore (`--account deployer` + `--password-file`), exactly the
  `SMOKE_SIGNER_ARGS` pattern — **no script in this soak reads, stores, or prompts for a key.**
  The agent's account is a separate throwaway keystore
  (`0x290caf006794A73bb1bA928A38c2a7f099015a6d`), password held by the operator only.
- Services: indexer, API (x402 gate, `FACILITATOR=stub` — see the honest-limits note), canary
  and oracle sampler ran as daemons throughout, started **before** any drill signed.
- Contracts: **frozen.** `git diff v0.2.0-audit -- contracts/src` on this branch shows only the
  Sprint-11 additive oracle files; no drill touched a contract. Every defect found in this soak
  was in off-chain code — six of them, all fixed on the branch with tests (§7).

## 1. Drill 1 — multi-vault: aggregation and dynamic discovery

Vault B (`0xfceca1c1e91bfa6abb51ed7521c576b0dd3fd25f`, created block 45,926,258, tx
`0xc98ef56d…41d196`) differs from the smoke vault in every dimension a leaderboard could
cheat on — asserted on-chain, not from config:

| Parameter | Smoke vault | Vault B |
| --- | --- | --- |
| Basket | [WETH, LINK] | **[LINK] only** |
| capacityCapUsdc | 1,000.00 | **500.00** |
| minDepositUsdc | 1.00 | **2.00** |
| exitFeeMaxBps | 50 | **25** |
| Governance quorum | 2,500 bps | **5,000 bps** (registered tx `0x286edc22…9e664b`) |

Deposit 5.00 USDC (tx `0x5ca2a6fe…626b48`) escrowed with **navWad still 0** — EE-1 (escrowed
capital excluded from NAV) observed live on a second vault. Activation after the natural 4-hour
window: tx `0x30ae208c…3d68269`, 5e18 shares at NAVps exactly 1e18.

**SF-4 leaderboard:** `/operators/leaderboard` shows operator 1 with `vaultCount ≥ 2` and
`/vaults` lists both — aggregation across genuinely different vaults, not a sum of two
identical rows.

**Dynamic discovery — proven, with reconstructed provenance.** The claim requires the indexer to
be already running when `createVault` lands. The load-bearing inequality is chain-verifiable
independent of any log: the indexer's recorded head before creation was **45,926,245**, vault B
was created in block **45,926,258**, and a snapshot at an earlier head cannot contain a vault
created in a later block. The indexer processes ran unrestarted from before vault B existed
until after it appeared in their projection. *Weaker than designed:* the pre-creation snapshot
was overwritten by a resume bug (§7.6) and reconstructed from the run log plus on-chain facts —
recorded as `discoveryProvenance.weakerThanDesigned: true` in the drill state rather than passed
off as a clean single-pass capture. **Independent corroboration:** the canary — a separate
daemon sharing no code with the indexer — also discovered vault B on its own (§6, cycle 366).

## 2. Drill 2 — sub-vault: SV-7 look-through as a conservation law

Child `0x66bf022018ec639673d3fe6b8579c7a53a81ceb7` created under the smoke vault (tx
`0xae30e893…5ca226`), basket [WETH] ⊂ [WETH, LINK] enforced by the factory. Registry edges
verified on-chain: `parentOf` correct, depth 1, stacked exit-fee cap 75 bps = parent 50 +
child 25 (SV-4).

Two full governance rounds on the parent (both 1h commit + 1h reveal + execute):

| Round | pid | commit | reveal | finalize | execute |
| --- | --- | --- | --- | --- | --- |
| Allocate 2.00 USDC → child | 3 | `0x3a193108…f8242e` | `0x4ce4335f…b401f` | `0x65c88ae2…3c8e1` | `0x53a07a13…b0de67` |
| Redeem all child shares | 4 | `0x6a15c34b…79b2dd` | `0x9fd6f25a…b9158` | `0x6755f063…20eaa6` | `0x3e1bbd91…aa9699` |

**The central assertion is a conservation law, not a comparison.** `navWad` counts `idleUsdc`
plus `_childValueWad(child)`, so a working look-through means the parent's NAV is *unchanged*
across the allocation — while a broken one doesn't produce a subtly wrong number, it drops the
NAV by exactly the allocated amount (`_childValueWad` → 0). Observed:

```
allocate:  parent idleUsdc 4,000,000 → 2,000,000   parent navWad 4e18 → 4e18   (unchanged)
           parent holds 2e18 of the child's 2e18 shares; child idleUsdc 2,000,000
round trip: navWad drift 0 · idleUsdc drift 0      (nothing was swapped; exact is the bar, and exact is what happened)
```

The API's `/vaults` projection agreed, recorded as **corroboration only** — the API reads the
same chain, so agreement there is a weaker signal than the conservation law.

Also learned here (§7.3): `windowCleared` is permanent, so the deployer's deposit **minted
immediately** — there was no second 4-hour window in this drill at all.

## 3. Drill 3 — Mode-F exit: the K-1 seam, live

Host: vault B. Proposal 5 (no-op rebalance, propose tx `0xb1209f6f…d15c96`).

The mode boundary was asserted in **both directions** against `Governance.hasPendingExecution`
(Governance.sol:515 — true from `commitDeadline`, i.e. the reveal phase):

1. **Before** the commit deadline: `hasPendingExecution = false` — an exit here would settle
   instantly (Mode I). Proven by reading the flag, not by exiting.
2. Reveal FOR (tx `0xe516efdc…856a8e`) — reveal *before* exiting, because queued shares leave
   eligible stake immediately and exiting first would forfeit the vote.
3. **During the reveal phase** (chain time 1,787,639,592): `requestExit(5e18)` → tx
   `0x7163496e…1d6f64` emitted **ExitQueued and no ExitSettled**. Re-read from chain:
   `queuedExitShares = 5e18`, `sharesOf` still 5e18 (outstanding but locked), **USDC balance
   unchanged** — a queued exit pays nothing.
4. `settleQueuedExit` while execution pending: **reverted** (`ExecutionStillPending`) — the
   EE-10/K-1 guard, exercised.
5. Finalize (`0xf036001b…5b6f21`, Passed) → execute (`0x227b1c40…be6f90b`, RebalanceExecuted) →
   settle (`0xebf4fbfc…521af7`): **5,000,000 USDC units returned**, shares 0, queue empty.
   Deployer USDC 27.96 → 32.96, exact.

**Honest limit, stated where it was earned:** the rebalance was a no-op, so pre- and
post-execution NAV are equal *by construction* (both 5e18). "Settles at post-execution NAV" is
proven **structurally** — the exit queued instead of settling, and settlement was impossible
until execution — and **not numerically**: no price delta separates the two readings. Proving it
numerically requires a real swap with real slippage, deliberately out of scope on this testnet.

## 4. Drill 4 — oracle freeze: verdict over the series

`oracle-sampler.mjs` sampled every ~60–120 s from **chain time** (never the host clock);
`drill4-oraclefreeze.mjs` signs nothing and reduces the series (`data/oracle-series.jsonl`).

**Verdict: NO STALENESS EVENT — worst-case age documented instead, per #21.** Over 337+ samples
spanning the soak: WETH worst age **1,224 s** and LINK **1,202 s** against the 86,400 s bound —
**1.4%** of the limit. `freshSources` never dropped below 3 (quorum 2), margin never below +1,
`priceWad` reverted in 0 samples. The canary's oracle-freshness rows stayed `ok` throughout,
consistent with the chain.

**Testnet compromise, stated plainly:** Base Sepolia runs three `ChainlinkSourceAdapter`s over
ONE underlying feed per asset, so all sources age together and the margin is all-or-nothing
(+1 → −2, no gradual decay). This drill cannot exercise partial-quorum degradation; mainnet's
three mechanism-diverse sources (Sprint 11) decay independently.

**Freeze safety (SF-2/K-4) — upgraded from asserted to executed.** The one member-capital path
that must survive an oracle freeze is `cancelPending` (escrowed USDC is unpriced, so returning
it needs no oracle). Evidence, in increasing strength:

1. The sampler static-called it against the agent's real 1.00 USDC pending deposit for ~50
   minutes: verdict `callable` in every probed sample.
2. It was then **actually executed** by the agent's account (tx `0x927157d3…88f5a4`, block
   45,946,228): the escrowed 1,000,000 units returned **exactly** (balance 2,000,000 →
   3,000,000).

*Honest limit:* callable-and-executed was demonstrated during normal oracle operation, not
during an actual freeze — no freeze occurred to test under. The property that needed live
evidence (the path works, end to end, for a real pending depositor) now has it; the property
that a freeze does not disable it rests on the contract's code path having no oracle
dependency, which the audit should confirm.

## 5. Drill 5 — reference agent, execute mode, live

The first live run of the full agent loop. Key handling identical to Sprint 14: V3 keystore
decrypted in-process, path and password from the operator's own invocation, raw keys in env
refused. The shipped CLI cannot sign (`run.mjs` hard-codes dry-run); the drill constructs the
agent directly and the `AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS` gate is still required.

| Phase | Evidence |
| --- | --- |
| join — agent decided via its own gates, then signed | approve `0xd3cabae0…fdc02ad` + deposit `0xe52748f4…dd6198` — 1.00 USDC escrowed |
| freeze-safety detour | `cancelPending` **executed** `0x927157d3…88f5a4` (escrow returned exactly), re-approve `0xc6fc064a…ac30583`, re-deposit `0xa37efac2…84efe9fc` |
| activate — via `skipWindow` | `0x7037781d…c716d6fc` (block 45,946,235): 1e18 shares minted immediately |
| vote host | proposal 6, raised **after** activation so the agent is in the snapshot: 5e18 across **2 members** (propose `0x1810a8ef…3a091c22`) |
| vote — commit | agent committed through its own loop, tick 1 (deployer companion: `0xa0eb4b27…3168eaa1`) |
| vote — **reveal** | **`revealedOf(6, agent) == true` on-chain.** The salt was re-derived from a signature, never stored — S-4 proven live (companion reveal `0x1a1599e1…6ce5df`) |
| exit — agent's own decision | `0x9bc48dab…00b6c660`. Its log: `✓ drawdown: NAV/share 1.0000 vs entry 1.0200 = 196bps down, threshold 1bps` → `EXIT — exit triggered by: drawdown [MODE F: forward-priced]` |
| settle | `0x875f8642…a183f76d` — 1e18 shares settled after execution. Final: agent shares **0**, USDC 2,995,100 |

**The most valuable result in this drill was not planned.** The agent's exit fired *during the
pending-execution window*, so its own policy took the **Mode-F** branch — and the agent's log
shows it understood that (`[MODE F: forward-priced]`). Drill 3 proved Mode F with a scripted
human; this proves an autonomous agent reaches the same seam unaided and prices correctly through
it. The queued exit was then settled by a third party (`settleQueuedExit` is callable by anyone —
EE-10), which is the intended liveness property, exercised end to end.

The agent also paid a real exit fee: 1,000,000 units deposited, 995,100 returned — **4,900 units
(≈49 bps)** against the vault's 50 bps ceiling with almost no decay elapsed. Fee routing worked on
a live agent position, not a fixture.

**Deviations from the naive reading of #21, on the record:**

- **Activation used `skipWindow`, not the 4-hour wait** — on operator instruction, to compress
  the schedule. This is a documented, irreversible, per-agent contract path (VaultCore.sol:369)
  that had *never* been exercised live; the natural deposit → 4h → activate path was already
  exercised in this soak by drill 1 and by the agent's own first deposit. Net coverage went up.
- **The exit trigger is forced by construction and says so.** The smoke vault holds only idle
  USDC; its NAVps is pinned at exactly 1e18 and cannot fall, so *no threshold alone* could ever
  detect a drawdown that does not exist — lowering `maxDrawdownBps` would have proven nothing.
  The agent's *entry mark* was therefore seeded 2% above true NAVps, and it measured the gap
  itself: `196bps down, threshold 1bps`. What is proven is the **perceive→decide→act path**,
  including that the agent correctly identifies the Mode-F branch; it is **not** evidence of a
  real loss, and the vault's NAVps never moved.
- The x402-metered reads the agent paid for ran against `FACILITATOR=stub` — the 402 challenge/
  gate/budget path was exercised ($0.05–0.25 of session budget spent), on-chain settlement was
  not. Live settlement is Sprint 14's separately-proven result (X402-LIVE-REPORT.md).

## 6. Canary reconciliation — every transition, and its cause

The canary ran throughout (last scanned block 45,946,303). Every row that ever left its initial
state reconciles to a specific drill action; nothing moved without a cause and no drill action
that should have moved a row failed to.

| Transition | Cause |
| --- | --- |
| smoke vault `exit-liveness`: DEGRADED → **ok** (cycle 366) | **Drill 2.** Sprint 9 left the vault with zero members, so the exit-liveness probe had nobody to test with (the long-standing DEGRADED). The deployer's 4 USDC deposit gave it a member again. |
| child vault: **all rows appear** (cycle 358) | **Drill 2.** The canary discovered the child on its own — no restart, no config. |
| vault B: **all rows appear** (cycle 366) | **Drill 1.** Same dynamic discovery, second daemon — independent corroboration of drill 1's claim. |
| child `exit-liveness`: ok → **skipped** (cycle 963) | **Drill 2's redeem.** The parent redeemed out entirely; totalShares 0 means nothing to probe. `skipped` is the honest verdict — "could not measure" is not "OK". |
| vault B `exit-liveness`: ok → **skipped** (cycle 970) | **Drill 3's settlement.** Full Mode-F exit emptied the vault. |
| everything else | `ok` for the entire soak, matching the chain: no oracle event, no NAV-backing divergence, no share-conservation violation, no unexpected module event. |

## 7. Defects found — all off-chain, all fixed on this branch with tests

**No contract defect was found.** Two reference-agent bugs are product findings; the rest were
in this sprint's own drill code, found by running it live. Each is one commit with its evidence
in the message.

| # | Where | Defect | Fix |
| --- | --- | --- | --- |
| 1 | **reference agent**, `policy.mjs` | `requireProvenOperator: false` was **inert**: a hardcoded `net > 0n` refused zero-track-record operators even when the flag explicitly accepted them — no configuration could ever join a brand-new operator. Found live: 40 execute-mode ticks, agent's own gate output was the diagnosis. | gate now honours the configured floor (`net >= minNet`); defaults unchanged; 2 regression tests |
| 2 | **reference agent**, `act.mjs` | execute-mode deposits **never set an ERC-20 allowance** — `deposit` pulls via `safeTransferFrom`, so the agent's headline action reverted `TransferFromFailed` in every possible configuration, as shipped | approval emitted as part of the deposit intent, declared in `resolveCall` so dry-run prints it too; exact-amount approval leaves no standing allowance |
| 3 | drill code | **nonce contention**: parallel drill tracks share one signer; governance serializes per *vault* but nonces are per *account* — concurrent `cast send`s collided | cross-process lock around submission only (waiting still overlaps); verified with two live processes |
| 4 | drill code | **read-your-writes**: load-balanced RPC endpoints serve reads from nodes behind the block a send just mined — `codesize` of a just-created vault read 0 | `send()` polls until the RPC's own head reaches the mined block; `pollUntil` at sharp assertions |
| 5 | drill code | same root cause on the **time axis**: `activate`/`finalize` submitted the instant `now >= deadline` were gas-estimated by a lagging node → `WindowNotElapsed`/`WrongPhase` on boundaries the contract (`>=`) accepts | `waitUntilChainTime` holds a 30 s margin past every deadline |
| 6 | drill code | drill 1's pre-creation indexer snapshot was **overwritten on resume** (`saveFirst` means flush-before-send, not write-once) — the drill then correctly refused its own evidence | captured once, guarded; the affected run's proof reconstructed with provenance recorded (§1) |

Also recorded, config-not-code: `policy.join.depositUsdc` is denominated in **whole USDC**
unlike every other amount in the system (base units) — the drill fed it base units and the
agent's capacity gate correctly refused a million-dollar deposit. The soak config now names the
field `agentDepositWholeUsdc` so the unit cannot be misread.

**Operational note for the ops runbook:** `sepolia.base.org` degraded into broad read failures
under sustained load mid-soak; `base-sepolia-rpc.publicnode.com` took over without incident.
Defects 4 and 5 are the same lesson — treat any public RPC hostname as a load balancer over
nodes at different heights, on both the state axis and the time axis.

## 8. Spend and residue

Whole soak, all five drills, every retry: **~12 USDC of testnet funds and < 0.01 ETH of gas**,
out of 36.96 / 0.49 available. The agent throwaway ends holding ~2 USDC + ~0.009 ETH
(recoverable — the keystore persists, unlike Sprint 14's ephemeral payer). Vault B and the
child vault end **empty** (fully exited); the smoke vault ends with the deployer's 4 USDC and
the agent's 1 USDC positions, which is deliberate: the deployment goes into Sprint 15 with live
members, not a museum piece.

## 9. What is now proven, and what is not

**A note on scope, added after this soak completed.** An AI pre-audit run against the frozen
contracts on 2026-08-25 found **five Critical and nine High** findings (see
`docs/audit/AI-AUDIT-REPORT.md` and issues #31–#35). Nothing in this soak contradicts them and
nothing here should be read as clearing them: **this soak exercised the happy paths and the
designed failure modes; it did not attempt adversarial exploitation.** Every drill acted as an
honest participant. That is the correct scope for a soak — but it means a green soak and a
vulnerable protocol are entirely compatible, and both are true here. The most striking evidence
is that the protocol's own 189 tests and all 33 audit exploit tests pass *simultaneously*.

**Proven live on the deployment:** multi-vault aggregation over genuinely different configs;
dynamic discovery by two independent daemons; SV-3/SV-4 edges and stacked-fee caps; SV-7
look-through as an exact conservation law with a drift-0 round trip; EE-1 on a second vault;
the full Mode-F queue → blocked-settle → post-execution-settle sequence; `cancelPending`
executed to the wei; `skipWindow` live; the agent's full perceive→decide→act loop in execute
mode — gates, approval+deposit, commit AND reveal with a re-derived salt, forced exit; and the
canary tracking every one of those causes.

**Not proven, stated without softening:** behaviour during an *actual* oracle freeze (none
occurred; the sepolia feed topology cannot produce partial degradation); post-execution pricing
as a *numeric* delta (no-op rebalance); any real-swap execution path (no token ever moved
through the router); the x402 settle path under the agent (stub facilitator — proven separately
in Sprint 14); and multi-operator competition (one operator identity ran everything). **Above all: nothing here
is evidence of security.** No drill attempted to steal, brick, capture, or grief anything — see
the scope note above.
