# Launch readiness — mainnet go/no-go

**VERDICT: NO-GO — remediation landed for 18 findings, but C-1 remains open by design decision, four Highs remain open, and no external audit has happened.**

An AI pre-audit run against the frozen contracts on 2026-08-25 found **41 issues: 5 Critical, 9
High, 15 Medium, 7 Low** ([AI-AUDIT-REPORT.md](audit/AI-AUDIT-REPORT.md), issues #31–#35). A
remediation pass on 2026-08-27 closed **twelve** of them.

**Closed:** C-2, C-3, C-5 (Critical); H-1, H-2, H-3, H-4 (High); M-1, M-2, M-3, M-4, M-6, M-11,
M-12 (Medium); L-1, L-2, L-3, L-4 (Low). Each has `test_remediated_*` coverage, and the exploit
each replaced is preserved in git history.

**One defect closed that the audit did not find:** `proposalCooldown` was not validated at all
and is a `uint32`, so a creator could set ~136 years and make a vault unable to ever open a
second proposal. That is C-2's exact shape — an unbounded duration parameter that permanently
disables governance — on a field C-2 did not cover. Found while fixing M-6, now capped at 30 days.

**And one that changed the budget:** M-11's fix made `VaultCore` *smaller* by 336 bytes (the
bounded-assembly path is cheaper than the `abi.decode` path it replaced, and these helpers inline
at every call site). That headroom is what made M-2 affordable at all — see §5.

**C-4 is closed by root cause, not by a bespoke guard.** The report states that fixing C-3,
H-1, H-2 and M-1 removes its trigger; all four are now fixed. The mint-time NAV bound it
suggested as defence-in-depth was **not** shipped — it needs VaultCore bytes that are not
available (1,182 B of EIP-170 headroom remain) and it touches the deposit path, which is not a
place to add unreviewed logic. Stated as a deliberate omission, not an oversight.

**Still open: C-1 (#33), H-5, H-6, H-8, H-9, and the remaining Medium/Low tier** (M-5, M-7,
M-8, M-9, M-10, M-13, M-14, M-15; L-5, L-6, L-7; the informational tier). C-1 is open because
its own suggested fix is wrong — see §6. M-7 is *partially* mitigated: the new
`proposalCooldown` floor rate-limits its propose-defeat-propose cycle without removing it.

**Read this before anything else in the document.** Two separate warnings, and the second is
now the more important one.

First: every "GO" row below was earned by evidence of *correct operation* — deployment,
lifecycle, soak, settlement. None of it is evidence of *security*, and the two are not
substitutes. The original board was green while 17 committed exploits also passed.

Second, and new: **the remediation invalidated the evidence.** Gates 2, 3, 4 and 6 were earned
against bytecode that no longer exists. `VaultCore`, `Governance`, `OracleAggregator`,
`UniswapV3TwapSource`, `VaultFactory` and `BoundedCall` all changed. The Base Sepolia
deployment those reports describe is now a deployment of *superseded* contracts. Every such row
is re-marked **STALE** below rather than left GO — which is the same defect this document was
corrected for once already, one layer out.

