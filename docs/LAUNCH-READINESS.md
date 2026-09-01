# Launch readiness — mainnet go/no-go

**VERDICT: NO-GO — but every SECURITY gate is now cleared; the only remaining blockers are OPERATIONAL, and all of them need a funded Base Sepolia key.** (Current tree `protocol/main` @ `b1a8ae84`, verified green 2026-08-29: forge **319/319**, backend 551 pass / 2 skip, fmt / sizes / gas snapshot all pass.)
>
> ### 2026-08-29 — post-audit + post-pivot update (supersedes the pre-pivot narrative below)
> Two things changed since the paragraphs further down were written; where they conflict, this block wins.
>
> 1. **External audit — GO on owner attestation (gate 1).** The owner commissioned an external audit against the launch tree, has read the full report, and attests it surfaced **no major issues**. The report contains sensitive material and is **held privately** — it is deliberately not reproduced or linked here, and this document records the *attestation*, not the report. The attestation covers the launch tree **including the C-6 Chainlink pivot** — `ChainlinkOracle`, the `VaultFactory` oracle allowlist, and the `Deploy.s.sol` mainnet guard (the newest code and the delta the audit handoff flags as most important). Any Minor/Informational remediation is tracked privately by the owner. *(Basis of this row, stated for a future deployer: owner attestation, not independent inspection by the maintainer of this file.)*
> 2. **The oracle is Chainlink-direct (C-6 resolution), NOT the custom 5-source median.** `base-mainnet.json.chainlinkOracle` prices each asset from ONE genuine Chainlink Data Feed — WETH←ETH/USD, cbBTC←BTC/USD, USDC pinned, Base L2 Sequencer Uptime Feed — **on-chain-verified on Base mainnet (12/12)** and mirrored + verified on **Base Sepolia (11/11)**. This **retires** the "5 sources per asset / quorum 3 / mechanism diversity" requirement in §2 and the `base-mainnet.json` NOT-DEPLOYABLE status; those describe the removed custom aggregator. **Gate 5 is reshaped to GO with a NAMED RESIDUAL: single-provider dependency** — heartbeat + sane-price band + sequencer gate are the *only* defences against a bad Chainlink answer, and assets are limited to WETH + cbBTC (Base has no cbETH/USD feed).
>
> **Gate 0 is GO (root-only):** all five original Criticals resolved — C-1 closed at launch (`allowSubVaults = false`, confirmed on the mainnet deploy path `Deploy.s.sol:79`), C-2/C-3/C-5 fixed with tests, **C-6 resolved by the pivot**, and the external audit found no majors.
>
> **What still blocks GO — all operational, all need a funded Base Sepolia key:** gates **2/3/6** (testnet full-lifecycle + soak + canary must be **re-run on the pivoted tree** — the Sepolia oracle config now exists and is on-chain-verified, PR #64, so this is unblocked and just needs a key). Gate **7**'s restore drill is now **performed and PASSED** (`docs/RESTORE-DRILL.md`, 2026-08-30) but stays CONDITIONAL: 2 of its 6 steps are Docker-only and were substituted, so closing it needs **Docker, not a key**. **Nothing security-side remains.**
>
> ---
> *Pre-pivot narrative (retained as history — the Phase-2 remediation record). Read it for the reasoning; trust the banner above for current status.*
>
> Every launch-blocking Critical/High is resolved in code: **C-1** closed at launch (root vaults only), **C-2/C-3/C-5** + **H-1..H-4** fixed, **H-8** fixed + config-mitigated, and **C-4 → new Critical C-6** (found by an executed re-verification) resolved by **replacing the oracle**: Chainlink-direct `ChainlinkOracle` (one genuine feed per asset, no median/quorum) curated via a `VaultFactory` allowlist so the vulnerable custom aggregator is non-selectable. Sub-vault-only Highs (H-5/H-6/H-7/H-9) are dormant at launch; Mediums/Lows dispositioned.
>
> **Independent Audit Council review (adversarial, this session): ALL ACCEPT** — C-6 remediation **8.1/10**, and H-8/C-1/M-15 **9.8/10** overall, no Critical/High/Medium defects; the handful of Lows/Info surfaced were fixed. Full C-6 deploy scaffolding shipped (ChainlinkOracle + factory allowlist + `DeployChainlinkOracle.s.sol` + `verify-chainlink-oracle.mjs` + `chainlinkOracle` config block + a mainnet deploy-guard that refuses an empty allowlist + the DEPLOYMENT runbook).

An AI pre-audit run against the frozen contracts on 2026-08-25 found **41 issues: 5 Critical, 9
High, 15 Medium, 7 Low** ([AI-AUDIT-REPORT.md](audit/AI-AUDIT-REPORT.md), issues #31–#35). A
remediation pass on 2026-08-27 closed **twelve** of them.

**Closed:** C-2, C-3, C-5 (Critical); H-1, H-2, H-3, H-4 (High); M-1, M-2, M-3, M-4, M-11, M-12
(Medium); L-1, L-2, L-3, L-4 (Low). **M-6 is PARTIALLY closed** - see below. Each has `test_remediated_*` coverage, and the exploit
each replaced is preserved in git history.

**One defect closed that the audit did not find:** `proposalCooldown` was not validated at all
and is a `uint32`, so a creator could set ~136 years and make a vault unable to ever open a
second proposal. That is C-2's exact shape — an unbounded duration parameter that permanently
disables governance — on a field C-2 did not cover. Found while fixing M-6, now capped at 30 days.

**And one that changed the budget:** M-11's fix made `VaultCore` *smaller* by 336 bytes (the
bounded-assembly path is cheaper than the `abi.decode` path it replaced, and these helpers inline
at every call site). That headroom is what made M-2 affordable at all — see §5.

**C-4 is closed at `a ≤ 1` and RE-OPENED at `a ≥ 2` (C-6).** The claim below — "closed by root
cause, fixing C-3/H-1/H-2/M-1 removes the trigger" — was **inference, and the Phase-2 end-to-end
re-verification (`AuditC4EndToEnd.t.sol`) falsified it.** Against a correctly-curated oracle (one
adversarial source at most) it holds. Against two adversarial sources — cheapest case a malicious
vault creator listing two sources they control, which passes every constructor check — a single
honest leg withholding drops the fresh count to 4 and the lower median returns the attacker's quote,
re-opening C-4's measured 88.9% theft. This is the new Critical **C-6**. The custom aggregator
cannot enforce source independence, so this is a curation requirement (`quorum ≥ 2a+1`); the leading
fix is to consume Chainlink Data Feeds directly instead. Original (now-superseded) note:
all four are now fixed, so the exploitable path is closed [only when at most one source is
adversarial].
The mint-time NAV bound it suggested as defence-in-depth is **deferred**, not shipped — it needs
VaultCore bytes (only **1,014 B** of EIP-170 headroom remained on the merged tree at the time —
**~283 B at the time of writing; 4,095 B since PR #90**, see §5) and touches the
deposit path, which is not a place to add unreviewed logic; it lands in the VaultCore-headroom
sprint (#40, #32). A second layer over an already-closed path, not the fix.

**C-1 is closed at launch by "root vaults only" (2026-08-28, Phase 2).** Its own suggested
in-contract fix is wrong (§6) and there is no purely-internal fix, so `VaultFactory` ships with
`allowSubVaults = false`: no vault can create or fund a child, so the empty-electorate capture has
no target. This closes C-1 and the sub-vault-only Highs **H-5, H-6, H-7, H-9** as a class. The
sub-vault mechanism (parent-casts-child-vote) is deferred to a post-launch, post-audit release.

**Still open (affect root vaults): H-8, and the remaining Medium/Low tier** (M-5, M-7,
M-8, M-9, M-10, M-13, M-14, M-15; L-5, L-6, L-7; the informational tier), plus C-4's deferred
defence-in-depth (#32) and M-15. **H-8** (the `<5`-member stake-blind quorum regime, purchasable
for dust) is NOT sub-vault-specific and is the key open High for a root-only launch. M-7 is **not** mitigated: the new `proposalCooldown` floor raises the cost of its
propose-defeat-propose cycle but does not rate-limit it, because `lastProposalAt` is keyed
PER-PROPOSER and a second address sidesteps it entirely.

**M-6 is partially closed, and the missing half is a decision, not an omission.** Its concentration
ceiling and `proposalCooldown` bounds shipped. A floor on `proposalThresholdBps` was implemented,
measured, and **reverted**: the threshold is a fraction of live stake distribution, which a
constructor cannot see, so in a vault of 101 roughly-equal members nobody holds 1%, no member can
open any proposal, and the RuleChange that would lower it is itself a proposal. That is C-2 shape,
introduced by a remediation - in the same commit that removed C-2 shape from `proposalCooldown`.
The freeze is pinned as a passing test in `AuditProposalThresholdFloor.t.sol` so the idea is not
re-attempted blind. M-6 real defect - the shipped configs disabling their own defences - is fixed
where it lives, in the configs.

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
| 0 | **No known unfixed Critical vulnerabilities** | **GO** (root-only) — 2026-08-29 | **GO update 2026-08-29:** all five original Criticals resolved with evidence — C-1 closed at launch (`allowSubVaults = false`, confirmed on the mainnet deploy path `Deploy.s.sol:79`; `AuditRootVaultsOnly.t.sol`), C-2/C-3/C-5 fixed with remediation tests, and **C-6 resolved by the Chainlink-direct pivot** (the custom aggregator is non-selectable via the `VaultFactory` oracle allowlist). The external audit (gate 1) independently surfaced no major issues. Re-enabling sub-vaults reopens C-1 and is out of launch scope. The pre-pivot analysis in this cell is retained as history. —— **Progress, not a clean bill.** **C-1 (#33) is now closed at launch by "root vaults only"** (2026-08-28, Phase 2): the report's own `pHeld = 0` fix is wrong (breaks the legit parent+1-member child; §6) and there is no purely-internal fix, so `VaultFactory` ships `allowSubVaults = false` — `createChildVault` reverts and every vault is wired root-only, so no funded child can exist and the empty-electorate capture has no target (regression `AuditRootVaultsOnly.t.sol`). This also closes the sub-vault-only Highs H-5/H-6/H-7/H-9 as a class, so the broken `redeemFromChild` escape hatch (H-6) no longer matters at launch. C-2, C-3 (#31), C-5 (#34) were fixed with remediation tests; C-4 (#32)'s exploitable path is closed by root cause (C-3/H-1/H-2/M-1) with its defence-in-depth deferred. **This row stays NO-GO on a NEW open Critical.** The Phase-2 re-verification that this note anticipated has now RUN — and it found that the C-4 "path closed" claim was inference that fails at `a ≥ 2` adversarial oracle sources (**C-6**, `AuditC4EndToEnd.t.sol`, 7 executed tests): two controlled sources + one withholding honest leg seize the lower median and re-open C-4's 88.9% theft, through the real aggregator. C-1/C-2/C-3/C-5 now carry executed remediation evidence (`AuditRootVaultsOnly`, `Governance::test_phaseDurationHardCapsEnforced`, `AuditAggregatorDecodeBrick` ×7, `AuditVoteAfterExit`). So four of five original Criticals are closed with evidence; **C-4/C-6 keep this row NO-GO.** C-6 has no clean code fix at m=5 (fault-tolerance and Byzantine tolerance pull against each other); the leading resolution is to consume Chainlink Data Feeds directly instead of the custom aggregator, which deletes most of the oracle-finding class. Note too: re-enabling sub-vaults reopens C-1. |
| 1 | External audit completed, findings remediated | **GO** — owner-attested 2026-08-29 | **Completed.** The owner commissioned an external audit against the launch tree and attests it returned **no major issues**. The report is **held privately** (sensitive contents) and is intentionally not reproduced or linked; this row records the owner's attestation, not an inspection of the report by this file's maintainer. Scope per the owner covers the launch tree **including the C-6 Chainlink pivot** (`ChainlinkOracle` + `VaultFactory` oracle allowlist + `Deploy.s.sol` mainnet guard). Any Minor/Informational items are remediated/tracked privately by the owner. *(A future deployer relying on this row should note its basis is owner attestation.)* |
| 2 | Testnet full lifecycle proven (#15) | **GO** — re-run on the pivoted tree and PASSED 2026-09-01 | **Re-earned, not inherited.** The full lifecycle ran again against the live C-6 Chainlink-direct deployment on Base Sepolia and passed all ten phases: createVault → registerGov → deposit → activate → propose → commit → reveal → finalize → execute → exit. Vault `0x4d60…1a0f`, proposal 1, every tx hash in `scripts/.smoke-state.json` and in `docs/NOW.md`. **The exit settled Mode I for exactly 5,000,000 USDC units — an exact round trip — leaving `totalShares() == 0`,** verified by an independent `cast call` after the run rather than read from the runner. Oracle healthy throughout (`priceWad(WETH)` ~$2,414, `priceWad(LINK)` ~$11.23). **Two limits, so the row is not over-read: the sequencer guard did NOT execute** — Sepolia leaves `sequencerUptimeFeed` at `address(0)` by design, so its first real execution is still mainnet — and this was one vault, one member, one no-op rebalance; multi-vault, Mode-F and adversarial-adapter coverage belong to gate 3. *Prior run, pre-pivot:* [TESTNET-REPORT.md](TESTNET-REPORT.md): deploy block 45,784,186, all contracts Basescan-verified; full lifecycle green with an exact USDC round trip. Deployment re-verified live 2026-08-24: on-chain `codesize` of every singleton equalled what the tree built **then**. It no longer does — six contracts changed. The Base Sepolia instance is now a deployment of superseded bytecode, and this row cannot return to GO without a redeploy and a fresh lifecycle run. |
| 3 | Soak drills incl. Mode-F + sub-vault (#21) | **STALE** — unblocked; ready to re-run (needs testnet key) | [SOAK-REPORT.md](SOAK-REPORT.md): 5/5 drills passed — multi-vault aggregation, SV-7 look-through as an exact conservation law (drift 0), the full Mode-F queue→blocked→settle sequence, oracle watch with `cancelPending` **executed** to the wei, and the reference agent's first live execute-mode loop. Honest limits stated in the report (§9). **Every one of those results was earned against contracts that have since changed**, and the drills exercise exactly the paths the remediation touched — oracle quorum, Mode-F exits, rebalance execution. Re-run against the corrected contracts before this row means anything. Note also that the sub-vault drills conflict with the "zero sub-vaults at launch" parameter (§2): re-run them on testnet, deploy none on mainnet. |
| 4 | Live x402 settlement (#23) | **GO** (unaffected) | [X402-LIVE-REPORT.md](X402-LIVE-REPORT.md): real `transferWithAuthorization` on Base Sepolia, 14/14 independent `cast` checks; independently re-verified during the PR #27 review gate (balance deltas, events, nonce burn, all four domain separators re-derived). **Genuinely unaffected by the remediation** — x402 settlement is off-chain plus a USDC `transferWithAuthorization`, and touches no contract this branch changed. This is the one operational gate that survives intact. |
| 5 | Mainnet oracle stack: config verified on mainnet RPC (Chainlink-direct after C-6) | **GO** with named residual — 2026-08-29 | **Reshaped by the C-6 pivot.** The "3 mechanism-diverse classes / 5 sources per asset" criterion is **retired** with the custom aggregator; the launch oracle is `ChainlinkOracle`, pricing each asset from ONE genuine Chainlink Data Feed. `base-mainnet.json.chainlinkOracle` is populated and **on-chain-verified on Base mainnet 2026-08-29 — 12/12** (`node scripts/verify-chainlink-oracle.mjs`): WETH←ETH/USD `0x50015f8b…3a8b` (8dp, ~$2,433 fresh), cbBTC←BTC/USD `0x32F58798…Cabc` (8dp, ~$77.4k fresh), USDC pinned, Base sequencer feed `0xBCF85224…6433` (up), all inside sane-price bands. A `DeployChainlinkOracle` fork-dry-run against Base mainnet deploys a valid oracle. **NAMED RESIDUAL:** single-provider dependency — heartbeat + sane-price band + sequencer gate are the only defences against a bad Chainlink answer; a feed deprecation/freeze fails that asset *closed* (safe, no fallback); assets limited to WETH + cbBTC (no Chainlink cbETH/USD on Base). See AI-AUDIT-REPORT §C-6. **A second, distinct residual — CURATION IMMOBILITY — is registered as §4 row 12:** this row is about a bad or dead *answer* from a blessed feed; row 12 is about the absence of any path to bless a *different* oracle afterwards. The two are independent and both are accepted. |
| 6 | Canary operational | **STALE** — unblocked; re-run with the soak (needs testnet key) | Ran throughout the soak; every transition it ever recorded reconciles to a specific drill action, including dynamically discovering two new vaults on its own (SOAK-REPORT §6). The canary itself is read-only and unchanged, but its evidence came from watching the superseded contracts; it re-earns this row alongside the gate-3 re-run. **Corrected 2026-08-30:** this row was not merely stale, it was mechanically false — the flagship `oracle-freshness` signal called the retired `OracleAggregator` ABI, so on the pivoted deployment it degraded once at startup and was silent thereafter. Repaired: the signal now probes the oracle and measures `ChainlinkOracle` directly, and a detector that cannot run is paged rather than silent. The row stays STALE because it is re-earned by observation, not by code. |
| 7 | Ops runbook exercised — a restore actually performed | **CONDITIONAL** — drill performed and PASSED 2026-08-30; 4 of 6 steps followed literally | **The drill is now on the record: `docs/RESTORE-DRILL.md`.** Both state files were destroyed and restored from the ring against artifacts produced by the real daemons running on live Base Sepolia — no fixtures, nothing asserted from the test suite. **Indexer: PASS** — live snapshot truncated mid-object, `verify` reported UNUSABLE (exit 1) while still summarising 3 healthy rungs, restored from `.1` byte-identically, and the daemon came back with `knownVaults:1` seeded *from the restored file*, resumed at `lastBlock+1`, and re-indexed the 13-block loss in one 0.75s batch; counts identical to the destroyed state. Stop→head 64.5s. **Canary: PASS** — the runbook's "identical with its own paths" claim now tested, not assumed: restored state reloaded 8 tracked signals and emitted **zero duplicate pages** for the 3 already firing, which is the whole point of restoring it. **Not proven, stated so it is not over-read:** the hard kill landed ~2.4s after a completed write, in the poll sleep — the snapshot survived, but no write was in flight, so this says nothing about atomicity. **Why still CONDITIONAL, not GO:** steps 1 and 6 are `docker compose stop/start` and no Docker was available, so they were substituted with the bare-metal SIGTERM path — a runbook gap (the same document teaches a bare-metal run in §2 but gives the restore procedure no bare-metal stop/start). A row asserting "the runbook was exercised" should not go green on 4/6 literal. **Also untested:** graceful shutdown (every stop was a hard kill), production-scale state (630 bytes, 1 vault), a 15-minute-aged rung (drill ran at 20s spacing), and the off-host volume tar. See RESTORE-DRILL §5–6. **Closing this row needs Docker, not a key** — re-run steps 1/6 under Compose, or amend the runbook and re-drill. |
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

**Exit fee: `exitFeeMaxBps = 50`, decay 604,800 s (7 days) — the values `base-mainnet.json`
`smoke.exitFeeDecayPeriod` deploys.** The protocol cap is 100 bps; 50 is the value exercised
end-to-end in the soak, and it leaves headroom for a child vault (stacked cap 50+25=75 ≤ 100 was
proven live, SOAK-REPORT §2). **Decay-period flag (2026-09-01):** this paragraph previously said
302,400 s (3.5 days). That figure was never what the 50 bps vault ran: the Sepolia smoke vault
deployed from `base-sepolia.json` at 604,800 s, and only the 25 bps soak drill vaults
(`scripts/soak/soak-vaults.json`) used 302,400 s. Finance flagged the contradiction (Member Cost
and the HWM; Fee Model Sensitivities) without resolving it. Whether 3.5 d or 7 d is the intended
launch value is an owner launch-parameter decision still open; until it is made, this document
states the config's value because the config is what deploys, and
`scripts/test/config-doc-truth.test.mjs` pins the two together.

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

**[superseded 2026-08-29 — the launch basket is WETH + cbBTC; Base publishes no cbETH/USD feed, only cbETH/ETH, and the TWAP source this paragraph describes is retired; see the top banner, gate 5 and `docs/vault/go-to-market-plan.md`. Retained as history.]** ~~First baskets: WETH + cbETH — majors only.~~ The TWAP source quantizes at $1e-6, a listing
constraint below ~$0.01/token (filed at PR #25). No asset outside the verified config, no
low-priced assets, until a second verification pass and a deliberate listing decision.

**[SUPERSEDED 2026-08-29 — the C-6 Chainlink-direct pivot retired this entire multi-source model; see the top banner and gate 5. The launch oracle prices each asset from ONE genuine Chainlink Data Feed, so "five sources per asset" no longer applies and `base-mainnet.json` is deployable and on-chain-verified. Paragraph retained as history.]** ~~Each of those two assets now needs FIVE price sources, not three~~ (H-1: quorum must reach
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

> **⚠ Rows 3–6 describe the RETIRED oracle and are no longer live risks (marked 2026-08-30).**
> They were written against the bespoke 5-source median, which the C-6 pivot removed; there is no
> TWAP leg, no Pyth leg and no quorum on the launch path. They are kept because they are part of
> the reasoning record, each prefixed with a **RETIRED** marker. The risks that replace them are
> **row 13 (single-provider Chainlink dependency)** and **row 12 (curation immobility)**.

| # | Risk | Worst case | Why ship anyway |
| --- | --- | --- | --- |
| 1 | **Immutability itself** | A critical bug that survives review is permanent; funds in affected vaults may be unrecoverable | **This row is no longer hypothetical, and its cost is now itemised.** Five Criticals were found in the frozen tree. Twelve findings have since been fixed — every fix requiring a full redeploy, because nothing can be patched — and C-1 remains open because its own suggested fix was wrong. The remediation is itself evidence for this row: the tree changed six contracts, which invalidated the testnet deployment, the soak and the canary evidence in one move. Mitigation is the audit (gate 1), the remaining remediation (gate 0), small staged caps, and re-earning the operational gates |
| 2 | **Oracle freeze (K-4)** | All capital in a vault frozen for the duration of a staleness event — exits included, no hatch | Freezing beats mispricing. **⚠ POST-PIVOT (2026-08-30): the justification below described the retired 5-source median.** On the launch oracle a freeze has exactly four causes — the asset's single feed past its heartbeat, a price outside the sane band, the L2 sequencer down or inside its grace period, or the feed dead/unlisted — and there is no second source to absorb any of them (see row 13). `cancelPending` (the one guaranteed path, for unactivated deposits) reads no oracle, **executed live** in the soak; playbook §1. Note the canary's `oracle-freshness` signal has NOT been ported and emits `skipped` on a launch vault, so it does not alert on this today. *Retired reasoning:* quorum 3 with a 5-source set tripped after three failures rather than two, and the TWAP leg withheld on a quiet pool instead of quoting a stale tick as fresh (H-2). More withholding was the price of never returning a wrong price |
| 3 | ⚠ **RETIRED with the aggregator (C-6) — not a live risk.** **TWAP leg prices USDC at $1.00** | A sustained USDC depeg mis-prices that leg by exactly the depeg | A 3-of-5 quorum outvotes the pinned leg with room to spare — and unlike the old 2-of-3, the median is a genuine median at every reachable `k` (H-1), so the pinned leg can no longer *become* the price by being the lower of two. Reference feeds for off-chain depeg monitoring are named in the config; measuring USDC on-chain would reintroduce the push-feed dependency the TWAP leg exists to avoid |
| 4 | ⚠ **RETIRED with the aggregator (C-6) — not a live risk.** **One WETH/USDC pool serves TWAP legs of both launch assets** | That pool going quiet withdraws a source from both assets at once | Disclosed in the config rather than hidden. **This got materially safer and materially more likely at once:** a quiet pool now makes the TWAP leg WITHHOLD rather than quote a stale tick as fresh (H-2), so correlated withdrawal is a correlated *freeze* rather than a correlated *wrong price* — and at 5 sources there are two of headroom to absorb it. Pool cardinality 5000 verified on-chain |
| 5 | ⚠ **RETIRED with the aggregator (C-6) — not a live risk.** **Pyth is pull-based** | An unfunded keeper lets the pull leg silently lapse, costing one of the five sources | The 3,600 s staleness bound was chosen *for* this (test-asserted). What changed: lapsing used to demote 2-of-3 to a two-element "median" that was a minimum; it now costs one of two spare sources and the price stays a real median. Keeper funding remains an explicit launch-ops item; canary watches per-source freshness |
| 6 | ⚠ **RETIRED with the aggregator (C-6) — not a live risk.** **TWAP output quantized at $1e-6** | Wrong-but-plausible prices for assets under ~$0.01 | Majors-only baskets at launch; filed as a listing constraint, not a code fix, deliberately (precision trades against overflow headroom) |
| 7 | **x402 returns on broadcast, not finality** | A reorg un-settles a paid read that was already served (~seconds of exposure) | Pennies per read; an operator needing finality can configure a confirmation wait and pay the latency |
| 8 | **Replay defenses are layered, not duplicated** | The API's seen-nonce set is process-local and resets on restart | The chain's `authorizationState` is the authority and survives everything — proven live (nonce burned, resubmission refused). The challenge nonce is advisory, documented as such |
| 9 | **EE-6/E5 child-escrow asymmetry** | A child persistently escrowing an in-kind slice back to a blacklisted parent turns parent exits into reverts | Known residual from the Sprint-6 review; launch baskets and single-level sub-vault plans keep the surface minimal; a deferred-claim mechanism is the eventual fix |
| 10 | **Vendored GPL-2.0-or-later / MIT math under a BUSL repo** | License challenge to the distribution | Counsel question, flagged in the audit handoff; not a deployment-mechanics risk |
| 11 | **The reference agent is not audited product** | Two launch-class bugs (an inert policy flag; deposits that could never succeed) were found only by running it live in the soak | Both fixed with regression tests — but the finding argues the agent ships as *reference code, beta*, outside the contract-audit scope, and says so |
| 12 | **Curation immobility — there is no oracle rotation path** | Chainlink deprecates a blessed feed, or a blessed `ChainlinkOracle` instance turns out to be defective. The C-6 allowlist is fixed in `VaultFactory`'s constructor — no add, no remove, no owner — so no replacement can ever be blessed on that factory, and the affected asset becomes unlistable for new vaults until a factory redeploy | **State the fact plainly first, because the intuitive framing is wrong: a rotation lever would not rescue a single stuck dollar.** `VaultCore.oracle` is `immutable` and pinned at construction; `Governance` has zero oracle references and no oracle-shaped proposal type; the allowlist is read only by `_requireAllowedOracle`, called only from `createVault`/`createChildVault`. So the allowlist governs **new vault creation and nothing else** — every deployed vault is pinned to its own oracle whatever any allowlist says, and a deprecated feed freezes it under row 2 (K-4/SF-2) with or without a lever. Executed evidence: `test/audit/AuditOracleRotation.t.sol` (3 tests) — the vault exposes no oracle mutator and the factory no allowlist mutator to any caller; a successor factory that blesses a healthy replacement *and de-blesses the old oracle* leaves the existing vault untouched and still pricing through its dead one. What a lever would buy is therefore only "future creators may select a different oracle" — which a plain **factory redeploy already achieves**. Weighed against that: an owner able to bless is an owner able to bless a `ChainlinkOracle` over a **fake** `AggregatorV3`, which is exactly the C-6 vector the allowlist exists to close, and it would be the protocol's **first standing privileged role** (there is no `Ownable`, owner or admin anywhere in `src/` — only one-shot `wire` calls that lock forever). Append-only is not the safe half of that trade: since de-blessing harms nobody on-chain, "append-only" removes the harmless power and keeps the dangerous one. (Checked, not assumed: nothing off-chain reads `isAllowedOracle` at RUNTIME either — the only consumers are deploy-time assertions, `DeployTestnet.s.sol:146` and the `config/deployments/base-sepolia.json` verification record, so de-blessing has no indexer/canary/API semantics to break.) This is CM-8/K-2 exactly — "near-immutability is the intent; documented so no future sprint 'fixes' it with a bypass that becomes the actual attack surface" — and row 1's accepted cost, applied to curation. **Cost of the redeploy route, priced, not hand-waved:** `OperatorRegistry.wire` is one-shot and deployer-gated, so a replacement factory cannot attest into the canonical registry — operator identity, the leaderboard (SF-4/SF-5) and the HWM loss carryforward (§7, CM-5) restart in a fresh registry, and the two vault populations become disjoint reputation universes (third test above). **Mitigating fact:** `_requireOracleCoversBasket` probes `priceWad` at creation, so a deprecated feed makes new vault creation against that oracle **fail loudly** rather than silently deploy a brick — the failure mode is "that asset is unlistable until a redeploy", never "broken vaults ship". Ships as accepted: no lever, staged caps, and a redeploy runbook if a feed is ever retired |
| 13 | **Single-provider dependency — the launch oracle is Chainlink and only Chainlink** | A Chainlink feed reports a plausible-but-wrong price that sits inside its heartbeat and inside the sane-price band. Nothing in the protocol contradicts it: NAV, share issuance, exit value and the rebalance slippage bound all read that one number, and a vault can be entered or exited at it. Separately, a feed deprecation or freeze fails that asset **CLOSED with no fallback** — every NAV path in a vault holding it, exits included, reverts until the feed recovers | **Named residual on gate 5, accepted deliberately.** C-6 proved the alternative — a bespoke median over a curated source set — could not be secured by curation, so the trade is a single well-run provider against a multi-source scheme an adversarial creator can own. Chainlink's decentralization lives at its own OCR node-operator layer, not in our contract. The **only** protocol-side defences are the L2 sequencer uptime gate (grace anchored on `startedAt`, evidenced against three real Base outages in `ChainlinkOracleSequencerFork.t.sol`), the per-feed heartbeat, and the sane-price band — which is specifically the defence against a feed reporting a deprecated min/maxAnswer clamp during a depeg or flash crash. Feed **denomination** is checked on-chain at construction (ASSET/USD only), which is why cbETH is not listed: Base publishes only `CBETH / ETH`. Asset universe is bounded to WETH + cbBTC as a direct consequence. Member-side defence against a bad price at entry is M-15's `minSharesOut`; there is none on the exit side (dropped for the `VaultCore` byte budget) |

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

> **⚠ CORRECTION, 2026-08-30 — the table above is a dated record, not the current tree.**
> `VaultCore`'s live EIP-170 margin is **4,095 B** since PR #90 (2026-09-01). It was **283 B**
> when this note was written — measured 2026-08-30 and recorded in the
> knowledge vault; not re-measured in this edit, since `forge build --sizes` cannot run while the
> tree does not build — see PR #82), not the 1,014 B recorded here (nor the 1,182 B
> quoted in the H-5/H-6 notes, which was an intermediate value mid-session). M-15's
> `deposit(uint256,uint256)` overload landed after this battery ran and spent **731 B**. The record
> above is left intact deliberately — it is what the battery measured at this ref — but any
> decision about whether a `VaultCore` change *fits* must use the CURRENT margin, and that is now
> **4,095 B**, not 283 B.
>
> **⚠ SECOND CORRECTION, 2026-09-01 — this block contradicted itself and the second half was
> stale.** It opened with 4,095 B and then told the reader to size changes against 283 B, which was
> true only between 2026-08-30 and PR #90. Re-measured on this branch with
> `cd contracts && forge build --sizes`: **`VaultCore` runtime 20,481 B, margin 4,095 B.** So the
> sentence that followed — "at that margin, anything `VaultCore`-shaped is effectively closed,
> which reshapes the H-5/H-6 deferral: it is now a size wall as much as a sub-vault-dormancy
> choice" — **no longer holds. The size wall is gone; the dormancy is not.** H-5/H-6/H-9 stay
> deferred because `allowSubVaults = false` makes them unreachable at launch (they all require a
> funded child — AI-AUDIT-REPORT §"Phase-2 disposition"), *not* because they will not fit. Do not
> cite EIP-170 headroom as the reason they are open. Note also that **M-15 has since landed** and
> is no longer in the unfixed set below.
>
> Two further rows in that table were also read wrongly by later sessions and are corrected here:
> **`VaultFactory` is not tight** (3,572 B used, **21,004 B spare**) and **`ChainlinkOracle` is not
> tight** (1,532 B used, **23,044 B spare**) — a constructor check assumed unaffordable in
> `ChainlinkOracle` turned out to cost **zero runtime bytes**, being initcode-only.
> `UniswapV3TwapSource` and `OracleAggregator` have since left the deployable set entirely
> (retired to `contracts/test/retired/`), so their rows describe contracts that are no longer
> built for deployment.

**H-5, H-6, H-9 and M-15 remained unfixed for this reason at the time of this battery** — they all
land in `VaultCore`, and several would not fit even alone. *(Superseded on both counts, 2026-09-01:
M-15 landed, and PR #90 reclaimed the margin to 4,095 B, so size is no longer the reason. What
keeps H-5/H-6/H-9 out of scope is that `allowSubVaults = false` makes them unreachable at launch —
see the correction block above.)* `Governance` net *shrank* across the session despite gaining
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

### Current remaining path (2026-08-29) — security done; operational only

Every security item below (steps 1–4, 6 of the historical list) is now closed: C-1 decided, the oracle pivoted to Chainlink-direct and on-chain-verified, and the external audit completed (owner-attested, no majors). What remains needs a **funded Base Sepolia key** and is the owner's to trigger:

1. **Re-run testnet lifecycle + soak + canary on the pivoted tree (gates 2/3/6).** Deploy the current tree to Base Sepolia with the now-verified `chainlinkOracle` config (PR #64), then run the lifecycle + the drill battery + the canary. Unblocked — needs only the key. *(Step-by-step lives in [DEPLOYMENT.md](DEPLOYMENT.md); the maintainer will hand the owner an exact command list when the key is available.)*
2. **Close gate 7** — the restore drill is **done and PASSED** (`docs/RESTORE-DRILL.md`). What remains is re-running its steps 1/6 under Docker Compose, or amending the runbook to document a bare-metal stop/start and re-drilling. Needs Docker, not a key.
3. **Then cut `v1.0.0-launch-candidate`** and proceed to the mainnet deploy sequence (owner's key).

Mainnet deploy itself (singletons → blessed `ChainlinkOracle` → factory with `BLESSED_ORACLES` → first vault) is the final owner-key step, gated on the above.

---
*Historical path (retained; steps 1–4 and 6 are now DONE — see the current path above and the top banner):*

Shorter than it was, and still not short.

1. **C-1 (#33) — DECIDED and closed at launch (2026-08-28, Phase 2: "root vaults only").** This
   was a design decision, not a coding task. The report's suggested fix (`pHeld = 0`, counting the
   parent as a member) was implemented and analysed, and **it does not work**: at parent + 1 member
   the signer regime needs `1 * 2 > 2`, which is false, so the legitimate child canonised by
   `test_childRuleChangePassesAfterParentAllocates` could no longer pass a Rebalance — while an
   attacker just brings a second sybil (`2 * 2 > 3`), and at `memberCount >= 5` the stake regime
   applies over a denominator that still excludes the parent, so it buys nothing there either.
   Real liveness cost, marginal security gain.

   The underlying tension is structural: **any denominator that excludes the parent lets whoever
   dominates the smallest pool of capital govern the largest; including it makes the child
   ungovernable.** There is no purely-internal fix. The parent needs a mechanism for its own
   governance to cast the child's vote — a new mechanism, deferred to a post-launch, post-audit
   release. **The owner's decision was to disable sub-vaults at launch rather than build that
   mechanism now:** `VaultFactory.allowSubVaults = false` makes `createChildVault` revert and wires
   every vault root-only, so the empty-electorate capture has no target. This closes C-1 and the
   sub-vault-only Highs H-5/H-6/H-7/H-9 as a class (regression `AuditRootVaultsOnly.t.sol`), which
   is also why the broken `redeemFromChild` escape hatch (H-6) no longer matters at launch. Gate 0
   is now GO for a root-only deployment. Re-enabling sub-vaults reopens C-1 until the mechanism is
   built and audited. Historical caveat, still true for any future sub-vault release —
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

7. **Close gate 7** (the drill itself is **done and PASSED**, `docs/RESTORE-DRILL.md`) — re-run
   its two Docker-only steps under Compose, or amend the runbook and re-drill. Needs Docker,
   not a key; unaffected by any of the above.

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
