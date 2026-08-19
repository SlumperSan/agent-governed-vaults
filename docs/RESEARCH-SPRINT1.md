# Sprint 1 Research Brief

Scope: x402 payment flow, Base DEX aggregator router integration, vault governance/fee prior
art, swing/forward pricing precedent, commit-reveal voting safety. Research only — no code
changes. Compiled 2026-08-18.

---

## 1. x402 protocol

**Status: the spec changed materially in the last two months.** x402 V1 launched May 6, 2025
as a Coinbase-authored whitepaper/standard ([Wikipedia](https://en.wikipedia.org/wiki/X402),
[x402 V2 launch post](https://x402.org/x402-v2-launch/)). **V2 shipped June 24, 2026**, after
"100M+ payments processed" on V1 ([x402 V2 launch post](https://x402.org/x402-v2-launch/)).
Any integration work should target V2; V1's header scheme is deprecated.

**Header/response schema (V2).** V2 replaced the V1 pattern (payment requirements in the 402
JSON body, `X-PAYMENT` request header) with dedicated headers:
- `PAYMENT-REQUIRED` — server → client on the 402 response, base64-encoded JSON payment
  requirements.
- `PAYMENT-SIGNATURE` — client → server on retry, base64-encoded JSON payment payload
  (signature + authorization).
- `PAYMENT-RESPONSE` — server → client, settlement confirmation.
- `SIGN-IN-WITH-X` — announced as "coming soon," CAIP-122-based session/identity header.

Source: [x402 V2 launch post](https://x402.org/x402-v2-launch/),
[x402-foundation HTTP-402 core concepts doc](https://github.com/x402-foundation/x402/blob/main/docs/core-concepts/http-402.md).
**Unverified**: I could not retrieve the exact field-level JSON schema (property names/types)
for the V2 `PaymentRequirements`/`PaymentPayload` objects from a primary source — the raw spec
file 404'd and GitHub's rendered view didn't yield the full type definitions. The `coinbase/x402`
repo's `specs/` directory does contain `x402-specification-v1.md`, `x402-specification-v2.md`,
and a `schemes/` subtree with an `exact` EVM scheme doc — pull those directly before
implementation rather than relying on this brief for field names.

**Payment scheme ("exact", EVM).** Per
[`specs/schemes/exact/scheme_exact_evm.md`](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md):
the `accepted`/payment-requirements object carries `scheme` ("exact"), `network` (CAIP-2 style,
e.g. `eip155:8453` for Base), `amount`, `asset` (token contract), `payTo`, `maxTimeoutSeconds`,
and an `extra` bag for method metadata. The scheme supports three transfer methods depending on
asset capability:
- **EIP-3009 `transferWithAuthorization`** — the default/primary path for USDC. Payload carries
  `signature` plus an `authorization` struct (`from`, `to`, `value`, `validAfter`, `validBefore`,
  `nonce`). This is a gasless, non-approval-based transfer: the signer authorizes a specific
  transfer, the facilitator submits it, no prior `approve()` call needed.
- **Permit2** — fallback for tokens without native EIP-3009 support.
- **ERC-7710** — delegation-based path (`delegationManager`, `permissionContext`, `delegator`).

So: **confirmed, EIP-3009 `transferWithAuthorization` is the mechanism for USDC**, not
EIP-2612 `permit`. Circle's USDC has supported EIP-3009 since its v2 contract upgrade, which is
cited as the reason it's the "smoothest path" for x402
([PayIn blog, ERC-3009 explainer](https://blog.payin.com/posts/erc-3009-x402/)). EIP-3009 is
confirmed supported on Base and Arbitrum
([OAK Research x402 analysis](https://oakresearch.io/en/analyses/innovations/what-is-x402-understanding-protocol-narrative)).

**Facilitator role.** The facilitator is a third-party service, not a smart contract the vault
calls directly. Flow: resource server calls facilitator `POST /verify` (validates signature,
checks payer balance, checks parameter match against requirements) before serving the resource;
after serving, calls facilitator `POST /settle`, which submits `transferWithAuthorization`
on-chain and confirms. Coinbase operates a CDP-hosted facilitator
(`https://x402.org/facilitator`, CDP API key auth, Base/Base Sepolia/Solana/Solana Devnet)
([search result citing CDP facilitator docs](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/x402-facilitator)).
V2's stated direction is multiple simultaneous facilitators with client-side selection
([x402 V2 launch post](https://x402.org/x402-v2-launch/)) — don't hardcode one facilitator URL.

**What a resource server must implement:** (1) return 402 + `PAYMENT-REQUIRED` header when an
unpaid request arrives; (2) on retry, extract `PAYMENT-SIGNATURE`, call facilitator `/verify`
(or verify signature/balance locally if avoiding a facilitator round-trip); (3) serve the
resource; (4) call facilitator `/settle` (or settle directly if the resource server itself holds
facilitator-equivalent chain access); (5) return `PAYMENT-RESPONSE` header with settlement proof.
Coinbase's docs describe this as "1 line for the server, 1 function for the client" via SDK
helpers ([coinbase/x402 GitHub search summary](https://github.com/coinbase/x402)).

**Reference implementations and maturity.** `coinbase/x402` is the origin repo but is now
described as a development fork feeding a neutral `x402-foundation/x402` repo
([search summary](https://github.com/x402-foundation/x402)). TypeScript is the most mature
surface: `@x402/core`, `@x402/evm`, `@x402/svm`, `@x402/stellar` plus framework adapters
(`@x402/axios`, `@x402/fastify`, `@x402/fetch`, `@x402/express`, `@x402/hono`, `@x402/next`,
`@x402/paywall`, `@x402/extensions`)
([coinbase/x402 examples/typescript tree](https://github.com/coinbase/x402/tree/main/examples/typescript)).
Python trails but reached parity at **v0.6.0**, described as "completes the TypeScript parity
milestone against the Python SDK, both SDKs supporting facilitator verify and settle flows"
([search summary of coinbase/x402 issues/README](https://github.com/coinbase/x402)). Given this
is Base-native and TypeScript-first tooling is more mature, plan the x402-metered API
(Sprint 7, `apps/api/`) around the TS SDKs.

**Constraint this imposes on the vault architecture:** x402 payment settlement is a stablecoin
transfer authorized by user signature, executed via a facilitator, entirely separate from
`VaultCore`'s share/NAV accounting. It has **no direct bearing on `IExecutionAdapter` or
on-chain vault mechanics** — it's purely the metering layer for the read/API surface
(Sprint 7). No change to Sprint 1 contracts is indicated. Flagging this explicitly since the
brief groups x402 with the vault research: they don't intersect at the contract layer.

---

## 2. Base DEX aggregation routers (0x, 1inch)

**Call shape.** Both 0x and 1inch return off-chain-computed calldata that the caller sends
verbatim to a router contract via a low-level call (or a plain external call to a fixed
function selector) — the vault contract does **not** decode or reconstruct the swap path
on-chain. This confirms the intended `IExecutionAdapter` shape: adapter takes
`(target, calldata, value, minOut, deadline)`-like parameters generated off-chain by a keeper/
solver, not an on-chain-computed route.

**0x specifics.** 0x Swap API v2 uses two allowance patterns:
- **AllowanceHolder** (recommended) — caller approves a fixed `AllowanceHolder` contract, then
  sends the returned `transaction.data` to `transaction.to` (typically `AllowanceHolder`
  itself, which forwards to the actual `Settler` contract). Lower gas, simpler integration.
- **Permit2** — advanced path, signature-based, no standing ERC-20 `approve()`.

0x explicitly warns: **"Never set an allowance on the Settler contract"** — Settler contracts
are disposable/versioned per-transaction routing logic and are not meant to hold approvals; only
`AllowanceHolder` should ever receive an approval
(source: search-result summary of [0x Swap API v2 upgrade docs](https://0x.org/docs/upgrading/upgrading_to_swap_v2)
— **the docs page itself 404'd on direct fetch, verify current addresses at
[docs.0x.org](https://docs.0x.org/) before implementation**, treat the AllowanceHolder/Settler
separation as directionally correct but re-confirm the exact current Base addresses).

**1inch specifics.** AggregationRouter V6 is the current version (verified contract, deployed
on Ethereum, Arbitrum, and other EVM chains including Base —
[Etherscan](https://etherscan.io/address/1inch.eth),
[Arbiscan](https://arbiscan.io/address/0x111111125421ca6dc452d289314280a0f8842a65)). Standard
integration: `approve()` the router for the input token, then call the router with calldata from
the 1inch API/SDK. Swap functions (`swap`, `unoswap`, `uniswapV3Swap`, etc.) all carry a
**`minReturn`** parameter baked into the off-chain-generated calldata, which reverts the
transaction on-chain if output would fall below it — this is the on-chain slippage enforcement
mechanism, not a separate parameter the caller passes independently
([search summary of 1inch router docs](https://github.com/1inch/1inchProtocol)). **Unverified**:
exact current Base-chain deployment address for AggregationRouter V6 — confirm against 1inch's
own docs/BaseScan at implementation time, not this brief.

**Known safety pitfalls — this is the section most load-bearing for `IExecutionAdapter` design:**

1. **Arbitrary-calldata execution / target-spoofing.** A live, large-scale incident: the
   **SwapNet / Aperture Finance exploit (~$13.4–17M, January 2026)**. Root cause: the vulnerable
   contract accepted an off-chain-supplied *target address* and *calldata* without validating
   the target against a whitelist or validating the calldata's function selector. An attacker
   substituted the token contract itself as the "router" target and crafted calldata that
   invoked `transferFrom(victim, attacker, amount)` against the victim contract's own existing
   token approval — the contract's low-level `call()` didn't know or care that the "router" it
   was calling was actually the token contract
   ([BlockSec writeup](https://blocksec.com/blog/17m-closed-source-smart-contract-exploit-arbitrary-call-swapnet-aperture),
   [dev.to summary calling this the "calldata injection" pattern](https://dev.to/ohmygod/calldata-injection-the-17m-vulnerability-pattern-hiding-in-every-defi-router-1bli)).
   Same root-cause class as the earlier **Dexible exploit ($1.53M, Feb 2023)** — "not checking
   whether the router address was actually a DEX or verifying it on-chain in any way"
   ([Quadrigainitiative case study](https://quadrigainitiative.com/casestudy/dexibledexaggregatorselfswapexploit.php)) —
   and **Unizen (~$2.1M, March 2024)** and **LI.FI**, both allowing arbitrary function execution
   from the vault's own context, draining approvals
   ([search summary citing Revoke.cash exploit list](https://revoke.cash/exploits)).

2. **Fix pattern, directly informing `IExecutionAdapter`:**
   - Whitelist call targets (router contract addresses) at the adapter/registry level — never
     accept an arbitrary target from the calldata payload itself.
   - Validate the function selector against an allowed set for that target (don't allow e.g.
     `transferFrom` selectors to reach a token contract through the adapter path).
   - Enforce `minOut`/slippage **as a parameter the adapter itself checks post-call** (compare
     vault's token balance before/after) rather than trusting a `minReturn` baked only inside
     opaque calldata — belt-and-suspenders, since a compromised off-chain calldata generator
     could omit or weaken the in-calldata slippage check.
   - Use minimal, revocable, per-transaction approvals (approve exact amount immediately before
     the call, or use a router pattern like 0x's AllowanceHolder that's designed to never
     accumulate standing approvals on the routing/execution contract itself).
   - Treat router addresses as upgradeable/rotatable configuration (governance-timelocked), not
     immutable constants — 0x has rotated Settler/Exchange Proxy contracts across versions, and
     1inch has moved from V4/V5/V6; hardcoding a router address in an immutable adapter risks the
     adapter going stale.

**Architectural implication for `IExecutionAdapter` (Sprint 4): this changes the interface
shape.** A naive adapter that takes `(target, calldata)` and blindly forwards them is exactly
the vulnerability class above. The interface needs, at minimum: an adapter-level allowlist of
`(router address, selector)` pairs set via timelocked governance (ties into C-3's
`IOperatorRegistry`/governance hook already planned), a caller-supplied `minOut` that the
adapter enforces independently via balance-delta check (not trusting calldata-embedded
`minReturn` alone), and approval scoped to the exact swap amount rather than infinite/standing
approval. This should be flagged to the Sprint 4 contract agent as a concrete threat-model row
(EX-1..4 family) rather than left as "adapter interface, details later."

---

## 3. Vault governance and fee prior art

| Protocol | HWM implementation | In-kind redemption | Deposits/withdrawals during pending rebalance |
| --- | --- | --- | --- |
| **Enzyme Finance** | **Global, per-vault**, not per-share/per-depositor. A single `highWatermark` value stored per fund, compared against current gross share price (`GAV/totalSupply`) at fee settlement; updated only when the new price exceeds it. Formula: read `hwm` from storage, compute `g_i = GAV_i/TS_i`, fee accrues only on the excess over `hwm`, then `hwm = g'_i` if higher ([Enzyme fee-formula spec](https://specs.enzyme.finance/fee-formulas/performance-fee)). All depositors share one HWM regardless of entry price — no per-position tracking. Note: a V3→V4 upgrade **reset** the HWM to the share price at migration time, i.e. HWM is not portable across contract versions without explicit migration logic ([search summary](https://medium.com/enzymefinance/are-you-charging-performance-fees-on-enzyme-this-is-a-must-read-for-you-d6a34a849a1d)). | **Yes, two modes.** `redeemSharesInKind` — pro-rata slice of the vault's raw ERC-20 holdings only (external/derivative positions forfeited). `redeemSharesForSpecificAssets` — redeemer names specific assets and relative weights (e.g., 75% DAI / 25% ZRX) up to their share value; a `PolicyHook.RedeemSharesForSpecificAssets` hook lets the fund gate which assets qualify ([Enzyme fund-holdings spec](https://specs.enzyme.finance/topics/fund-holdings)). | Enzyme enforces a fund-configurable `sharesActionTimelock`: a depositor cannot redeem or transfer shares for N seconds after their last deposit — anti-arbitrage, not specifically a rebalance gate. Deposit/redeem requests are also cancellable within a configurable window before execution ([search summary of Enzyme FAQ/known-risks docs](https://docs.enzyme.finance/onyx-faq)). **Unverified**: whether Enzyme blocks or queues redemptions specifically *during* an in-flight trade/rebalance transaction — no direct source found; the timelock is the closest analog but addresses a different attack (price arbitrage, not rebalance-timing risk). |
| **dHEDGE** (rebranding to **Chamber** in 2026 — [search summary, dHEDGE blog](https://blog.dhedge.org/the-dhedge-ecosystem-a-2025-recap-and-whats-ahead-in-2026/), [CoinMarketCap](https://coinmarketcap.com/currencies/dhedge-dao/)) | **Global, per-pool, price-based.** `PoolLogic.sol` stores `tokenPriceAtLastFeeMint`; `_availableManagerFee()` compares current pool-token price to that stored value, and if higher, `_mintManagerFee()` **mints new pool tokens to the manager** (`_mint(_manager(), managerFee)`) — i.e., the fee mechanism is share-dilution, not a transfer out of vault assets ([dhedge/V2-Public PoolLogic.sol](https://github.com/dhedge/V2-Public/blob/master/contracts/PoolLogic.sol), [PoolManagerLogic.sol](https://github.com/dhedge/V2-Public/blob/master/contracts/PoolManagerLogic.sol)). Same single-watermark-for-all-depositors design as Enzyme. | **Unverified for current docs** — dHEDGE's docs site has migrated to `docs.chamberfi.com` mid-rebrand and the specific fees-technical-breakdown page returned 404 at fetch time. Public materials describe dHEDGE pools as ERC-20 tokenized pools with pro-rata NAV redemption; whether specific-asset in-kind redemption (Enzyme-style) is supported is **unverified** — do not assume parity with Enzyme here without re-checking `docs.chamberfi.com` directly. | **Unverified** — not found in available sources. |
| **Set Protocol / Index Coop** | Fee logic lives in issuance modules, not a single "vault" contract — e.g. `DebtIssuanceModuleV2` lets the manager set issue/redeem fees and define custom issuance logic via a manager hook ([Index Coop docs, DebtIssuanceModuleV2](https://docs.indexcoop.com/index-coop-community-handbook/protocol/index-protocol/modules/debt-issuance-module-v2)). **Unverified**: whether a classical HWM concept applies at all — Set's fee model is closer to per-transaction issue/redeem/streaming fees than a performance-fee-with-HWM model; I found no evidence of HWM logic in Set/Index Protocol modules. Treat "no HWM in Set Protocol" as the likely answer but unconfirmed. | **Yes, this is Set's defining mechanic.** `BasicIssuanceModule.redeem()` "redeems the SetToken's positions and sends the components of the given quantity to the caller" — direct, literal in-kind delivery of underlying component tokens, no synthetic/cash-equivalent path ([Index Coop docs, Basic Issuance Module](https://docs.indexcoop.com/index-coop-community-handbook/protocol/index-protocol/modules/basic-issuance-module)). `issue()` requires the issuer to have pre-approved and supplied the exact component basket to the module. | **Unverified** — documentation available doesn't address module-level coordination between an active `TradeModule`/`GeneralIndexModule` rebalance and concurrent issuance/redemption calls. This is a real gap worth a direct question to Set/Index Coop's contract source if this pattern is adopted, since Set's in-kind issuance model is architecturally closest to what a rebalance-aware index vault needs. |
| **Yearn v3** | **No classical share-price HWM found.** Fees are delegated to a pluggable `Accountant` periphery contract invoked on every `report()`; the accountant is handed the strategy and its gain/loss for that report and returns fees/refunds to charge — a **per-report, per-strategy profit-based model**, not a fund-wide share-price watermark ([Yearn v3 TECH_SPEC.md](https://github.com/yearn/yearn-vaults-v3/blob/master/TECH_SPEC.md), [vault-periphery repo](https://github.com/yearn/vault-periphery)). Fees are collected by **minting vault shares** to the accountant/recipient, then profit is linearly unlocked over a configurable locking period so price-per-share doesn't jump discontinuously ("profit unlocking" — new fee shares also unlock over the same window so PPS doesn't drop). I could not locate the specific `Accountant.sol` HWM variable (404 on direct fetch) — **unverified** whether any first-party Accountant implementation adds an optional HWM on top of the base per-report model; the vault core itself has none. | Not applicable in the vault-token sense — Yearn v3 vaults are ERC-4626, single-asset (deposit asset in, same asset out); no basket/in-kind redemption concept exists at this layer. | Deposits/withdrawals go through standard ERC-4626 entrypoints with the vault's shared reentrancy lock; the tech spec doesn't describe blocking deposits/withdrawals during a strategy's `report()` call, and profit-unlocking is explicitly designed so PPS doesn't jump — implying deposits/withdrawals are *not* gated around reporting, unlike a discrete-rebalance model. **Not directly analogous** to an index vault's multi-asset weighted-vote rebalance, since Yearn v3 strategies don't hold a governed basket. |

**Read-across for the vault design:** Every mature protocol with a performance fee
(Enzyme, dHEDGE) uses a **single global/per-vault HWM**, not per-depositor — this is worth
weighing against the brief's `(member, operator)` HWM key (C-3/CM-4 in `BUILD-PLAN.md`), which
is a materially different design point than any precedent found here. None of these four
protocols implement a cross-vault-portable, per-(depositor,operator) HWM registry — that
appears to be a novel mechanism for this project, not one with direct prior art. Flagging this
as a design point to stress-test in the threat model, not a reason to change course (the
brief's cross-vault-portability requirement is a real design goal these single-vault protocols
don't share), but the team should not assume "this is how HWMs are normally done" — normal is
simpler than what's being built here.

---

## 4. Swing pricing and forward pricing on-chain precedent

**Swing pricing: no on-chain precedent found. Clear negative result.** Targeted searches for
"swing pricing" combined with DeFi/smart-contract/vault terms returned no protocol
implementing TradFi-style swing pricing (dynamically adjusting the redemption NAV itself,
downward, based on net redemption flow size, to pass transaction/liquidity costs to redeeming
investors). What on-chain protocols use instead, as a *substitute* mechanism, is a flat or
tiered **redemption fee** charged to redeemers during stress, which is economically related
(both aim to prevent redeeming investors from being subsidized by remaining investors) but
mechanically much simpler — a fee schedule, not a NAV adjustment
([ChainScore glossary, Redemption Fee](https://chainscorelabs.com/glossary/defi-synthetic-assets-and-derivatives/protocol-economics-and-governance/redemption-fee)).
If the project wants swing-pricing-like behavior, it will need to be designed from the mutual-
fund literature directly rather than adapted from an existing contract — there is nothing to
copy.

**Forward pricing: real precedent, via ERC-7540.** ERC-7540 ("Asynchronous ERC-4626 Tokenized
Vaults"), finalized June 2024, is the closest on-chain analog to forward pricing. It adds a
request → NAV-update → claim flow on top of ERC-4626: a redemption request is submitted, NAV is
updated by a valuation process (oracle, curator, or off-chain source), and the redeemer claims
shares/assets at that newly-settled NAV rather than the NAV at request time
([FinanceFeeds, ERC-7540 credit vaults overview](https://financefeeds.com/5-most-capital-efficient-on-chain-credit-protocols-built-on-the-erc-7540-vault-standard/),
[Lagoon Finance, ERC-7540 explainer](https://lagoon.finance/blog/erc-7540-explained)). This is
used in production primarily for real-world-asset (private credit, treasury bill) vaults where
settlement inherently can't be atomic — TVL range cited from $129M to $1.6bn across five
protocols using the pattern
([FinanceFeeds](https://financefeeds.com/5-most-capital-efficient-on-chain-credit-protocols-built-on-the-erc-7540-vault-standard/)).
This maps closely onto the project's own C-4 commitment (two-mode exit: instant settlement
when no pending proposal, forward-priced settlement to post-rebalance NAV otherwise) — ERC-7540
is worth reviewing directly as an interface-compatibility reference even though C-1 already
rules out full ERC-4626 compliance. **The request/claim pattern, not full interface conformance,
is the useful transferable piece.**

**Mutual-fund literature note (not on-chain, but translatable):** swing pricing's core
mechanism — charging estimated transaction/liquidity costs to the redeeming cohort rather than
diluting remainers — translates directly to on-chain design as "redemption fee scaled to
redemption size relative to available liquidity," which is implementable today without needing
a NAV-adjustment mechanism at all. This may be the more tractable design than literal swing
pricing for a first version.

---

## 5. Commit-reveal voting: safe patterns and current signal against the naive approach

**Baseline pattern.** Standard commit-reveal: phase 1, voter submits `hash(choice, salt)`
(optionally with a bonded deposit); phase 2 (after commit deadline), voter reveals `(choice,
salt)`, contract verifies the hash and tallies. **ERC-5732** standardizes only the commit half
(`commit(bytes32)` / optional `commitFrom`) and deliberately leaves reveal logic, deadline
enforcement, and non-revealer handling unspecified — it explicitly recommends "proper time gaps
... to avoid frontrunning" but offers no guidance on penalizing non-reveal
([EIP-5732](https://eips.ethereum.org/EIPS/eip-5732)). That gap is exactly the griefing surface
the project needs to close itself.

**Best-known bonded/slashing implementation: Kleros courts.** Kleros juror voting uses
commit-reveal with a token stake; jurors who fail to reveal are "penalized as if they didn't
vote at all" and lose PNK stake as if incoherent with the majority — reveal-deadline handling
is enforced by the dispute's fixed reveal-period window, and non-reveal is economically
punished via the same coherence/incoherence mechanism used for wrong votes, not a separate
penalty path ([Gate Learn, Kleros PNK explainer](https://www.gate.com/learn/articles/what-is-kleros-all-you-need-to-know-about-pnk/3335)).
This is the most battle-tested "safe" pattern found: **require a bonded stake at commit time,
tie non-reveal to the same slashing logic as an incoherent/losing vote, don't create a separate
lighter penalty for non-reveal** (a lighter penalty invites rational non-reveal when a voter
expects to be on the losing/minority side).

**Decision-relevant finding: even Kleros is abandoning commit-reveal.** As of July–August 2026,
Kleros is migrating its juror voting from commit-reveal to **Shutter API threshold-encrypted
("shielded") voting**
([Kleros blog, July 2026 migration announcement](https://blog.kleros.io/july-2026-scout-incentives-migration-to-the-new-hidden-voting-court/),
[Shutter Network blog on the migration](https://blog.shutter.network/kleros-juror-voting-is-getting-a-privacy-upgrade-with-shutter-api/)).
Stated reasons: commit-reveal required two transactions and two gas payments per voter, created
UX friction, and **"some votes were lost simply because someone forgot to reveal"** — i.e., the
non-reveal griefing/forgetting problem was real in production even with slashing incentives in
place, not just theoretical. Shutter's approach uses a decentralized "Keyper" network for
threshold decryption of votes after a deadline, giving privacy-until-tally without requiring a
second user-initiated transaction.

**Implication for Sprint 2 (Governance module).** This doesn't necessarily mean the project
should adopt threshold encryption for Sprint 2 — that's new infrastructure dependency (external
Keyper network) the brief doesn't ask for, and commit-reveal is still directly implementable in
pure Solidity where Shutter is not. But it's a concrete signal that **non-reveal-by-forgetting,
not just non-reveal-by-strategic-griefing, is a real failure mode in a live, incentive-aligned,
audited system**, which should inform two Sprint 2 choices already scoped in
`BUILD-PLAN.md`: (a) the reveal-deadline forfeiture mechanic should assume a meaningful fraction
of legitimate voters will simply fail to reveal in time, not only adversarial griefers; (b) the
existing "standing defaults" mechanism (K-3, VO-2) is doing double duty as a mitigation for
exactly this failure mode, and its liveness-floor tradeoff should be weighed with that in mind.
Recommend re-reading K-3 with this evidence attached rather than treating it as a purely
theoretical corner case.

**Other prior art, not adopted as pattern but worth citing:** **MACI** (Minimal Anti-Collusion
Infrastructure) solves a different problem — bribery/collusion resistance via encrypted votes
and key-changing, not reveal-forgetting — using zk-SNARKs and off-chain tallying with on-chain
proof verification ([MACI docs](https://maci.pse.dev/docs/introduction),
[privacy-ethereum/maci](https://github.com/privacy-ethereum/maci)). Heavier infrastructure than
this project needs for Sprint 2; noted for completeness, not recommended.

---

## Summary of findings that should change or stress-test an architectural decision

1. **x402 has no contract-layer interaction with `VaultCore`/`IExecutionAdapter`.** It's purely
   an API-metering concern for Sprint 7. No Sprint 1 impact — but don't let it get conflated
   with on-chain payment logic in `docs/ARCHITECTURE.md`.
2. **`IExecutionAdapter` cannot be a thin `(target, calldata)` pass-through.** Real, recent,
   large losses (SwapNet/Aperture, Jan 2026, ~$13-17M; Dexible, 2023; Unizen, 2024; LI.FI) all
   share the same root cause: trusting an off-chain-supplied call target and calldata without
   an on-chain target/selector whitelist. The adapter interface needs a governance-controlled
   allowlist of `(router, selector)` pairs and an independently-enforced `minOut` via
   balance-delta check, not reliance on calldata-embedded slippage params alone. This is a
   concrete change to how Sprint 4's `IExecutionAdapter` should be scoped, and worth flagging to
   the threat model now (EX-1..4 rows) even though the interface itself ships in Sprint 4.
3. **No prior art for a per-(depositor, operator) high-water mark.** Enzyme and dHEDGE both use
   a single global HWM per vault. The project's CM-4/C-3 design (cross-vault-portable,
   per-member-per-operator HWM) is not validated by precedent — it's a novel mechanism. Not a
   reason to abandon it, but the threat model should treat it as unproven rather than "the
   standard approach," and extra invariant-testing weight should go here in Sprint 3.
4. **Swing pricing has zero on-chain precedent** — confirmed negative result, not a research
   gap. If the project wants swing-pricing-like protection against oversized redemptions, it
   will be original design work informed by mutual-fund literature (redemption-fee-scaled-to-
   flow-size is the pragmatic on-chain substitute), not adaptation of an existing contract.
5. **Forward pricing has real precedent (ERC-7540)** and its request/claim pattern is worth
   reviewing directly for interface-shape ideas, even though C-1 already rules out full
   ERC-4626/ERC-7540 compliance.
6. **Non-reveal-by-forgetting is empirically a bigger problem than non-reveal-by-griefing** —
   evidenced by Kleros, a mature/audited/incentive-aligned system, abandoning commit-reveal in
   2026 partly for this reason. Sprint 2's reveal-forfeiture design and the standing-defaults
   liveness mechanism (K-3) should be sized against "well-intentioned voters forget," not just
   "adversaries strategically withhold."
