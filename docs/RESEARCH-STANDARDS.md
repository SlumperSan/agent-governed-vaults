# Standards Research: EVM Standards, Testnet Targets, Solana Compatibility

Scope: which published standards this protocol can leverage; which testnet to deploy to; what
"Solana compatibility" can and cannot mean. Research only — no code changes in this document.
Compiled 2026-08-19.

Companion to [RESEARCH-SPRINT1.md](RESEARCH-SPRINT1.md), which already covers x402 V2 headers,
EIP-3009 as the x402 settlement mechanism, ERC-7540's request/claim pattern, ERC-5732, and the
aggregator-calldata exploit class. **This document cross-references those rather than repeating
them.**

Every ERC number below was checked against `eips.ethereum.org` at compile time; titles, statuses
and dates are quoted from that source. Where a fetch failed, the item is marked **Unverified**
with what to check — same convention as the Sprint 1 brief.

---

## 0. The filter: commitments that kill whole branches

A standards survey that ignores our own commitments is noise. These eliminate large parts of the
search space before evaluation, and are quoted here so they don't get re-litigated per item:

| Commitment | Source | What it eliminates |
| --- | --- | --- |
| **C-1** — not ERC-4626, no compliance claim | ARCHITECTURE §4.1 | ERC-4626/7540/7575 *compliance*. Interface-shape borrowing stays allowed. |
| **§12** — no proxies, no upgradeable contracts | ARCHITECTURE §12 | Every upgradeability standard (ERC-1967, ERC-1822, ERC-2535 Diamond, ERC-7201 storage namespacing). Not evaluated further. |
| **C-2** — chain/venue-agnostic, no hardcoded addresses, `block.timestamp` is the only clock | ARCHITECTURE §3 | Anything requiring a pinned per-chain address as a *dependency*. Such standards can still enter as an **injected adapter**. |
| **EE-7** — shares are non-transferable, `mapping(address => uint256) sharesOf`, not ERC-20 | VaultCore.sol:35, :85 | Soulbound *NFT* standards (ERC-5192, ERC-5484, ERC-6454) — all NFT-shaped, wrong form for a fungible non-transferable balance. Dismissed explicitly so they don't get re-raised. |
| **K-4** — oracle staleness freezes exits, "no escape hatch will be added" | ARCHITECTURE §11 | Any standard whose value proposition is an emergency-exit path. See §4 — one item reframes this and is escalated as a decision, not adopted. |
| **§9** — x402 never appears in the contract layer | ARCHITECTURE §9 | Contract-level payment coupling. x402 standards stay in `apps/api`. |

---

## 1. Tier 1: adopt

Seven items that are buildable now, fight no commitment, and change code.

### 1.1 EIP-3009 `receiveWithAuthorization`: one-transaction gasless deposit

**Status:** Draft, Standards Track ERC ([EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)).
Circle's USDC implements it (established in RESEARCH-SPRINT1 §1 from Circle/PayIn sources).

**The gap.** `VaultCore.deposit()` (VaultCore.sol:296) takes `amountUsdc` and pulls via
`transferFrom`, measuring the balance delta. That obliges every depositor to send an `approve()`
first: **two transactions, two gas payments, and a standing allowance** on a vault contract. Our
depositors are AI agents. The agent-facing surface we already shipped (`GET /vaults`,
`/.well-known/x402`, the agent SDK) is undercut by an entry path that needs a two-step ERC-20
dance.

**Add** `depositWithAuthorization(...)` alongside `deposit()`: the agent signs an EIP-3009
authorization off-chain, and a single transaction (submittable by anyone — the agent needs no gas)
lands the USDC and mints. This composes cleanly with x402: the same signing key, the same
authorization primitive the facilitator already uses for metered API access, now also funds the
vault. Note this does **not** breach §9 — it is a plain EIP-3009 token transfer, not an HTTP
payment; the vault gains no x402 dependency.

**The detail that matters: use `receiveWithAuthorization`, not `transferWithAuthorization`.**
The EIP is explicit: *"It is possible for an attacker watching the transaction pool to extract the
transfer authorization and front-run the `transferWithAuthorization` call to execute the transfer
without invoking the wrapper function."* An attacker who front-runs our deposit wrapper lands the
USDC on the vault with **no `deposit()` call attached**: the funds arrive as an unaccounted
donation, the depositor mints nothing, and (because NAV reads internal accounting, not
`balanceOf` (VaultCore.sol:79, the EE-1 donation defense)) the money is simply stranded. The EIP's
own recommendation: *"Use `receiveWithAuthorization` instead of `transferWithAuthorization` when
calling from other smart contracts"* to prevent deposits *"becoming locked up."*
`receiveWithAuthorization` enforces `msg.sender == to`, so only the vault can execute it.

