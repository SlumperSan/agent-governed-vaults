# Launch readiness — mainnet go/no-go

**VERDICT: NO-GO.** The external audit has not been performed. One row below is NO-GO and one is
CONDITIONAL; everything else is GO with evidence. The shortest path to GO is at the bottom and
contains exactly two items, one of which takes half an hour.

Evidence-based per issue [#24](https://github.com/SlumperSan/agent-governed-vaults/issues/24):
every row names a verifiable artifact — a report, a tag, a transaction, a CI run — and anything
unverifiable is marked NO-GO or CONDITIONAL, never assumed. Assessed 2026-08-25 at
`protocol/main` = `ad9396d7`, audit tag `v0.3.0-audit`.

## 1. Go/no-go checklist

| # | Gate | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | External audit completed, findings remediated | **NO-GO** | Engagement not yet started. The package shipped 2026-08-25 at tag `v0.3.0-audit` (22 contract files — including the Sprint-11 oracle sources a `v0.2.0-audit` scope would have silently excluded; [AUDIT-HANDOFF.md](AUDIT-HANDOFF.md)). **An immutable protocol with real money and no external review is a NO-GO headline, not a footnote.** |
| 2 | Testnet full lifecycle proven (#15) | **GO** | [TESTNET-REPORT.md](TESTNET-REPORT.md): deploy block 45,784,186, all contracts Basescan-verified; full lifecycle green with an exact USDC round trip. Deployment re-verified live 2026-08-24: on-chain `codesize` of every singleton equals what this tree builds. |
| 3 | Soak drills incl. Mode-F + sub-vault (#21) | **GO** | [SOAK-REPORT.md](SOAK-REPORT.md): 5/5 drills passed — multi-vault aggregation, SV-7 look-through as an exact conservation law (drift 0), the full Mode-F queue→blocked→settle sequence, oracle watch with `cancelPending` **executed** to the wei, and the reference agent's first live execute-mode loop. Honest limits stated in the report (§9). |
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
| 1 | **Immutability itself** | A critical bug that survives the audit is permanent; funds in affected vaults may be unrecoverable | The audit (gate 1), small staged caps, and the strongest testnet record we could produce. This is the protocol's core trade, made openly |
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

## 6. The shortest path to GO

1. **The audit** (gate 1) — package is in the firm's hands as of 2026-08-25; on findings:
   contracts are frozen, so every finding becomes remediate-and-redeploy or accept-with-reasons,
   and this document's verdict flips only when each is closed on the record.
2. **One recorded restore drill** (gate 7) — ~30 minutes: corrupt a copy of the indexer state,
   restore from the backup ring, `verify`, diff against a fresh backfill. No keys, no chain
   writes.

Nothing else stands between this repository and mainnet. When both close, cut
`v1.0.0-launch-candidate`, re-run this battery at the tag, and the remaining steps are the
human-only ones in DEPLOYMENT.md: fund the deployer, deploy, verify, wire, and walk the caps up
vault by vault.