Evidence-based per issue [#24](https://github.com/SlumperSan/agent-governed-vaults/issues/24):
every row names a verifiable artifact — a report, a tag, a transaction, a CI run — and anything
unverifiable is marked NO-GO or CONDITIONAL, never assumed. First assessed 2026-08-25 at
`ad9396d7`; battery re-recorded 2026-08-27 at `e7dadf34`; **re-assessed and re-measured
2026-08-27 on the `security/critical-remediation` branch** (§5), which is where the twelve
fixes live. Each re-measurement has been forced by the same thing: the tree moved, so the
evidence stopped describing it. **The `v0.3.0-audit` tag is withdrawn as an engagement
reference** (gate 1); it remains a valid historical marker of the pre-remediation tree.

## 1. Go/no-go checklist

| # | Gate | Verdict | Evidence |
| --- | --- | --- | --- |
| 0 | **No known unfixed Critical vulnerabilities** | **NO-GO** | **C-1 (#33) remains open.** C-3 (#31) and C-5 (#34) are FIXED with remediation tests; C-2 was fixed earlier; C-4 (#32) has its trigger removed by C-3/H-1/H-2/M-1. C-1 is open on a **design decision, not effort**: the report's own suggested fix (`pHeld = 0`) breaks a legitimate parent+1-member child — the signer regime needs `1*2 > 2`, which is false — while only raising capture cost from one dust deposit to two sybils, and buying nothing at all once `memberCount` reaches 5. H-4 now bounds the *loss* (capture no longer equals drain), and L-1 removes the attacker-creates-the-child variant. But **the parent's escape hatch is still broken**: H-6's `test_B1`/`test_B2` still pass, so `redeemFromChild` cannot be relied on to pull capital out of a captured child. Mitigated, not closed. Operational answer meanwhile: **zero sub-vaults at launch** (§2). |
| 1 | External audit completed, findings remediated | **NO-GO** | Not started. **Nothing in this session changes this row, and nothing could** — an AI pre-audit is not an external audit. `v0.3.0-audit` remains withdrawn as an engagement reference. The remediated tree is the one to commission against, at a **new tag** (`v0.4.0-audit` recommended); the engagement is a **full** review, not a delta, and it must now also cover the remediation itself — six contracts changed, including the assembly in `OracleAggregator._tryLatestPrice`. |
| 2 | Testnet full lifecycle proven (#15) | **STALE** — must be re-run | [TESTNET-REPORT.md](TESTNET-REPORT.md): deploy block 45,784,186, all contracts Basescan-verified; full lifecycle green with an exact USDC round trip. Deployment re-verified live 2026-08-24: on-chain `codesize` of every singleton equalled what the tree built **then**. It no longer does — six contracts changed. The Base Sepolia instance is now a deployment of superseded bytecode, and this row cannot return to GO without a redeploy and a fresh lifecycle run. |
| 3 | Soak drills incl. Mode-F + sub-vault (#21) | **STALE** — must be re-run | [SOAK-REPORT.md](SOAK-REPORT.md): 5/5 drills passed — multi-vault aggregation, SV-7 look-through as an exact conservation law (drift 0), the full Mode-F queue→blocked→settle sequence, oracle watch with `cancelPending` **executed** to the wei, and the reference agent's first live execute-mode loop. Honest limits stated in the report (§9). **Every one of those results was earned against contracts that have since changed**, and the drills exercise exactly the paths the remediation touched — oracle quorum, Mode-F exits, rebalance execution. Re-run against the corrected contracts before this row means anything. Note also that the sub-vault drills conflict with the "zero sub-vaults at launch" parameter (§2): re-run them on testnet, deploy none on mainnet. |
| 4 | Live x402 settlement (#23) | **GO** (unaffected) | [X402-LIVE-REPORT.md](X402-LIVE-REPORT.md): real `transferWithAuthorization` on Base Sepolia, 14/14 independent `cast` checks; independently re-verified during the PR #27 review gate (balance deltas, events, nonce burn, all four domain separators re-derived). **Genuinely unaffected by the remediation** — x402 settlement is off-chain plus a USDC `transferWithAuthorization`, and touches no contract this branch changed. This is the one operational gate that survives intact. |
| 5 | Mainnet oracle stack: 3 mechanism-diverse classes, config verified on mainnet RPC | **NO-GO** | **The config no longer builds.** H-1 requires `quorum >= 3`, so `quorum: 2` is rejected; at 3 sources quorum 3 leaves no headroom, so each asset needs **5** sources — two more per asset, whose real Base mainnet addresses a human must supply and which must not be invented. H-2 requires `maxObservationAge <= window / 20`, so the shipped `1800/3600` pair is rejected (90s is the ceiling at that window). Both rejections are pinned as tests. `base-mainnet.json` status is now **NOT-DEPLOYABLE** with a `rebuildChecklist`. The 22/22 on-chain verification is retained and still true of the addresses it checked — but M-12 already established the script cannot observe `maxObservationAgeSeconds` at all, so it would never have caught this. |
| 6 | Canary operational | **STALE** — re-run with the soak | Ran throughout the soak; every transition it ever recorded reconciles to a specific drill action, including dynamically discovering two new vaults on its own (SOAK-REPORT §6). The canary itself is read-only and unchanged, but its evidence came from watching the superseded contracts; it re-earns this row alongside the gate-3 re-run. |
| 7 | Ops runbook exercised — a restore actually performed | **CONDITIONAL** | Sprint 13 shipped the backup ring + `verify` subcommands with tests, and the soak restarted services freely — but **a deliberate restore-from-backup drill has not been recorded**. ~30 minutes, read-only, no keys. Until performed, "restore works" is a test-suite claim, not an operational one. |
| 8 | All CI gates green at the candidate ref | **GO** — and "green" now means more than it did | Full battery on the remediation branch: `forge fmt --check`, `forge build --sizes`, `forge test` (**237 pass, 0 fail, 0 skip**), `forge snapshot --check` all pass; backend **553 tests, 551 pass, 0 fail, 2 skip** (§5). The qualifier has genuinely changed: the audit suite is now **mostly `test_remediated_*`**, so a passing audit test asserts an exploit has been CLOSED rather than that it works. Twelve findings moved from the first category to the second. It still certifies that the gates ran, not that the protocol is safe — gate 0 and gate 1 are the rows that speak to safety, and both are NO-GO. The `v1.0.0-launch-candidate` tag is deliberately **not cut**. |

Also folded into this branch: the facilitator's server-side price re-check now **fails closed**
when no challenge is posted (`no-challenge`) — the PR #27 review finding that made the open-relay
guard opt-out by omission. Regression tests pin both the refusal and that the chain client is
never reached.

## 2. Launch parameters — argued, not asserted

**Initial `capacityCapUsdc`: 50,000 USDC for the first vault.** The cap is immutable per vault,
so "staged caps" necessarily means *staged vaults* — start one small, deploy larger ones later
against a demonstrated record. 50k is chosen as: large enough that fee economics are real (a 10%
performance fee on plausible returns pays for operations); small enough that a total-loss event
— the honest worst case for an immutable, freshly-audited protocol — is survivable and
compensable. Raise by deploying a second vault (≥250k) only after ≥30 incident-free days with
the canary clean. Do not launch with an uncapped vault; SF-3 makes the cap optional, judgment
says it is not.

**Exit fee: `exitFeeMaxBps = 50`, decay 302,400 s (3.5 days).** The protocol cap is 100 bps;
50 is the value exercised end-to-end in the soak, and it leaves headroom for a child vault
(stacked cap 50+25=75 ≤ 100 was proven live, SOAK-REPORT §2).

**Governance config: `3600/3600/0/86400`, quorum 2,500 bps root floor.** Exactly the values the
soak ran through five full rounds. The 1-hour commit/reveal floors are contract minimums; the
zero timelock is defensible *because* Mode-F exists — a member who dislikes a passed proposal
exits at post-execution NAV rather than needing a veto window. A higher-quorum variant (5,000)
was exercised live on vault B. Child quorum floors inherit (SV-6).

**Oracle staleness: 3,600 s per asset — not tighter.** The "tight (minutes)" advice in
DEPLOYMENT §2 is correct for a pure push-feed stack and wrong for this one: the Pyth leg only
advances when someone pays to post, so a tight bound drops it from the fresh set on most reads
(the live cbETH Pyth price was 2,549 s old at config verification).

**The reasoning behind this number changed with H-1, and the conclusion survives for a better
reason.** The original argument was that a tight bound "silently demotes 2-of-3 into 2-of-2 with
no failure headroom" — and 2-of-2 was assumed to be merely *less redundant*. It was worse than
that: at two fresh sources the aggregator returned the **minimum**, not a median. The test that
asserted this (`test_tightStalenessSilentlyDemotesPullLegAndRemovesHeadroom`) has been replaced
by `test_tightStalenessCostsHeadroomButNoLongerCostsTheMedian`, which pins the corrected
behaviour: at five sources a tight bound costs a source of headroom rather than the integrity of
the price. Keep 3,600 s; tighten only after funding a keeper at a measured cadence.

**Operational corollary: push fresh Pyth updates for every price id immediately before deploy,**
or PythSource withholds from the first read.

**New, and now a hard constraint: `maxObservationAge <= window / 20`.** H-2 established that the
newest observation's age IS the live tick's weight in a TWAP. At the launch window of 1,800 s
the loosest legal age is 90 s. A pool too quiet to satisfy that needs a **longer window**, not a
looser age — the ratio is the bound, so relaxing the numerator defeats it.

**First baskets: WETH + cbETH — majors only.** The TWAP source quantizes at $1e-6, a listing
constraint below ~$0.01/token (filed at PR #25). No asset outside the verified config, no
low-priced assets, until a second verification pass and a deliberate listing decision.

**Each of those two assets now needs FIVE price sources, not three** (H-1: quorum must reach
MIN_MEDIAN = 3, and at three sources that leaves zero failure headroom). Only three mechanism
classes are implemented, so slots 4 and 5 are carried by **operator** diversity — a second and
third independently-operated push feed. SF-1's requirement is that no single failure is shared,
not that all five mechanisms differ. Their addresses are a human input; `base-mainnet.json` is
marked NOT-DEPLOYABLE until they exist.

**Topology: root vaults only — zero sub-vaults at launch.** This is a launch *parameter*, not
just an incident note, and it is the cheapest risk reduction available anywhere in this document.
C-1 ([#33](https://github.com/SlumperSan/agent-governed-vaults/issues/33)) makes a funded child a
one-minimum-deposit capture whose capture equals drain; the whole class disappears if no child is
ever created, and a single-level launch needs none. It costs nothing to honour and it does not
wait on a redeploy. Reinstate sub-vaults only after #33 is remediated **and** the SV-* drills are
re-run against the corrected contracts (see §6). Note this also removes residual-risk row 9
(EE-6/E5 child-escrow asymmetry) from the launch surface entirely.

## 3. Key & role map at launch

| Key | Holder | Power | Blast radius if compromised | Rotation |
| --- | --- | --- | --- | --- |
| Deployer EOA | operations | Deploys and wires the singletons; **no post-wiring authority** — no owner functions exist to hold | Its own gas; any vault memberships it retains | Retire it after launch: fund operations from fresh keys, keep no balance on it |
| Operator identity (per-vault, registry attestation at `createVault`) | vault creator | Leaderboard identity; creator stake gate (5% while members remain); proposes/votes with its shares like any member | Same as any member of equal weight — **cannot** pause, upgrade, reprice, or move others' funds | **Unrotatable — by design.** Attestation is immutable per vault; a compromised operator identity means winding down that vault via exits and launching a new one |
| Facilitator settler | operations | Broadcasts `transferWithAuthorization`; pays gas | Its own gas, plus broadcasting *held* authorizations — each names recipient and amount, and the fail-closed re-check refuses anything not matching a posted challenge. Member principal unreachable | Generate a new keystore, fund, restart — the facilitator is stateless |
| API host | — | **Keyless by design** | Availability only | n/a |
| Indexer / canary | — | Keyless, read-only | Display-layer only; the canary reads the chain directly | n/a |

## 4. Residual-risk register — what can go wrong, worst case, why we ship anyway

Lifted from the threat model's accepted rows, the review record, and the soak — in plain
language, for a reader who is not an auditor.

| # | Risk | Worst case | Why ship anyway |
| --- | --- | --- | --- |
| 1 | **Immutability itself** | A critical bug that survives review is permanent; funds in affected vaults may be unrecoverable | **This row is no longer hypothetical, and its cost is now itemised.** Five Criticals were found in the frozen tree. Twelve findings have since been fixed — every fix requiring a full redeploy, because nothing can be patched — and C-1 remains open because its own suggested fix was wrong. The remediation is itself evidence for this row: the tree changed six contracts, which invalidated the testnet deployment, the soak and the canary evidence in one move. Mitigation is the audit (gate 1), the remaining remediation (gate 0), small staged caps, and re-earning the operational gates |
| 2 | **Oracle freeze (K-4)** | All capital in a vault frozen for the duration of a staleness event — exits included, no hatch | Freezing beats mispricing. **The freeze is now MORE likely and that is the correct trade**: quorum 3 with a 5-source set trips after three failures rather than two, and the TWAP leg withholds on a quiet pool instead of quoting a stale tick as fresh (H-2). More withholding is the price of never returning a wrong price. `cancelPending` (the one guaranteed path, for unactivated deposits) **executed live** in the soak; canary alerts; playbook §1 |
| 3 | **TWAP leg prices USDC at $1.00** | A sustained USDC depeg mis-prices that leg by exactly the depeg | A 3-of-5 quorum outvotes the pinned leg with room to spare — and unlike the old 2-of-3, the median is a genuine median at every reachable `k` (H-1), so the pinned leg can no longer *become* the price by being the lower of two. Reference feeds for off-chain depeg monitoring are named in the config; measuring USDC on-chain would reintroduce the push-feed dependency the TWAP leg exists to avoid |
| 4 | **One WETH/USDC pool serves TWAP legs of both launch assets** | That pool going quiet withdraws a source from both assets at once | Disclosed in the config rather than hidden. **This got materially safer and materially more likely at once:** a quiet pool now makes the TWAP leg WITHHOLD rather than quote a stale tick as fresh (H-2), so correlated withdrawal is a correlated *freeze* rather than a correlated *wrong price* — and at 5 sources there are two of headroom to absorb it. Pool cardinality 5000 verified on-chain |
| 5 | **Pyth is pull-based** | An unfunded keeper lets the pull leg silently lapse, costing one of the five sources | The 3,600 s staleness bound was chosen *for* this (test-asserted). What changed: lapsing used to demote 2-of-3 to a two-element "median" that was a minimum; it now costs one of two spare sources and the price stays a real median. Keeper funding remains an explicit launch-ops item; canary watches per-source freshness |
| 6 | **TWAP output quantized at $1e-6** | Wrong-but-plausible prices for assets under ~$0.01 | Majors-only baskets at launch; filed as a listing constraint, not a code fix, deliberately (precision trades against overflow headroom) |
| 7 | **x402 returns on broadcast, not finality** | A reorg un-settles a paid read that was already served (~seconds of exposure) | Pennies per read; an operator needing finality can configure a confirmation wait and pay the latency |
| 8 | **Replay defenses are layered, not duplicated** | The API's seen-nonce set is process-local and resets on restart | The chain's `authorizationState` is the authority and survives everything — proven live (nonce burned, resubmission refused). The challenge nonce is advisory, documented as such |
| 9 | **EE-6/E5 child-escrow asymmetry** | A child persistently escrowing an in-kind slice back to a blacklisted parent turns parent exits into reverts | Known residual from the Sprint-6 review; launch baskets and single-level sub-vault plans keep the surface minimal; a deferred-claim mechanism is the eventual fix |
| 10 | **Vendored GPL-2.0-or-later / MIT math under a BUSL repo** | License challenge to the distribution | Counsel question, flagged in the audit handoff; not a deployment-mechanics risk |
| 11 | **The reference agent is not audited product** | Two launch-class bugs (an inert policy flag; deposits that could never succeed) were found only by running it live in the soak | Both fixed with regression tests — but the finding argues the agent ships as *reference code, beta*, outside the contract-audit scope, and says so |

## 5. Battery record at this ref

Re-run in full on **2026-08-27** on `security/critical-remediation`, from a clean worktree.
Every gate below was executed in this session; none is quoted from a previous run.

| Gate | Result | Where |
| --- | --- | --- |
| `forge fmt --check` | **pass** (exit 0) | local |
| `forge build --sizes` (EIP-170) | **pass** (exit 0) | local |
| `forge test` | **252 tests / 32 suites — 252 pass, 0 fail, 0 skip** | local |
| `forge snapshot --check --nmt testFuzz` (gas gate) | **pass** (exit 0), against a **regenerated** baseline | local |
| `npm run test:backend` | **553 tests — 551 pass, 0 fail, 2 skip** | local |
| CI | pending on the PR | GitHub Actions |

**EIP-170 headroom, tracked deliberately** because it governed what could be fixed at all:

| Contract | Runtime | Margin |
| --- | --- | --- |
| `VaultCore` | 23,562 | **1,014** |
| `Governance` | 12,051 | 12,525 |
| `UniswapV3TwapSource` | 5,169 | 19,407 |
| `VaultFactory` | 2,818 | 21,758 |
| `OracleAggregator` | 1,215 | 23,361 |

`VaultCore` started this session with 1,560 B of margin and ends with **1,014**. The path there
is worth recording, because it is not monotonic: H-4 cost 375 and M-4 cost 3, leaving 1,182;
then **M-11 returned 336** (bounded assembly is smaller than `abi.decode`, and these helpers
inline at every call site), reaching 1,518; then M-2 spent 504 on the escrow routing. **M-2 was
affordable only because M-11 came first.**

**H-5, H-6, H-9 and M-15 remain unfixed for this reason** — they all land in `VaultCore`, and
several would not fit even alone. `Governance` net *shrank* across the session despite gaining
M-6's bounds, because C-5's fix replaced four inline weight reads with one helper.

**The gas snapshot was regenerated wholesale**, not reviewed line by line: six contracts changed
bytecode, so every entry moved. The gate is re-baselined, which means it will catch the *next*
regression but certifies nothing about this diff.

**What the 237 forge tests contain.** 30 audit artifacts under `contracts/test/audit/`, of which
only the still-open findings remain `test_finding_*`; the rest are now `test_remediated_*`,
plus controls and refutations. The mock backing every TWAP test was **replaced** (H-3) — the old
one generated cumulatives from a single live tick, so a correct historical TWAP and a live-tick
extrapolation were numerically identical and no assertion in that suite could fail for H-2's
class. All 233 tests then passing still passed against the faithful mock, which is the evidence
the replacement was behaviour-preserving rather than merely green.

**The two backend skips**, named so neither is mistaken for coverage: the API SIGTERM drain test
(`kill()` is `TerminateProcess` on Windows — it executes on Linux CI) and the live-indexer
snapshot parser (no live snapshot in a fresh checkout). Eleven further ABI-drift guards skip if
`contracts/out` is absent; the numbers above are from a run **after** `forge build`.
## 6. The path to GO

Shorter than it was, and still not short.

1. **Decide C-1 (#33).** This is a design decision, not a coding task, and it is the reason the
   gate-0 row is still NO-GO. The report's suggested fix (`pHeld = 0`, counting the parent as a
   member) was implemented and analysed, and **it does not work**: at parent + 1 member the
   signer regime needs `1 * 2 > 2`, which is false, so the legitimate child canonised by
   `test_childRuleChangePassesAfterParentAllocates` could no longer pass a Rebalance — while an
   attacker just brings a second sybil (`2 * 2 > 3`), and at `memberCount >= 5` the stake regime
   applies over a denominator that still excludes the parent, so it buys nothing there either.
   Real liveness cost, marginal security gain.

   The underlying tension is structural: **any denominator that excludes the parent lets whoever
   dominates the smallest pool of capital govern the largest; including it makes the child
   ungovernable.** There is no purely-internal fix. The parent needs a mechanism for its own
   governance to cast the child's vote — a new mechanism on a protocol whose entire pitch is
   immutability, and therefore the user's call, not an implementer's.

   Until then: **zero sub-vaults at launch** (§2) reduces C-1's launch exploitability to zero at
   no cost, and H-4 + L-1 bound the damage if one is ever created. Note the caveat honestly —
   **H-6 means the parent may not be able to redeem out of a captured child**, so "the parent can
   react" is not a defence that currently holds.

2. **Fix H-5 and H-6.** Both live in `_settleExit`, the most delicate path in the protocol, and
   both need `VaultCore` bytes that do not currently exist. H-6 also resists the obvious fixes:
   the shortfall residual is geometric (`shortfall × f^k`), so at a 10% child fee a $1,000
   shortfall needs `k >= 9` passes to fall under the 1e-6 tolerance and `MAX_CHILDREN = 8`.
   Grossing up requires the child's perf fee on *unrealized* gain, which is not knowable at call
   time. Degrading the residue to escrow changes payout semantics. This needs design, not a
   patch — and it needs EIP-170 headroom, which may mean moving code out of `VaultCore`.

3. **Work the rest of the High tier** — H-8 (dust sybils buy the quorum regime) and H-9
   (read-only cross-contract reentrancy through look-through NAV).

4. **Rebuild `base-mainnet.json`** to the shape the contracts now demand: 5 sources per asset at
   quorum 3, `maxObservationAge <= window / 20`. Needs real addresses for two further sources per
   asset — a human task, and the reason gate 5 is NO-GO rather than pending.

5. **Re-run the full drill battery and the soak** against the corrected contracts, and redeploy
   the testnet instance. Gates 2, 3 and 6 cannot return to GO otherwise.

6. **Commission the external audit** on the corrected tree at a **new tag** — `v0.4.0-audit`
   recommended. It is a full review, and it must cover the remediation itself.

7. **One recorded restore drill** (gate 7) — ~30 minutes, no keys, unaffected by any of the
   above and doable at any time.

Only then does `v1.0.0-launch-candidate` become meaningful.
## 7. What changed in this assessment, and why it is stated so bluntly

An earlier draft of this document put the verdict at NO-GO for one reason: the audit had not been
performed. Every other row was GO, and the shortest path was described as two items, one of them
half an hour of work.

That draft was accurate about what it measured and wrong about what it implied. It measured
whether the protocol *works* — deployment, lifecycle, soak, settlement, ops — and the answer is
genuinely yes, on strong evidence. It implied readiness, and the answer to that is no, by a wide
margin.

The lesson worth carrying past this sprint: **a green board measures the tests you wrote, and the
tests you wrote encode the failures you already imagined.** Five Criticals sat underneath 189
passing tests, a clean multi-day soak, and a verified deployment. Nothing on the board was false.
The board was simply not measuring the thing that matters most before real money, and no amount
of additional green rows would have revealed that — only an adversary would, whether hired,
simulated, or uninvited.