This is the single highest-value item in this document, and getting the wrong one of the two
functions is a live bug class, not a style preference.

> **Verify before implementing:** that the specific USDC deployment on each target chain exposes
> `receiveWithAuthorization` (bridged/wrapped USDC variants sometimes ship only a subset). Read
> the deployed FiatTokenV2 source per chain — do not assume from this brief.

### 1.2 ERC-1271: smart-account members (a gap, not a nicety)

**ERC-1271** (`isValidSignature`) is the contract-signature standard; **ERC-6492** extends it to
counterfactual (not-yet-deployed) accounts; **ERC-7597** ("Signature Validation Extension for
Permit", Draft, created 2024-01-15) extends ERC-2612 `permit` to accept bytes-form signatures so
ERC-1271 contract wallets can use gasless approvals.

**Why this is load-bearing here.** Our members are agents. Agents increasingly *are* smart
accounts: ERC-4337 bundled accounts, or EOAs temporarily carrying code via **EIP-7702** (Final,
Core; activated on Ethereum mainnet with the **Pectra** hard fork on 2025-05-07, introducing the
`0x04` SetCode transaction type). A smart-account member cannot produce a raw
secp256k1 signature. So **every signature-accepting path we add must validate through ERC-1271**,
or it silently excludes exactly the users the protocol is built for.

**Current exposure is zero, and that's worth stating precisely:** commit-reveal (Governance.sol)
is hash-based: `commitVote(pid, keccak256(...))` is an ordinary transaction from the member, no
signature recovery anywhere. Delegation via `setDelegate` is likewise a direct call. **We have no
`ecrecover` in the contract layer today.** The gap opens the moment §1.1 lands: an EIP-3009
authorization is a signature, and a smart-account agent's authorization will not validate unless
the path routes through ERC-1271.

Sequencing follows from that: 1.1 and 1.2 are one work item, not two.

### 1.3 ERC-165: and the value is the *negative* signal

`supportsInterface` appears nowhere in `contracts/src` (verified by grep). Adding it is nearly
free.

The high-value use is not advertising what we are — it's advertising what we are **not**. We
expose `totalAssets()`, `convertToShares()`, `convertToAssets()` (VaultCore.sol:839-851), marked
in comments as "4626-SHAPED, INDICATIVE ONLY". Comments are invisible to an integrator's
auto-detection. Any tool that probes for those three selectors will conclude we are an ERC-4626
vault and will call `previewRedeem`/`withdraw`, which do not exist — or worse, will price a
position off `convertToAssets` while ignoring exit fees, observation windows, and Mode-F forward
pricing, all of which the header comment says the previews ignore.

An explicit ERC-165 that returns **`false` for the ERC-4626 interface id** while returning `true`
for our own published vault interface id turns C-1 from a prose disclaimer into a machine-readable
fact. It pairs directly with the agent-discovery surface already shipped.

### 1.4 ERC-5805 + ERC-6372: conform the reads, declare the clock

- **ERC-5805** "Voting with delegation" — **Stagnant**. Requires `getVotes`, `getPastVotes`,
  `delegates`, `delegate`, plus `delegateBySig` and `nonces`.
- **ERC-6372** "Contract clock" — Standards Track, under peer review. `clock()` returns a
  `uint48` timepoint; `CLOCK_MODE()` returns a machine-readable string, and for timestamp-based
  contracts **MUST return exactly `mode=timestamp`**.

**We are already 5805-shaped without having tried.** `pastVotingEligibleShares(address member,
uint64 ts)` and `pastTotalVotingEligibleShares(uint64 ts)` (VaultCore.sol:810-818) are
`getPastVotes`/`getPastTotalSupply` with a timestamp timepoint; which is precisely ERC-6372's
`mode=timestamp`, and it falls out of C-2's "`block.timestamp` is the only clock" rule. This is
convergent design, not coincidence.

**Recommendation: conform the checkpoint reads and declare the clock. Do not adopt ERC-5805.**
Two reasons full adoption fails:

1. 5805 assumes delegation semantics live on a **transferable voting token**. Ours are
   non-transferable (EE-7), and delegation lives in a *separate* contract keyed per-vault:
   `delegateOf[vault][member]` (Governance.sol:120). 5805's `delegates(address)` is single-scope
   and has nowhere to put the vault dimension.
2. 5805 is **Stagnant**, so conformance buys standing, not a maintained spec.

What we gain from partial conformance is concrete and worth having: any indexer or analytics tool
written against `getPastVotes` semantics works against our checkpoints, and `CLOCK_MODE()` tells
it not to interpret our timepoints as block numbers. What still will not work: OpenZeppelin
Governor and Tally, both of which need the full delegation surface on the token itself. Say that
in the docs rather than implying broader compatibility than exists.

### 1.5 EIP-1153 transient storage for the reentrancy guard

`nonReentrant` is used **12 times in VaultCore** (grep-verified; zero uses elsewhere). The guard
writes a storage slot (`_lock`, VaultCore.sol:124-129) — a `SSTORE` pair on every guarded call.

We already target Cancun (ARCHITECTURE §3: "no chain-specific precompiles or opcode assumptions
beyond Cancun"), and EIP-1153 `TSTORE`/`TLOAD` is a Cancun opcode. Moving the guard to transient
storage removes both `SSTORE`s per call. Zero design conflict, no interface change, and the gas
snapshot infrastructure (`.gas-snapshot`, `forge snapshot --check` in CI) will quantify it
exactly.

Caveat that must be checked, not assumed: transient storage support varies across EVM-compatible
L1s/L2s. On a chain that has not shipped Cancun, `TSTORE` reverts. This interacts with §5 and §6
below — it is a *reason to confirm the Cancun status of each target chain*, not a reason to skip
the change on our primary targets.

### 1.6 CREATE2 deterministic deployment: direct service to C-2

`VaultFactory._deploy` uses plain `new VaultCore(...)` (VaultFactory.sol:93) — **CREATE, not
CREATE2**. Vault addresses therefore depend on the factory's nonce, so the same vault deployed to
two chains lands at two different addresses.

That fights C-2 in practice. A chain-agnostic protocol whose addresses differ per chain forces
every downstream consumer — indexer, agent SDK, frontend, the `/vaults` discovery document — to
carry a per-chain address map. Salted CREATE2 (`new VaultCore{salt: ...}(...)`, salt derived from
creator + basket + config hash) gives identical addresses across every EVM chain with the same
factory bytecode, plus pre-computable addresses (an agent can be told its vault address before
the deploy transaction confirms).

Related: **ERC-2470 Singleton Factory** for deploying the *factory itself* to one address across
chains. **Unverified** — I did not fetch its current status; check
`eips.ethereum.org/EIPS/eip-2470` and compare against Arachnid's deterministic-deployment-proxy,
which is the more widely used tool in practice.

One consequence to design for deliberately: CREATE2 addresses are only stable while the
constructor arguments and bytecode are stable. A compiler-version bump changes every future vault
address. Salt derivation must therefore include a version tag.

### 1.7 ERC-8004 "Trustless Agents": precedent for OperatorRegistry

**Status: Draft, Standards Track ERC, created 2025-08-13.** Specifies three registries:

- **Identity Registry** — ERC-721-based with URI storage; agents get a unique on-chain id,
  browsable in NFT-compatible tooling.
- **Reputation Registry** — clients submit **signed evaluations** of agent performance, with
  optional off-chain data and response-appending.
- **Validation Registry** — agents request independent verification; validators respond, via
  stake-secured re-execution, ZK proofs, or TEE attestation.

Explicitly designed to compose with MCP and A2A, with pluggable trust models scaled to
transaction value.

**Why this matters to us specifically.** RESEARCH-SPRINT1 §3 recorded a clean negative result:
*"no prior art for a per-(depositor, operator) high-water mark"* — Enzyme and dHEDGE both use a
single global per-vault HWM. That finding stands for the **HWM mechanism**, and nothing here
changes it. But it was also read more broadly as "operator identity and reputation are novel
here," and **that broader reading is now wrong**: ERC-8004 is a live draft standardizing exactly
the identity + reputation + validation triad that `OperatorRegistry` implements ad hoc.

Concrete relevance to two known open items:

- ARCHITECTURE §14.2 (registry trust model — "who may deploy vaults against the canonical
  registry... else scores are forgeable") is ERC-8004's Identity Registry problem verbatim. We
  solved it with factory attestation (`attestVault`, VaultFactory.sol:87). Worth comparing
  against 8004's approach before the audit locks ours in.
- The leaderboard (ARCHITECTURE §7) is a reputation registry. 8004's signed-feedback model is a
  different design point from our purely mechanical realized-PnL aggregation — ours is harder to
  game (no subjective input) but carries less information.

**Recommendation: read the draft, adopt its identity id scheme if it fits, do not restructure
OperatorRegistry around a draft standard before our audit.** The near-term action is a
compatibility note in AUDIT-HANDOFF.md, not a rewrite.

---

## 2. Tier 2: evaluate, don't adopt yet

| Standard | Status (verified) | Relevance | Why not now |
| --- | --- | --- | --- |
| **ERC-7726** Common Quote Oracle | Draft, created 2024-06-20 | `getQuote(baseAmount, base, quote)` returning quote-asset terms; MUST round down; defines pseudo-addresses for ETH/BTC. Our `IOracleAggregator.priceWad(asset)` is a USD-only special case of it. | Conforming would let third-party oracle adapters plug in unmodified — genuine C-2 value. But `priceWad` is threaded through NAV, and 7726 is a Draft. Revisit after audit. |
| **ERC-7540** Async vaults | Cross-ref RESEARCH-SPRINT1 §4 | Request/claim ≈ Mode-F. | Already extracted. C-1 rules out compliance. No new finding. |
| **ERC-7575** Multi-Asset ERC-4626 Vaults | **Final**, created 2023-12-11 | Separates the share token from the vault; multiple entry points share one `share` token. Written for exactly our problem: *"Vaults which have multiple assets or entry points... are generally unwieldy or non-compliant due to the requirement of ERC-4626 to itself be an ERC-20."* | The most interesting near-miss here. It is the standards body reaching the same conclusion C-1 reached independently. But it presumes an ERC-20 share token; ours is non-transferable (EE-7). **Worth citing in ARCHITECTURE §4.1 as external validation of C-1's reasoning** — that costs nothing and strengthens the audit narrative. |
| **ERC-6909** Minimal Multi-Token | **Final** | Multiple token ids in one contract; no mandatory callbacks, no batching, hybrid allowance/operator permissions — lighter than ERC-1155. | Candidate for the in-kind escrow ledger (`claimEscrowed`, VaultCore.sol:777) and for sub-vault share accounting. Real but speculative; escrow is a rare fallback path, so the win is small. |
| **ERC-7710** Smart Contract Delegation | Draft, created 2024-05-20 | Delegation manager + `redeemDelegations(permissionContext)`; explicitly cites *"bounded permissions for AI agents"* as a motivating use case. Already one of x402's three transfer methods (RESEARCH-SPRINT1 §1). | Directly on-theme for agent-operated vaults, and pairs with ERC-7715 (permission grants). But our delegation is *governance-weight* delegation, not *execution-authority* delegation — different problem. Relevant if we ever let an agent delegate vault actions to a sub-agent. |
| **ERC-7265** Circuit Breaker | **Unverified status** — `eips.ethereum.org/EIPS/eip-7265` returned **404**; the proposal is widely documented in secondary sources as a DeFi circuit breaker with per-asset rate limits and a grace period on outflows exceeding a % of TVL. | Conceptual sibling of our oracle breaker and capacity cap. | Cannot cite a status. Check `github.com/ethereum/ERCs` directly. Also note our breaker is a *pricing-integrity* breaker, not an *outflow-rate* breaker — different trigger, so this is additive, not overlapping. |
| **ERC-7683** Cross-Chain Intents | Draft, created 2024-04-11 | Standard order representation for cross-chain fills by solvers. | Phase-2 multi-chain only. **Interface details unverified** — the fetched spec described `IResolver`/`IStep`/`IVariableRole`, which does not match the `CrossChainOrder`/settler shape widely cited elsewhere; the spec appears to have been substantially revised. Read the current text before relying on any struct name. |
| **CAIP-2 / CAIP-10 / CAIP-19** | Chain-agnostic namespace specs (not ERCs) | Chain, account, and asset identifiers. x402 already uses CAIP-2 (`eip155:8453`). | Adopt in the **indexer/API layer** as soon as a second chain lands — this is how one API surface addresses Base, BNB, and Solana without inventing our own chain enum. Zero contract impact. Cheap and near-certain to be needed; see §6. |
| **ERC-7512** On-chain audit representation | **Unverified** | On-chain audit attestations. | Possibly useful post-audit for verifiable audit status on the discovery surface. Low priority. |
| **ERC-7572** `contractURI()` contract-level metadata | **Unverified** | Vault name/description/image for frontends and agent discovery. | Cheap, cosmetic. Bundle with ERC-165 work if adopted. |
| **ERC-7802** Crosschain mint/burn | **Unverified** | Superchain-standard cross-chain token interface; Base-relevant. | Shares are non-transferable, so cross-chain *share* movement is out of scope by construction. Only relevant if that ever changes. |

---

## 3. Rejected, with reason

One line each, so they stay rejected:

- **ERC-4626 / ERC-7540 compliance** — C-1. In-kind redemption, swing pricing, and forward pricing
  each break `preview*` round-trip guarantees.
- **ERC-1967 / ERC-1822 / ERC-2535 Diamond / ERC-7201** — §12, no upgradeability. Not evaluated.
- **ERC-5192 / ERC-5484 / ERC-6454** (soulbound NFTs) — NFT-shaped; our shares are a fungible
  non-transferable balance. Wrong form factor, and non-transferability needs no standard to
  express when there is simply no `transfer` function.
- **ERC-20 for shares** — EE-7. Adding transferability would break the Mode-F share lock, the
  creator 5% withdrawal gate, and the per-`(member, operator)` HWM key simultaneously.
- **ERC-2612 `permit` for deposits** — USDC uses EIP-3009, not 2612 (RESEARCH-SPRINT1 §1). Would
  be dead code on the settlement asset.
- **ERC-1155 for basket/escrow** — ERC-6909 is the lighter fit (Tier 2); 1155's mandatory
  acceptance callbacks are a reentrancy surface we do not want on the exit path.
- **MACI / threshold-encrypted voting (Shutter)** — external infrastructure dependency;
  RESEARCH-SPRINT1 §5 already evaluated and declined for Sprint 2.
- **ERC-2981 royalties, ERC-6551 token-bound accounts** — no mapping to any mechanism here.

---

## 4. Flagged decision: pull oracles reframe K-4's cost, they don't dissolve it

**This is not a recommendation. It is a K-decision the standing directive says to surface.**

ARCHITECTURE §11 commits in writing: the staleness breaker freezes exits, and *"no escape hatch
will be added, since any escape hatch is exactly the stale-price exit the breaker exists to
prevent."* The accepted cost (K-4) is that an attacker who can induce staleness can trap capital.

**Pull oracles change the shape of that trade-off.** Push feeds (Chainlink-style, what
`ChainlinkSourceAdapter` wraps, OracleAggregator.sol:122) update on the publisher's schedule; if
they stop, we freeze and there is nothing a user can do. Pull oracles (Pyth, RedStone and similar)
distribute *signed price messages off-chain*, and any caller can submit a fresh signed price **in
the same transaction** as their action. A frozen member could then attach a current, publisher-
signed price to their own exit transaction and leave: **without any escape hatch, because the
price is not stale**. The breaker's invariant is untouched: we still never price off a stale
value.

Our architecture is already prepared for this. `IPriceSource` is documented as covering
*"Chainlink-style push, TWAP, **pull-oracle wrapper**…"* (OracleAggregator.sol:6). No interface
change is required — a pull adapter is a new `IPriceSource` implementation, which is the C-2
pattern working as designed.

**What it does not fix, and this is the part that decides it:**

1. **Publisher-network downtime still freezes.** If the off-chain publisher network stops signing,
   there is no fresh message to submit. K-4's failure mode is reduced in *likelihood*, not
   eliminated.
2. **It hands the caller an option on timing.** With push feeds, the price at any block is
   whatever the publisher last wrote; the same for everyone. With pull feeds, the *actor chooses
   which signed price to submit*, within the staleness bound. A member exiting can wait for a
   favorable signed price and submit that one. That is a new trust surface: a latency-arbitrage
   option granted to whoever transacts. The existing security review already tracks a
   "finding-7 latency-arb drift window" (OracleAggregator.sol:32) that this would widen.
3. **Freshness quorum interacts awkwardly.** `MIN_SOURCES = 3` with a strict-majority freshness
   quorum assumes sources update independently. A caller submitting fresh prices to two pull
   sources in one transaction controls the quorum's timing directly.

**The decision requested:** is K-4's trapped-capital cost worth reopening in exchange for a
narrower freeze window, given that item 2 trades a known accepted risk for a new one? My reading
is that the honest framing is *"different risk, not less risk"* — but §11 is a written commitment
and this is precisely the class of change the directive says not to make unilaterally.

---

## 5. Testnet target: and a real blocker on BNB testnet

Addressing the mid-session inputs: *BNB testnet usually has pricing data from Binance*, and
*testnet*.

### 5.1 The BNB testnet finding

Binance Oracle publishes **70+ price feed pairs on BNB Chain testnet** (BNB/USD, ETH/USD, BTC/USD
and others), each with a contract address and a Space ID identifier such as
`bnb-usd.boracle.bnb` ([Binance Oracle, BNB Testnet feed
addresses](https://oracle.binance.com/docs/price-feeds/contract-addresses/bnb-testnet/)). So the
premise is correct — the data is there, and free.

**But: Binance's testnet feed page carries the line that "feeds are updated every 24 hours in the
testnet."** Treat that as the page's own summary rather than a published spec — the page lists
addresses and Space IDs, and does **not** document heartbeat or deviation thresholds; those live
in the Feed Registry / Feed Adapter API references, which should be checked before any deploy.

Set against our own code, a 24-hour heartbeat is disqualifying. The freshness test is per-source
(OracleAggregator.sol:77-85):

```solidity
uint32 public constant MAX_STALENESS_CEILING = 1 days;                  // :36, constructor bound
uint256 minUpdated = block.timestamp > cfg.maxStaleness                 // :77
    ? block.timestamp - cfg.maxStaleness : 0;
if (p > 0 && updatedAt >= minUpdated) fresh[k++] = p;                   // :82, per source
if (k < cfg.quorum) revert StaleOracle(asset);                          // :85
```

So a source counts as fresh iff `block.timestamp - updatedAt <= maxStaleness`, and `maxStaleness`
is constructor-capped at `1 days` (86,400s). A feed publishing every 86,400s is therefore fresh
only in the shrinking margin before its next publish, and goes stale on **any** publisher jitter
past the interval. Worse, the failure is correlated: all three-plus sources drawn from Binance
Oracle share one publication schedule, so they cross the threshold together, `k` drops below
quorum, and `priceWad` reverts. Per K-4 that freezes deposits, exits, and proposal execution
simultaneously.

**A vault deployed on BNB testnet against Binance Oracle testnet feeds would spend much of its
life frozen** — not because anything is broken, but because the ceiling was sized for
mainnet-grade feeds and these testnet feeds are two orders of magnitude slower.

This is a genuine finding and it is better to hit it here than in a demo.

**Options, in preference order:**

1. **Deploy self-hosted `IPriceSource` mocks on testnet**, fed by a keeper pushing real prices
   every few minutes. Preserves realistic staleness behaviour, keeps `MAX_STALENESS_CEILING`
   honest, and exercises the breaker deliberately rather than constantly. This is what the
   existing `PriceSrc` test double already does — promoting it to a deployed testnet keeper is
   small work.
2. **Chainlink on BNB testnet.** Chainlink runs a native deployment on BNB Smart Chain
   ([BNB Chain blog](https://www.bnbchain.org/en/blog/chainlink-oracles-now-live-on-binance-smart-chain)),
   exposing the standard `AggregatorV3Interface` — which `ChainlinkSourceAdapter`
   (OracleAggregator.sol:122) already consumes with no new code. **Unverified:** BNB *testnet*
   feed heartbeats; confirm on docs.chain.link before relying on them.
3. **Raise `MAX_STALENESS_CEILING` for testnet builds** — *rejected*. It is a security constant
   with a documented rationale (underflow honeypot, latency-arb drift bound). Divergence between
   testnet and mainnet security constants is how a testnet-only value reaches production.

Also note `MIN_SOURCES = 3` with a strict-majority freshness quorum: **any** testnet needs three
independent, adequately-fresh sources per basket asset. Binance Oracle alone does not satisfy the
config, regardless of heartbeat.

### 5.2 Which testnet

| Target | For | Against |
| --- | --- | --- |
| **Base Sepolia** | The Coinbase x402 facilitator supports Base Sepolia (RESEARCH-SPRINT1 §1) — the only target where the **x402 metering layer can be tested end-to-end**. Base is the stated production target. Cancun-complete, so EIP-1153 (§1.5) works. | Oracle feed availability on Base Sepolia needs confirming; likely needs option 1 above regardless. |
| **BNB testnet** | Free Binance Oracle feeds (§5.1), 70+ pairs; genuine second-EVM-chain proof for C-2. | 24h heartbeat blocker; x402 facilitator support unconfirmed for BNB. |
| **Both** | C-2 says chain-agnostic; two chains prove it the way two adapters proved venue-agnosticism. Deterministic CREATE2 (§1.6) makes this materially cheaper. | Two deploys to maintain. |

**Recommendation: Base Sepolia first** — it is the only one that exercises the full stack
including x402 — **then BNB testnet as the C-2 proof**, using keeper-fed sources on both. Deploy
is still gated on your key; I will not deploy on your behalf.

---

## 6. Solana compatibility: four options, and only one is cheap

Addressing the third mid-session input. "Compatible with Solana" resolves to four materially
different projects, and the difference between them is roughly two orders of magnitude of work.

**The hard constraint first.** Solana's own documentation is unambiguous: **Solidity contracts
cannot run natively on Solana** ([Solana, EVM to SVM: Smart
Contracts](https://solana.com/developers/evm-to-svm/smart-contracts)). The SVM separates code from
data completely — programs are stateless and *"all data that programs interact with is stored in
separate accounts and is called through instructions,"* where EVM contracts hold state inside the
contract. Solana also uses the Upgradable BPF Loader, i.e. programs are upgradeable by default —
which collides with §12's no-upgrades commitment.

That is not a porting inconvenience. `VaultCore` is 852 lines of contract-resident state:
`sharesOf`, checkpoint history, escrow ledgers, pending deposits. On Solana every one of those
becomes an account the caller must pass in, with rent, size limits, and explicit ownership. This
is a rewrite, not a recompile.

**Option A — API/indexer layer only (cheap, recommended first).** Solana vaults never exist;
instead the agent-facing surface becomes chain-aware. x402 **already supports Solana**: the
Coinbase facilitator covers Solana for SVM via `@x402/svm`, and SPL USDC is the settlement asset
there, alongside EIP-3009 USDC/EURC on EVM
([Solana x402 guide](https://solana.com/developers/guides/getstarted/intro-to-x402)). So Solana
agents can **pay for our metered API today** with no contract work at all — this is purely
`apps/api` accepting an SVM payment scheme. Adopt CAIP-2 identifiers (§2) at the same time.
Days of work, and it delivers the most commonly intended meaning of "support Solana agents."

**Option B — Neon EVM (moderate).** Neon executes EVM bytecode on Solana by translating it into
Solana instructions, letting existing Solidity deploy *"with minimal reconfiguration"*
([Neon/QuickNode](https://www.quicknode.com/guides/solana-development/solidity/neon-solidity-get-started)).
Our contracts would likely deploy near-unmodified. **But** we would be running inside Neon's
execution environment, not on Solana natively — Neon becomes a trust and liveness dependency,
Solana-native agents cannot call us with ordinary SPL tooling, and Cancun opcode support
(EIP-1153, §1.5) needs explicit confirmation. Directionally attractive, materially unverified.

**Option C — Solang (moderate-to-hard).** Solang compiles Solidity to Solana bytecode via LLVM
rather than translating EVM bytecode. Produces genuinely native programs, but the Solidity subset
supported is narrower and the account model still surfaces — `msg.sender`, contract-resident
mappings, and `new Contract(...)` deployment from a factory all need rework. Expect substantial
edits to all 9 contracts, then a full re-audit of a codebase whose EVM audit no longer transfers.

**Option D — native Rust/Anchor rewrite (hard).** A second implementation, a second audit, two
codebases to keep semantically identical forever. Only justified by real Solana-native demand.

**Recommendation: Option A now.** It captures Solana agents as *users* — which is what the
protocol actually needs, since agents are the customers — at a fraction of the cost, and it
commits us to nothing. Treat B/C/D as a Phase-3 question to be reopened only if Solana-native
vault demand shows up. Note also that Solana compatibility is a **different axis from C-2**: C-2
buys us EVM-chain portability, and it does not extend across VMs.

> **Unverified, check before acting:** Neon EVM's current mainnet status and Cancun/EIP-1153
> support; whether the Coinbase facilitator's Solana support covers devnet for testing. Sources
> here are secondary (vendor blogs and guides), not primary specs.

---

## 7. Summary: what changes, what's asked

**Adopt (no decision needed, fits every commitment):**

1. **EIP-3009 `receiveWithAuthorization` deposit path** — one-transaction gasless entry for
   agents. Must be `receive`, not `transfer`; the front-run variant strands funds. Highest value
   item here.
2. **ERC-1271 validation** on that path — same work item; without it, smart-account agents are
   excluded.
3. **ERC-165**, publishing `false` for ERC-4626 — makes C-1 machine-readable.
4. **ERC-6372 `CLOCK_MODE()` + 5805-shaped checkpoint reads** — near-free, we are already shaped
   this way; do not claim Governor/Tally compatibility.
5. **EIP-1153 transient reentrancy guard** — 12 call sites, measurable via existing gas snapshot.
6. **CREATE2 in `VaultFactory`** — same vault address on every EVM chain; direct C-2 service.
   Version-tag the salt.
7. **Cite ERC-7575 in ARCHITECTURE §4.1** — external validation that multi-asset vaults can't be
   4626. Free, strengthens the audit narrative.

**Decisions requested:**

- **§4 — pull oracles and K-4.** Narrower freeze window, but hands the transacting party a
  timing option and widens the tracked latency-arb window. My reading: *different* risk, not
  less. §11 is a written commitment; your call.
- **§5.2 — testnet target.** Recommend Base Sepolia first (only target exercising x402
  end-to-end), BNB testnet second as the C-2 proof. Both need keeper-fed price sources.
- **§6 — what "Solana compatibility" means.** Recommend Option A (API/indexer + x402 SVM
  scheme). Options B–D are rewrites with their own audits.

**Blocker to be aware of regardless of choice:** Binance Oracle's BNB **testnet** feeds publish on
a ~24h cadence, against a per-source freshness test bounded by `MAX_STALENESS_CEILING = 1 days` —
and because those sources share one publication schedule they go stale together, dropping the
fresh count below quorum. A vault wired to them would sit frozen. Do not raise the ceiling for
testnet — deploy keeper-fed sources instead.

---

### Sources

- [EIP-3009: Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009) ·
  [ERC-7597: Signature Validation Extension for Permit](https://eips.ethereum.org/EIPS/eip-7597) ·
  [ERC-5805: Voting with delegation](https://eips.ethereum.org/EIPS/eip-5805) ·
  [ERC-6372: Contract clock](https://eips.ethereum.org/EIPS/eip-6372) ·
  [EIP-7702: Set Code for EOAs](https://eips.ethereum.org/EIPS/eip-7702) ·
  [ERC-7710: Smart Contract Delegation](https://eips.ethereum.org/EIPS/eip-7710) ·
  [ERC-7726: Common Quote Oracle](https://eips.ethereum.org/EIPS/eip-7726) ·
  [ERC-7575: Multi-Asset ERC-4626 Vaults](https://eips.ethereum.org/EIPS/eip-7575) ·
  [ERC-6909: Minimal Multi-Token Interface](https://eips.ethereum.org/EIPS/eip-6909) ·
  [ERC-7683: Cross Chain Intents](https://eips.ethereum.org/EIPS/eip-7683) ·
  [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)
- ERC-7265 circuit breaker (EIP page 404 at fetch time; secondary coverage:
  [The Block](https://www.theblock.co/post/237671/ethereum-erc-7265-circuit-breaker-defi-hacks),
  [Cointelegraph](https://cointelegraph.com/learn/erc-7265-eth-token-standard-for-defi-security))
- [Binance Oracle — BNB Testnet feed addresses](https://oracle.binance.com/docs/price-feeds/contract-addresses/bnb-testnet/) ·
  [Binance Oracle — Feed Registry](https://oracle.binance.com/docs/price-feeds/feed-registry/) ·
  [Chainlink oracles live on BNB Smart Chain](https://www.bnbchain.org/en/blog/chainlink-oracles-now-live-on-binance-smart-chain) ·
  [Chainlink — Using Data Feeds on EVM Chains](https://docs.chain.link/data-feeds/using-data-feeds)
- [Solana — EVM to SVM: Smart Contracts](https://solana.com/developers/evm-to-svm/smart-contracts) ·
  [Solana — Intro to x402](https://solana.com/developers/guides/getstarted/intro-to-x402) ·
  [QuickNode — Deploy a Solidity contract on Solana using Neon](https://www.quicknode.com/guides/solana-development/solidity/neon-solidity-get-started) ·
  [QuickNode — Solang vs Neon](https://www.quicknode.com/guides/solana-development/solidity/getting-started-solang-neon) ·
  [x402 facilitator docs](https://docs.x402.org/core-concepts/facilitator)
