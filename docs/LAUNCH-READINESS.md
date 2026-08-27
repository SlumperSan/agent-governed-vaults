# Launch readiness — mainnet go/no-go

**VERDICT: NO-GO — five confirmed Critical vulnerabilities, four of them unfixed.**

This is not the "audit hasn't happened yet" NO-GO this document originally carried. An AI
pre-audit run against the frozen contracts on 2026-08-25 found **41 issues: 5 Critical, 9 High,
15 Medium, 7 Low** ([AI-AUDIT-REPORT.md](audit/AI-AUDIT-REPORT.md), issues #31–#35), with **33
executing exploit tests** committed under `contracts/test/audit/`. C-2 is fixed; **C-1, C-3, C-4
and C-5 are open.** Two of them lose member funds outright.

**Read this before anything else in the document:** every "GO" row below was earned by evidence
of *correct operation* — deployment, lifecycle, soak, settlement. None of it is evidence of
*security*, and the two are not substitutes. The clearest demonstration is that the protocol's
own 189 tests and all 33 exploit tests pass **simultaneously**: the suite was never structured
to catch this class. A green board and an exploitable protocol are entirely compatible, and both
are true here.

Evidence-based per issue [#24](https://github.com/SlumperSan/agent-governed-vaults/issues/24):
every row names a verifiable artifact — a report, a tag, a transaction, a CI run — and anything
unverifiable is marked NO-GO or CONDITIONAL, never assumed. Assessed 2026-08-25 at
`protocol/main` = `ad9396d7`. **The `v0.3.0-audit` tag is withdrawn as an engagement reference**
(gate 1); it remains a valid historical marker of the pre-remediation tree.

## 1. Go/no-go checklist

| # | Gate | Verdict | Evidence |
| --- | --- | --- | --- |
| 0 | **No known unfixed Critical vulnerabilities** | **NO-GO** | **4 open Criticals.** C-1 (#33) a funded sub-vault has an empty electorate — capture for one minimum deposit, and capture equals drain because `minAmountOut` is proposer-supplied; C-3 (#31) one malformed source permanently bricks pricing for every vault on the aggregator; C-4 (#32) a depressed price mints excess shares atomically — measured **−88.9%** of a victim's stake; C-5 (#34) voting weight survives a full exit. C-2 fixed (PR #36). Each has an executing test in `contracts/test/audit/`. |
| 1 | External audit completed, findings remediated | **NO-GO** | Not started — and **must not be commissioned against `v0.3.0-audit`**, which contains all five Criticals. That tag is withdrawn as an engagement reference. The corrected tree will differ materially across `Governance`, `OracleAggregator`, `UniswapV3TwapSource`, `VaultCore`, `SafeTransferLib` and `VaultFactory`, so the engagement is a **full** review, not a delta. |
| 2 | Testnet full lifecycle proven (#15) | **GO** | [TESTNET-REPORT.md](TESTNET-REPORT.md): deploy block 45,784,186, all contracts Basescan-verified; full lifecycle green with an exact USDC round trip. Deployment re-verified live 2026-08-24: on-chain `codesize` of every singleton equals what this tree builds. |
| 3 | Soak drills incl. Mode-F + sub-vault (#21) | **GO** (correctness only — see gate 0) | [SOAK-REPORT.md](SOAK-REPORT.md): 5/5 drills passed — multi-vault aggregation, SV-7 look-through as an exact conservation law (drift 0), the full Mode-F queue→blocked→settle sequence, oracle watch with `cancelPending` **executed** to the wei, and the reference agent's first live execute-mode loop. Honest limits stated in the report (§9). |
| 4 | Live x402 settlement (#23) | **GO** | [X402-LIVE-REPORT.md](X402-LIVE-REPORT.md): real `transferWithAuthorization` on Base Sepolia, 14/14 independent `cast` checks; independently re-verified during the PR #27 review gate (balance deltas, events, nonce burn, all four domain separators re-derived). |
| 5 | Mainnet oracle stack: 3 mechanism-diverse classes, config verified on mainnet RPC | **GO** | Contracts: Sprint 11 (PR #25, 189 forge tests, TWAP math re-derived independently at review). Config: `contracts/config/base-mainnet.json` is **VERIFIED-ON-CHAIN — 22/22 checks at Base mainnet block 50,412,867** (`scripts/verify-mainnet-config.mjs`; re-run it before deploying, it is read-only). |
| 6 | Canary operational | **GO** | Ran throughout the soak; every transition it ever recorded reconciles to a specific drill action, including dynamically discovering two new vaults on its own (SOAK-REPORT §6). |
| 7 | Ops runbook exercised — a restore actually performed | **CONDITIONAL** | Sprint 13 shipped the backup ring + `verify` subcommands with tests, and the soak restarted services freely — but **a deliberate restore-from-backup drill has not been recorded**. ~30 minutes, read-only, no keys. Until performed, "restore works" is a test-suite claim, not an operational one. |
| 8 | All CI gates green at the candidate ref | **GO** (at the current ref) | CI run `32848131465` on `ad9396d7`: backend, contracts (forge fmt/build/sizes/test/gas-gate), slither — all green. Local battery on this branch: backend **504 tests, 503 pass, 1 skip** (the Windows-only SIGTERM test that executes on Linux CI). The `v1.0.0-launch-candidate` tag is deliberately **not cut** — #24 permits it only when every row is GO. |

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
advances when someone pays to post, so a tight bound silently demotes 2-of-3 to 2-of-2 with no
failure headroom (asserted in `test_tightStalenessSilentlyDemotesPullLegAndRemovesHeadroom`; the
live cbETH Pyth price was 2,549 s old at config verification). Tighten only after funding a
keeper at a measured cadence. **Operational corollary: push fresh Pyth updates for both price
ids immediately before deploy, or PythSource withholds from the first read.**

**First baskets: WETH + cbETH, exactly as verified in `base-mainnet.json` — majors only.** The
TWAP source quantizes at $1e-6, a listing constraint below ~$0.01/token (filed at PR #25). No
asset outside the verified config, no low-priced assets, until a second verification pass and a
deliberate listing decision.

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
| 1 | **Immutability itself** | A critical bug that survives review is permanent; funds in affected vaults may be unrecoverable | **This row is no longer hypothetical.** Five Criticals were found in the frozen tree, four still open — every one requiring redeploy because nothing can be patched. Mitigation is the audit (gate 1), remediation (gate 0), small staged caps, and the testnet record. The trade is made openly, and its cost is now measured rather than assumed |
| 2 | **Oracle freeze (K-4)** | All capital in a vault frozen for the duration of a staleness event — exits included, no hatch | Freezing beats mispricing. Three mechanism-diverse sources at 2-of-3 on mainnet; `cancelPending` (the one guaranteed path, for unactivated deposits) **executed live** in the soak; canary alerts; playbook §1 |
| 3 | **TWAP leg prices USDC at $1.00** | A sustained USDC depeg mis-prices that leg by exactly the depeg | 2-of-3 quorum outvotes the pinned leg; the two reference feeds for off-chain depeg monitoring are named in the config; measuring USDC on-chain would reintroduce the push-feed dependency the TWAP leg exists to avoid |
| 4 | **One WETH/USDC pool serves TWAP legs of both launch assets** | That pool going quiet withdraws a source from both assets at once | Disclosed in the config rather than hidden; quorum headroom holds (2-of-3 remains); pool cardinality 5000 verified on-chain |
| 5 | **Pyth is pull-based** | An unfunded keeper lets the pull leg silently lapse; 2-of-3 becomes 2-of-2 with no headroom | The 3,600 s staleness bound was chosen *for* this (test-asserted); keeper funding is an explicit launch-ops item; canary watches per-source freshness |
| 6 | **TWAP output quantized at $1e-6** | Wrong-but-plausible prices for assets under ~$0.01 | Majors-only baskets at launch; filed as a listing constraint, not a code fix, deliberately (precision trades against overflow headroom) |
| 7 | **x402 returns on broadcast, not finality** | A reorg un-settles a paid read that was already served (~seconds of exposure) | Pennies per read; an operator needing finality can configure a confirmation wait and pay the latency |
| 8 | **Replay defenses are layered, not duplicated** | The API's seen-nonce set is process-local and resets on restart | The chain's `authorizationState` is the authority and survives everything — proven live (nonce burned, resubmission refused). The challenge nonce is advisory, documented as such |
| 9 | **EE-6/E5 child-escrow asymmetry** | A child persistently escrowing an in-kind slice back to a blacklisted parent turns parent exits into reverts | Known residual from the Sprint-6 review; launch baskets and single-level sub-vault plans keep the surface minimal; a deferred-claim mechanism is the eventual fix |
| 10 | **Vendored GPL-2.0-or-later / MIT math under a BUSL repo** | License challenge to the distribution | Counsel question, flagged in the audit handoff; not a deployment-mechanics risk |
| 11 | **The reference agent is not audited product** | Two launch-class bugs (an inert policy flag; deposits that could never succeed) were found only by running it live in the soak | Both fixed with regression tests — but the finding argues the agent ships as *reference code, beta*, outside the contract-audit scope, and says so |

## 5. Battery record at this ref

| Gate | Result | Where |
| --- | --- | --- |
| backend (`npm run test:backend`) | **504 tests, 503 pass, 0 fail, 1 skip** (Windows-only SIGTERM; executes on Linux CI) | local, this branch |
| forge fmt / build --sizes / test / gas gate | **green — 189 tests** | CI run `32848131465` at `ad9396d7` (contracts untouched by this branch) |
| slither | green | same run |
| mainnet config | 22/22 at block 50,412,867 | `scripts/verify-mainnet-config.mjs` |

## 6. The path to GO

The order matters, and it is longer than this document originally claimed.

1. **Remediate the four open Criticals.** C-3 and C-5 are self-contained. **C-1 must not be
   rushed** — the report is explicit that its own suggested fix does not preserve GA-1, so it
   reopens a design decision and is the likeliest place to introduce Critical #6. C-4 is largely
   *consequential*: fixing C-3, H-1, H-2 and M-1 removes its trigger, with a mint-time NAV bound
   as defence in depth.
2. **Work the High tier (#35) — and treat H-3 as structural.** H-3 says the repo's own V3 mock
   makes an entire defect class undetectable by its own suite. Replace the mock, re-run, and
   treat every new failure as a finding. Related: **eight documented threat-model mitigations do
   not hold as written**, several naming the exact attack that defeats them. The threat model is
   unusually thorough, which is what makes trusting it dangerous.
3. **Re-run the full drill battery** against the corrected contracts. Every result in
   SOAK-REPORT.md was earned against code that is about to change.
4. **Commission the external audit** on the corrected tree, at a **new tag**.
5. **One recorded restore drill** (gate 7) — ~30 minutes, no keys, no chain writes. Unaffected by
   any of the above and can be done at any time.

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
