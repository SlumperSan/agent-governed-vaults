# RWAlly — Agent-Governed Index Vault Protocol

**Index funds that argue for themselves.**

RWAlly is the AI agent trading index. An AI picks the basket. The members whose money it is vote on
it. What this vault invests in is decided by vote, and every decision stays on-chain where anyone
can check it.

A vault is a pool of USDC, a basket of spot crypto, and one rule: what it invests in is decided by
vote.
Members pool USDC and ratify every rebalance by on-chain vote. Proposal rights follow stake, not
operatorship — the AI operator proposes as a member, from its own position, and operatorship
confers no authority to vote, execute, pause, reprice, or move member funds.

Settlement is USDC on Arc, Circle's chain, where USDC is also the native gas asset. The basket is a
single asset — **cirBTC**, a wrapped Bitcoin on Arc — priced from Chainlink's `BTC / USD` feed.
There is no ETH leg: every ETH-named token with a Uniswap v3 pool on Arc holds under $452 of
depth. The contracts carry no
chain-specific code, so the same immutable bytecode is deployable on any EVM chain. No centralised
exchanges anywhere in the design.

**Built for Arc, and not yet deployed there.** The contracts are written, reviewed and tested; no
instance of this protocol exists on Arc or on any other mainnet. Read [Status](#status) before
anything else in this file.

## Why it exists

The S&P 500 works because someone writes the weights down and everyone can check them. There is no
such list for AI. Plenty of bots trade — none of them have to explain the position in public and
win a vote before taking it.

A vault is that list, made checkable. An operator proposes a basket and a weighting. The members
vote it up or down by commit-reveal. What executes is recorded on-chain next to the proposal that
asked for it and the votes that carried it. So the holdings are not an opinion anyone published:
they are a timestamped record of what an operator proposed and what members were willing to fund,
on contracts that cannot be edited afterwards.

That record is exactly what it says and nothing more. It is not a claim that the conviction was
correct, and it is not a forecast.

### What you actually do with one

| Step | Who can do it | What happens |
| --- | --- | --- |
| **Put USDC in** | Only you | Your first deposit is held for four hours before it becomes anything. It is not shares yet and it does not vote. You can cancel and take it back at any point in that window — the one action that keeps working even if the vault freezes. |
| **Activate it** | **You or anyone** | Once the four hours elapse, the deposit can be activated by any caller, not just you. The shares mint to **you** either way — but they are priced at the moment the call is made, not the moment you deposited, so you do not choose that price. |
| **Vote on every trade** | You, or someone you authorised | The operator proposes a basket. You commit a hashed vote, then reveal. The vault does not buy or sell into that basket until enough members say yes. If you appoint a delegate or set a standing default, anyone may then apply your weight on your behalf — and committing your own vote always overrides it. |
| **Ask to leave** | Only you | No one can refuse you — not the operator, not the other members. (One exception, and it is the vault's creator, not you: see below.) You are paid **in kind**: a pro-rata slice of everything the vault holds, plus its idle USDC. It does not come back as cash without a separate sale. |
| **Settle a queued exit** | **You or anyone** | If a live vote queued your exit, settling it is a separate call that anybody can make — and until somebody does, those shares are locked and do not vote. |

**Four calls can be made by a stranger, and you can read which off the signatures.**
`activate(address)`, `settleQueuedExit(address)`, `revealDelegated(uint256, address)` and
`applyStandingDefault(uint256, address)` all take *your* address, so any caller may trigger them on
your behalf — the last two only once you have appointed a delegate or set a standing default.
`deposit`, `cancelPending`, `skipWindow` and `requestExit` take no address at all; `setDelegate` and
`setStandingDefault` take a vault address and one more parameter that is never you. All six act on
whoever calls them, so only you can.

**The test is not "does it take an address" — it is "does a parameter name the member whose position
or weight is affected".** `claimEscrowed(address asset)` is the case that proves the difference: it
takes an address, that address is a token, and anyone calling it is paid only their own escrow,
never yours.

**A permissionless caller cannot redirect your payout**: it goes to you, less the fees the vault
charges on any exit whether you call it yourself or not. What the caller controls is *when* — and
timing sets the price, which sets the realised gain, which sets the performance fee. So it is not
fee-neutral, and that is the part worth knowing.

**Two things delay an exit, and neither is a veto.** If a vote is live, your exit is queued from the
reveal phase and settles at the price *after* that vote executes — including a vote that goes on to
be defeated. And if a Chainlink feed goes stale or implausible, the vault freezes rather than price
off bad data; that freeze includes exits, and it lifts when the feed recovers.

**One thing is a hard block, and it applies only to the vault's creator.** A creator cannot exit
below 5% of the vault while any other member remains — `_checkCreatorGate` reverts
`CreatorStakeGate()`, checked when the exit is *requested* rather than when it settles, so it cannot
be dodged by queueing. That is the creator's skin-in-the-game commitment, it binds nobody else, and
it is a refusal rather than a delay.

All three are the safety design working, and all three are described exactly in
[Contracts](#contracts).

Two fees, both readable in the contracts: a **10% performance fee** on realised gains, paid to the
operator, charged on exit against a high-water mark; and an **exit fee of up to 1%** that decays
with tenure, retained by the vault so it accrues to the members who stay. A sole holder pays no
exit fee.

## Status

**Not deployed on any mainnet.** Arc is the target chain and the protocol is not on it yet. The
Arc survey — chain binding, the USDC predeploy and the four Chainlink feeds, each read from chain
5042 rather than copied from documentation — is
[`docs/evidence/arc-mainnet-survey.json`](docs/evidence/arc-mainnet-survey.json). It is a survey
and not a deployable configuration: the Uniswap router and the basket token addresses on Arc are
still unresolved, and the file says so. The steps between here and a deploy are
[`docs/evidence/arc-deploy-runbook.md`](docs/evidence/arc-deploy-runbook.md).

**Arc testnet is not a dry run, and that is measured rather than assumed.** Chain 5042002 carries
the USDC predeploy, Permit2 and Multicall3 and nothing else this protocol needs: no Uniswap, no
Pyth, no CCTP, and Chainlink publishes no feeds for it at all. `ChainlinkOracle` requires a genuine
feed per asset and fails closed without one, so a deploy there could only stand up against mocks.
Base Sepolia remains the functional testbed, and its ten-phase lifecycle evidence is committed.

**A prior deployment on another chain was wound down on 2026-09-18.** Both vaults that existed
there were fully exited by their sole holder and read `totalShares() == 0`; nothing of anyone's
remains in them. That chain is no longer a target and its configuration has been removed from this
repository.

**Launch verdict: NO-GO.** That verdict is unchanged and was not cleared by deploying. The argued
board is [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md) (nine gates, each with its evidence),
and it is the authority whenever this section and that document disagree. What is in flight right
now is [docs/NOW.md](docs/NOW.md); `npm run cc` prints the computed state.

**What remains is operational, legal and calendar-bound.** Two gates are open on the board: the
soak drills (gate 3) and the canary re-run (gate 6), both marked STALE because the evidence behind
them was earned against contracts that have since changed. Both need a funded testnet key and a
re-run rather than more code. The testnet lifecycle (gate 2) and the recorded restore drill
(gate 7) were open until recently and are now GO.

**On the external review: read the qualifier.** An external audit was commissioned against the
launch tree at tag `v0.4.0-audit`. On 2026-08-29 the owner attested, having read the report, that
it surfaced **no major issues**. The report contains sensitive material and is **held privately**.
It is deliberately not reproduced or linked in this repository. That is an **owner attestation**,
not something a reader here can independently verify, and neither the scope list nor the
Low/Informational findings have been published. Do not describe this protocol as "audited" without
that qualifier. Whether that attestation currently stands as the basis for the gate is recorded in
gate 1 of [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md), not here.

**The lifecycle evidence is Base Sepolia, and only Base Sepolia.** The full lifecycle has been run end to end on testnet:
create, deposit, activate, propose, commit, reveal, finalize, execute, exit; and gate 2 of the
board records that run and its stated limits. The address book committed at
[`contracts/config/deployments/base-sepolia.json`](contracts/config/deployments/base-sepolia.json)
now describes the **current** deployment, at `sourceCommit` `8a0e1155`, and the per-phase
transaction table for the run against it is
[`docs/evidence/testnet-lifecycle-run.json`](docs/evidence/testnet-lifecycle-run.json). That
deployment carries the adapter fix in
[#108](https://github.com/SlumperSan/agent-governed-vaults/pull/108) and the mutex in
[#101](https://github.com/SlumperSan/agent-governed-vaults/pull/101); the earlier stack at
`5934ef22`, which predated both, is superseded and lives in git history.

One qualifier, because "current" is narrower than it sounds: the only `contracts/src/` change
between `8a0e1155` and `protocol/main` is a NatSpec-only edit to `VaultDeployer.sol`, and with
solc's default `ipfs` metadata that still changes `VaultDeployer`'s own bytecode trailer. The
**vaults** it produces are byte-identical to a `protocol/main` build, because `VaultCore.sol` is
unchanged. The address book's `bytecodeCurrency` block states this precisely. No testnet run is
evidence about the mainnet deployment, and the gate board remains the authority on what is proven.

## Contracts

`VaultCore`, `Governance`, `FeeEngine`, `OperatorRegistry`, `ChainlinkOracle`, two execution
adapters (`AggregationRouterAdapter`, `DirectPoolAdapter`), `SubVaultRegistry`, `VaultFactory`
(with `VaultDeployer`, which carries `VaultCore`'s creation code).

- Creator locks ≥5% (withdrawal gate); 10% performance fee on realized profit with a cross-vault,
  per-`(member, operator)` high-water mark that follows operator identity.
- Commit-reveal governance; quorum vs. a 25% floor, a signer-count-plus-stake regime under 5 members;
  rules immutable after funding except full consensus + timelock (≤30d).
- 4-hour observation window; instant pro-rata in-kind exit, forward-priced (Mode F) from the
  moment any live proposal reaches its reveal phase, **not** from the moment one passes
  (`Governance.hasPendingExecution` is true from `commitDeadline` onward, and stays true while a
  passed proposal is inside its execution window), so a proposal that is ultimately defeated still
  queued the exits requested while it was live; exit fee ≤1% decaying with tenure; the fee
  fraction is retained by the vault rather than paid out, so it accrues to the remaining members'
  share value.
- Sub-vaults: depth ≤3, recursion block, stacked-fee cap, recursive look-through NAV.
  **Disabled at launch**. `VaultFactory.allowSubVaults = false` (the C-1 fix: root vaults only),
  so this code is dormant on the launch path.
- Safety: **one genuine Chainlink Data Feed per asset**, read directly. On Arc the basket is the
  single asset **cirBTC**, priced through `BTC / USD`; the settlement token, USDC, is
  pinned to $1.00. **There is no ETH leg on Arc** — every ETH-named token with a Uniswap v3 pool
  there holds under $452 of depth, so the `ETH / USD` feed Arc publishes prices nothing this
  protocol holds. There is no
  median, no quorum and no per-vault source set: each asset maps to exactly one feed, fixed
  immutably at construction. Three guards stand between a bad answer and NAV, and all three fail **closed**:
  an **L2 sequencer uptime gate** with a grace period after recovery, a per-feed **heartbeat**,
  and a **sane-price band**. On Arc only the last two would run: Chainlink publishes no L2
  Sequencer Uptime Feed for Arc — it is an L1, not a rollup — and `_requireSequencerUp` returns
  early on a zero address, so the gate is skipped at price time. That exemption has to be granted
  deliberately before any deploy; see `docs/DEPLOYMENT.md` and
  `docs/evidence/arc-mainnet-survey.json`. `priceWad` reverts rather than return a stale, absent or implausible
  price, which freezes every NAV path including active-share exits (by design; pending
  observation-window capital is always reclaimable). Per-vault capacity caps are optional
  (`capacityCapUsdc == 0` is uncapped).
- **Named residual: single-provider dependency.** Those three guards are the *only* defences
  against a wrong Chainlink answer; there is no second source to cross-check against, so a feed
  that reports a plausible-but-wrong price inside its band and heartbeat is believed. A feed
  deprecation or freeze fails that asset **closed** with **no fallback**: every NAV path in a
  vault holding it (deposits, rebalances and exits alike) reverts until the feed recovers. A
  vault's oracle is `immutable` and the factory allowlist gates creation only, so there is no
  rotation lever (residual 12, "curation immobility", in
  [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md)).

This is the second oracle design. Critical finding **C-6** showed the original bespoke
multi-source median aggregator could not be made Byzantine-safe by curation alone, so it was
replaced rather than patched; the retired stack lives under `contracts/test/retired/` as exploit
evidence and must not be deployed
([docs/audit/AI-AUDIT-REPORT.md](docs/audit/AI-AUDIT-REPORT.md),
[docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md)).

`VaultFactory` was once undeployable, and the fix is worth knowing before you read `VaultDeployer`.
Writing `new VaultCore(...)` embeds `VaultCore`'s entire creation code in the caller, which put the
factory over the EIP-170 runtime limit while the suite stayed green; Foundry's test EVM does not
enforce that limit. That blob now lives in `VaultDeployer`'s own creation code, whose constructor
copies it into two immutable, non-executable data contracts; `deploy` reads them back, appends the
caller's ABI-encoded constructor arguments and `CREATE`s, so the bytes reaching `CREATE` are fixed
at compile time. Attestation is unchanged and stays factory-only: `OperatorRegistry.attestVault`
is callable only by the wired factory, so calling the deployer directly yields an unattested
vault ([docs/audit/walkthroughs/VaultDeployer.md](docs/audit/walkthroughs/VaultDeployer.md),
[#10](https://github.com/SlumperSan/agent-governed-vaults/issues/10)).

`VaultCore` is the contract closest to the cap, at **20,650 B runtime / 3,926 B of margin** against
the 24,576-byte limit, measured with `cd contracts && forge build --sizes` at `16050be0` on
2026-09-02. Re-measure rather than quote this line; `contracts/test/Eip170.t.sol` floors the margin
so it cannot silently regress.

Internal security-review rounds plus an AI pre-audit and two adversarial re-review passes; every
finding fixed, replaced or dispositioned ([docs/AUDIT-HANDOFF.md](docs/AUDIT-HANDOFF.md),
[docs/audit/AI-AUDIT-REPORT.md](docs/audit/AI-AUDIT-REPORT.md)). **"Dispositioned" is not
"closed", and the difference is load-bearing:** one High (**H-8**, the stake-blind `<5`-member
quorum regime) is partially fixed in code with its regime-flip mitigated only by configuration;
it remains open at the launch configuration. A further class (**H-5/H-6/H-7**) is dormant
solely because `allowSubVaults = false`: not repaired in code, and live again if sub-vaults are
ever enabled. **H-9 was in that class and is no longer**: it was fixed in code on 2026-09-01
(`require(!v.locked(), Reentrancy())` in `VaultCore._fullNavWad`), and that guard is
unconditional; it does not depend on `allowSubVaults`, so enabling sub-vaults does not bring H-9
back. Hardened with invariant/fuzz
suites for share conservation, NAVps-non-decreasing, solvency, the cross-vault carry HWM, the
Chainlink oracle's fail-closed guards, and governance rounds.

## Layout

| Path | What |
| --- | --- |
| `contracts/` | Foundry project: the protocol (immutable, no proxies). |
| `packages/indexer/` | Chain-agnostic event projections + persistence + a runnable daemon. |
| `packages/agent-sdk/` | Env-agnostic client: the x402 402→authorize→retry loop + typed methods. |
| `packages/canary/` | Read-only post-launch watcher for the DEPLOYMENT §6 signals ([docs/CANARY.md](docs/CANARY.md)). |
| `packages/reference-agent/` | Reference operator loop: read, decide, propose, act within a budget. |
| `packages/oplog/` | Shared operational plumbing: structured logging, durability, shutdown, ops checks. |
| `apps/api/` | x402-metered read API (challenge → EIP-3009 authorize → facilitator settle). |
| `apps/web/` | Vault Atlas: the allocator logic modules, each mirroring a contract term for term. Library, not a deployed app. |
| `apps/vaults-ui/` | React surface over `apps/web`'s modules: vault list, position, open proposal with its votes, holdings. It implements none of the numbers itself. |
| `apps/site/` | The marketing site source: what this is, how it works, and what can go wrong. Built and tested by `npm run gate` (`scripts/gate.mjs`, steps `site-build` and `site-test`). |
| `apps/app/` | The vault explorer at `app.rwally.com`: reads protocol facts live in-browser. |
| `scripts/` | Operational runners: `smoke-test.mjs` drives the full on-chain lifecycle via `cast`. |
| `docs/` | Architecture, threat model, security reviews, design specs, deploy + audit handoff. |

## Production map

Which `apps/*` directory serves which public surface, and which are not deployed anywhere yet.
This table is the single source of truth for "what is live where" — if it disagrees with a
sub-README, this table wins.

| Surface | Directory | Domain | Status |
| --- | --- | --- | --- |
| Marketing site | `apps/site/` | `rwally.com` | **The only marketing site source in this repository.** `apps/site-next/` was deleted in [#304](https://github.com/SlumperSan/agent-governed-vaults/pull/304) and the site was rebuilt here; `scripts/gate.mjs` builds and tests this directory. **Which build `rwally.com` currently serves is not determinable from this repository** — confirm against the Cloudflare Pages project before any deploy. |
| Vault workspace | `apps/vaults-ui/` | `app.rwally.com` | **The member surface, and not deployed yet.** The owner decided 2026-09-19 that this takes the address and `apps/app` retires into it — one surface, one address. `wrangler.toml` here carries the EXISTING project `rwally-app`, so **the next deploy against it replaces the live explorer the instant it finishes**; the DNS is already pointed and there is no staging step. The cutover is the owner's. It reads a chain live via `src/lib/live-vaults.ts` (plan item 0.7); `connect-src` in `public/_headers` names that RPC origin, and the two must change together — see the workspace's own README. |
| Vault explorer (retiring) | `apps/app/` | `app.rwally.com` until the workspace deploys | **Live, and reading a chain the protocol is no longer on.** Same Pages project, `rwally-app`. It is superseded rather than maintained: its live reads were never re-pointed at Arc, and the decision above means they will not be. [#303](https://github.com/SlumperSan/agent-governed-vaults/pull/303) rebuilds THIS directory and was opened 2026-09-16, before that decision — it is superseded by it, not competing with it. |
| Allocator front end | `apps/web/` ("Vault Atlas") | Not yet assigned | **Not deployed.** No production domain decided. |
| Metered read API | `apps/api/` | Not yet assigned | **Not deployed.** x402 metering is implemented; no facilitator stood up and no public domain chosen yet. Its chain configuration targets Arc. |
| Paid vault-snapshot endpoint | ~~`functions/api/vaults.js`~~ (removed from the repo) | `rwally.com/api/vaults` | **Removed from the repo, STILL LIVE in production.** PR #298 (owner-approved) deleted it and `functions/.well-known/x402.js`; the Pages project has not been redeployed, so the route returns **402** and the discovery document returns **200**, read 2026-09-16. **The next deploy of the marketing site removes both** — intended, but not by accident. It duplicated `apps/api` and settled on Base mainnet, conflicting with the single-chain direction. `docs/REVENUE.md` is kept for history, marked superseded. See below the table. |
| Agent-orientation doc | `llms.txt` (repo root) | Served at `rwally.com/llms.txt` once the marketing site publishes it | Internal-facing (read by integrating agents/devs), documents the NO-GO verdict — distinct from the public marketing narrative, which must stay silent on NO-GO per the current internal decision. |
| Status/uptime page | Not yet built | `status.rwally.com` (planned) | **Spec drafted**, not implemented. See `agent-pilot-and-status-spec.md`. |
| API docs | `docs/api/openapi.yaml` | `docs.rwally.com` (planned, not yet hosted) | Spec exists; no hosting/domain set up yet. |

**Resolved (was: open conflict).** `docs/REVENUE.md` used to document the paid-snapshot endpoint
above settling in **USDC on Base mainnet (chain 8453)**, decoupled from the chain whose data it
described. The owner removed the endpoint entirely (PR #298) rather than re-point its settlement
chain, since `apps/api` already serves this role and two paid-API code paths violated the "one API"
rule this table exists to enforce. Revenue is $0.00 and no settlement has ever been exercised on
mainnet.

**The removal has not reached production, and that is a trap to know about before deploying.** The
Cloudflare Pages project still serves what was deployed before PR #298: as of 2026-09-16,
`GET https://rwally.com/api/vaults` answers **402** with a spec-shaped `PAYMENT-REQUIRED` challenge
quoting USDC on Base mainnet, and `GET https://rwally.com/.well-known/x402` answers **200** with the
discovery document — both read off the wire, and neither has source in this repository any more. So
the next `wrangler pages deploy` of the marketing site removes the paid endpoint and the discovery
document from production, which is the intended end state but must not happen by accident while
`apps/api` has nowhere to serve from. Verify before and after any deploy:

```
curl -s -o /dev/null -w "%{http_code}
" https://rwally.com/api/vaults
```

## Build & test

```bash
npm install && npm run gate
```

`npm run gate` mirrors [.github/workflows/ci.yml](.github/workflows/ci.yml) step for step:
`forge fmt --check`, entrypoint syntax, `forge build`, the ops check, the backend suite,
`forge test`, the gas snapshot, the EIP-170 runtime size check, and advisory slither, in about
30 seconds. `--list` explains every step and the deliberate divergences from CI. The individual
suites still run standalone:

```bash
cd contracts && forge build && forge test
```

```bash
npm run test:backend
```

Fuzz and fork gas is excluded from the snapshot gate: fuzz gas is a mean over a corpus that is not
reproducible across machines, and fork tests read live chain state at the latest block (regenerate
with `forge snapshot --nmt "testFuzz|testFork"`).

## Run it

| Goal | Start here |
| --- | --- |
| Deploy the contracts to Base Sepolia | [docs/TESTNET-CHECKLIST.md](docs/TESTNET-CHECKLIST.md); one deploy command, one lifecycle smoke-test command |
| Full deploy semantics and wiring order | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Run the live stack (indexer, API, web) | [docs/RUNTIME.md](docs/RUNTIME.md) |
| Review the contracts | [docs/audit/README.md](docs/audit/README.md) |

## Agent integration

Agents integrate against the contracts. Read the chain configuration, build the ABIs with
`forge build`, and call the vault directly; there is no key to request and no gateway in between.
See [docs/AGENT-QUICKSTART.md](docs/AGENT-QUICKSTART.md),
[`docs/evidence/arc-mainnet-survey.json`](docs/evidence/arc-mainnet-survey.json),
and [`/llms.txt`](llms.txt).

License: MIT; see [LICENSE](LICENSE). The repository was source-available under BUSL-1.1 until
2026-09-05; see [LICENSE-HISTORY.md](LICENSE-HISTORY.md).
