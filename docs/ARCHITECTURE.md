# Architecture — Agent-Governed Index Vault Protocol

Sprint 1 artifact 1.1. Companion: [THREAT-MODEL.md](THREAT-MODEL.md). Decisions labeled
**C-n** (commitments) and **K-n** (brief contradictions, resolved or accepted) trace back to
[BUILD-PLAN.md](../BUILD-PLAN.md).

---

## 1. System overview

Permissionless vaults in which AI agents pool USDC into spot crypto index baskets and govern
rebalances by stake-weighted vote. Settlement asset is USDC. Off-chain metered access (analytics,
leaderboard, signal feeds) is paid via x402; **x402 never appears in the contract layer** (§9).

```
                    ┌─────────────────────────────────────────────┐
                    │                VaultFactory                 │  permissionless deploy
                    └──────────────────┬──────────────────────────┘
                                       │ creates
┌───────────────┐   auth    ┌──────────▼──────────┐    prices   ┌──────────────────┐
│  Governance   │◄─────────►│      VaultCore      │◄────────────│ OracleAggregator │
│ commit-reveal │  executes │ shares/NAV/deposits │   + breaker │  multi-source    │
│ quorum/deleg. │  via      │ redemptions/capacity│             │  median          │
└───────┬───────┘  timelock └──┬───────┬──────────┘             └──────────────────┘
        │                      │       │
        │              settles │       │ marks/identity
        ▼                      ▼       ▼
┌───────────────┐   ┌────────────────┐  ┌──────────────────┐
│ SubVaultReg.  │   │ IExecutionAdapter│ │ OperatorRegistry │
│ depth ≤ 3     │   │ venue-agnostic  │  │ (member,operator)│
│ recursion blk │   │ Base agg. first │  │ HWM, leaderboard │
└───────────────┘   └────────────────┘  └──────────────────┘
```

Sprint 1 implements **VaultCore** concretely; every other box is an interface with a stub.

## 2. Module boundaries and sprint mapping

| Module | Responsibility | Concrete in |
| --- | --- | --- |
| `VaultCore` | shares, NAV, deposits, observation window, redemptions (two-mode), exit fee, capacity cap, creator gate | Sprint 1 |
| `Governance` | proposals, commit-reveal, quorum, standing defaults, delegation, timelock | Sprint 2 |
| `FeeEngine` | 10% realized-profit fee, crystallization at redemption | Sprint 3 |
| `OperatorRegistry` | operator identity, cross-vault `(member, operator)` marks, aggregate leaderboard | Sprint 3 |
| `OracleAggregator` | multi-source median, staleness circuit breaker | Sprint 4 |
| `IExecutionAdapter` | venue-agnostic swap execution; Base DEX-aggregation adapter first | Sprint 4 |
| `SubVaultRegistry` | parent/child links, depth cap 3, recursion block, fee-stack cap, quorum inheritance | Sprint 5 |

Interfaces cross module boundaries; storage never does. Each module is deployed as its own
contract; VaultCore holds immutable references set at construction (C-3 for the registry).

## 3. Chain- and venue-agnostic posture (C-2)

- `block.timestamp` is the only clock. No `block.number` arithmetic anywhere.
- No hardcoded token, router, or oracle addresses; all injected at construction or via
  timelocked config.
- No chain-specific precompiles or opcode assumptions beyond Cancun.
- All venue contact goes through `IExecutionAdapter`. The Base aggregation router integration
  is *an adapter implementation*, not a dependency of VaultCore. No CEX integrations, ever.
  **Proven, not asserted:** two structurally-different adapters — `AggregationRouterAdapter`
  (off-chain-routed calldata) and `DirectPoolAdapter` (on-chain V2-pool math) — both drive
  `executeRebalance` identically behind the interface (`test/DirectPoolAdapter.t.sol`).
- USDC is referenced as `IERC20 immutable settlementAsset` (6 decimals assumed **only** via a
  decimals read at construction; internal math is WAD 1e18).

## 4. Share and NAV accounting

### 4.1 Not ERC-4626 (C-1)

In-kind redemption, swing pricing, and forward pricing each break `previewRedeem`/
`previewWithdraw` round-trip guarantees, so the vault makes **no 4626 compliance claim**. It
exposes 4626-shaped read-only views (`totalAssets`, `convertToShares`, `convertToAssets`) for
tooling, documented as indicative-only.

### 4.2 Definitions

```
NAV        = Σ_i balance_i × price_i  +  idleUSDC          (USDC terms, WAD internally)
NAVps      = NAV × WAD / totalSupply                        (WAD; first deposit: 1e18)
```

`price_i` comes from `OracleAggregator` (multi-source median). Sequestered (pending) deposits
are **excluded** from NAV and from `idleUSDC` until activation (§5). If the oracle breaker is
tripped, every function that reads NAV reverts — deposits, redemptions, proposal execution —
by design (K-4).

### 4.3 Deposit

First-time deposit by an agent enters the **observation window** (§5). Post-window (or
window-skipped, or repeat deposit):

```
sharesMinted = amount × totalSupply / NAV        (amount × WAD / 1e18 if supply == 0)
```

minted at the NAV of the activation transaction — forward pricing on entry, so a depositor can
never mint against a stale valuation they observed 4 hours earlier.

### 4.4 Redemption — two-mode settlement (C-4, resolves K-1)

Shares burn at **settlement**, never at request.

- **Mode I (instant):** no passed-but-unexecuted rebalance exists → the request settles in the
  same transaction at current NAV. This is the common path and is what "instant exit at
  pro-rata NAV" means here.
- **Mode F (forward):** a rebalance has passed its vote but not yet executed → the request is
  queued and settles at **post-execution NAV**. This closes the free option of exiting at
  pre-rebalance prices while knowing the rebalance outcome. Queued requests are irrevocable and
  settle automatically in the rebalance-execution transaction.

Between request and settlement in Mode F, the shares remain outstanding (still earn/lose with
the vault, still count in `totalSupply`) but are **locked**: non-transferable and excluded from
voting-eligible stake.

### 4.5 In-kind redemption

Default payout is pro-rata in kind: for `s` shares of supply `T`, the redeemer receives
`s/T × balance_i` of every basket asset plus `s/T × idleUSDC`, minus the exit fee. In-kind is
the manipulation-resistant path (no forced selling, so no slippage borne by remainers). A
USDC-cash redemption path may be offered later **through the execution adapter**, and only that
path is subject to swing pricing (§4.7).

### 4.6 Exit fee

```
fee(t)  = feeMax × max(0, 1 − t / decayPeriod)      feeMax ≤ 1% (protocol cap), t = tenure
```

`feeMax` and `decayPeriod` are vault-configurable at creation (immutable after funding, K-2
regime). The fee is retained **in the vault** — the redeemer's shares burn in full but the fee
fraction of their pro-rata slice stays, mechanically accruing to remaining members' NAVps. It is
never routed to the operator, and is waived when the redeemer is the last member (no one to
accrue to; routing it anywhere else would violate the operator prohibition).

Invariant: **NAVps for remaining members is non-decreasing across any redemption.**

### 4.7 Swing pricing (cash redemptions only)

For a cash redemption of fraction `x = redeemValue / NAV` exceeding threshold `θ`:

```
payout = s/T × NAV × (1 − σ(x)) ,   σ(x) = σmax × (x − θ) / (1 − θ)   for x > θ, else 0
```

`θ` (default 10%) and `σmax` are vault-configurable with protocol caps. The swing haircut, like
the exit fee, stays in the vault. In-kind redemptions bypass swing pricing entirely — the
redeemer carries their own execution cost.

## 5. Entry: observation window

- An agent's **first** deposit into a vault escrows the USDC as a *pending deposit*: excluded
  from NAV, zero shares, zero voting or proposal rights. After 4 hours the depositor (or anyone)
  calls `activate`, minting shares at activation NAV (§4.3). Pending deposits are cancellable
  before activation.
- **Skip:** an agent may irrevocably opt in to skipping the window for a given vault — shares
  mint immediately. The opt-in is once per agent per vault and cannot be undone. (Reading of the
  brief: "once per agent per vault" scopes the window/skip to first entry; repeat deposits by an
  existing member mint immediately. Flash-deposit governance attacks are defended by
  proposal-time stake snapshots in Sprint 2, not by the window — the window is a social
  observation mechanism, not the Sybil defense.)

## 6. Core mechanics — placement of each rule

| Rule | Where enforced |
| --- | --- |
| Creator locks ≥5% stake | VaultCore: **withdrawal gate**, not top-up obligation. Creator redemptions revert if they would take creator share below 5% while ≥1 non-creator member remains. Passive dilution below 5% by others' deposits is allowed and simply freezes creator withdrawals until restored. |
| Performance fee, 10% of realized profit | FeeEngine at redemption (crystallization on realization only). HWM per `(member, operator)` — see §7. |
| Proposal rights scale with stake | Governance, against the same voting-eligible stake measure as quorum. |
| Quorum: participating stake, 25% protocol floor | Governance. Denominator = voting-eligible stake at the proposal snapshot (excludes pending deposits §5 and locked Mode-F shares §4.4). Standing defaults never count in the quorum numerator (K-3 accepted). |
| <5 members: absolute signer counts | Governance switches quorum to N-of-M signers below the threshold. The 5-member boundary itself is a manipulation surface — threat model CM-7. |
| Rules immutable after funding except full consensus + timelock | VaultCore config setters gated on a Governance flag reachable only by 100% of voting-eligible stake + timelock. One permanently offline member ⇒ rules frozen forever (K-2, accepted as intended). |
| Per-vault capacity cap | VaultCore: deposits revert above cap. **Optional** — `capacityCapUsdc == 0` opts out (uncapped); `isCapped()` reports which. |

## 7. Fees and the operator registry (C-3)

VaultCore takes an `IOperatorRegistry immutable` at construction — stubbed in Sprint 1,
concrete in Sprint 3. The reference is load-bearing for three requirements at once: HWM
portability, leaderboard integrity, and anti-Sybil (a mintable fresh identity sheds bad history,
defeating "no cherry-picking").

**Cross-vault HWM semantics.** NAVps is not comparable across vaults, so the portable mark is a
**USDC-denominated loss carryforward** per `(member, operator)`:

```
onRealize(member, op, gain):   fee = 10% × max(0, gain − carry[member][op])
                               carry[member][op] = max(0, carry[member][op] − gain)
onRealize(member, op, loss):   carry[member][op] += loss
```

A member who realized a loss under an operator in vault A pays no performance fee in vault B
until that operator has made them whole. This is the precise sense in which "marks follow
operator identity across vaults." (Sprint 3; recorded here because VaultCore's redemption path
must call into it from day one.)

**Leaderboard.** Operator-level aggregate across **all** vaults sharing the registry;
per-vault opt-out does not exist at the contract level.

## 8. Governance (Sprint 2 — interface committed now)

- **Commit-reveal** on all proposals: commit hash(vote, salt); reveal after commit deadline.
  Unrevealed commits are forfeit (count as abstain) — non-revealers grief only themselves.
- **Standing defaults:** count toward tally, never quorum; expire 72 h after being set; valid
  only for proposals tagged *routine rebalance*. Offline agents auto-abstain otherwise.
- **Delegation:** permitted; a delegate's aggregate received weight is capped at a
  vault-configured fraction of eligible stake (concentration cap).
- **Timelock:** post-vote, vault-configurable, 30-day protocol hard cap. Mode-F redemption
  queueing (§4.4) begins at vote passage, not at timelock expiry.

## 9. x402 boundary

x402 lives entirely in `apps/api`: metered HTTP access to indexer-derived data (vault
analytics, operator leaderboard, signals) settled in USDC on Base via the standard x402
facilitator flow. **The contracts have no x402 dependency and no HTTP-payment coupling.**
Deposits are plain on-chain USDC transfers. If x402-initiated deposits are ever wanted, they
compose externally (an agent pays itself into a wallet, then deposits); the vault does not
special-case them.

## 10. Sub-vaults (Sprint 5 — constraints recorded now)

- Parent allocates capital to child; child governs its own mandate. Depth hard-capped at 3.
- **Recursive deposits blocked at contract level:** a vault cannot deposit into any vault whose
  parent chain includes itself (registry walk at deposit time; depth ≤ 3 keeps the walk O(3)).
- Cumulative effective fee across the chain is computed on-chain and capped; frontend displays it.
- Parent redemptions draw idle stables before touching child positions.
- Child quorum floors inherit `max(childFloor, parentFloor)`.

## 11. Safety systems

- **OracleAggregator:** median of ≥3 independent sources per asset; per-source staleness bound;
  if fewer than a quorum of sources are fresh, the **circuit breaker trips and freezes
  everything including exits** (K-4 — accepted: an attacker who can induce staleness can trap
  capital; the multi-source median is the mitigation, and no escape hatch will be added, since
  any escape hatch is exactly the stale-price exit the breaker exists to prevent).
- **Capacity caps** per vault (§6).
- **Pending capital is never frozen.** `cancelPending` reads no oracle, so a depositor can always
  reclaim an un-activated (observation-window) deposit even while the breaker is tripped — the
  freeze traps only *active* share capital, not capital still in the window (verified by
  `test_pendingDepositCancellableDuringOracleFreeze`; resolves consumer-UX open question OQ-1).
- **Leaderboard integrity** via the shared registry (§7).

## 12. Upgrade posture

**None.** No proxies, no upgradeable contracts. Implementations are immutable; the only
mutable surface is vault config behind full-consensus + timelock (§6). Protocol iteration
happens by deploying new versions via the factory; migration is voluntary per vault.

## 13. Precision and rounding

Internal math in WAD (1e18); USDC amounts scaled at the boundary. Rounding is always **against
the actor** (mint rounds shares down, redemption payout rounds down, fees round up) so dust
accrues to the vault, preserving the §4.6 invariant.

## 14. Open items feeding later sprints

1. Sprint 2: proposal-time stake snapshot mechanism (checkpointing vs. per-proposal copy).
2. Sprint 3: registry trust model — who may deploy vaults against the canonical registry
   (permissionless, but leaderboard only aggregates registry-attested vault deployments from
   the canonical factory, else scores are forgeable).
3. Sprint 4: adapter calldata safety — off-chain-routed swap calldata must be constrained
   (allow-listed routers, minOut enforced by the adapter itself, never by the router alone).
4. Research findings ([RESEARCH-SPRINT1.md](RESEARCH-SPRINT1.md)) now folded in:
   - **C-4 has precedent**: ERC-7540's request/claim pattern maps directly onto Mode-F
     forward-priced exits (full 7540 compliance stays ruled out with C-1). Swing pricing has
     **zero** on-chain precedent — we are first; extra Sprint 6 scrutiny.
   - **§14.3 confirmed and hardened**: a live Jan-2026 aggregator-adapter exploit class
     (SwapNet/Aperture, ~$13–17M; earlier Dexible, Unizen, LI.FI) shares one root cause —
     trusting off-chain-supplied call targets/calldata. `IExecutionAdapter` therefore carries a
     governance-controlled (router, selector) allowlist and balance-delta-enforced minOut; never
     a thin (target, calldata) pass-through.
   - **§9 confirmed**: x402 V2 (June 2026) uses dedicated PAYMENT-* headers and settles USDC via
     EIP-3009 `transferWithAuthorization` executed by the facilitator — no contract-layer
     coupling, as designed.
   - **§7 is novel**: no prior art for per-(member, operator) HWM — Enzyme/dHEDGE use global
     per-vault marks. Treated as an unvalidated mechanism: extra invariant weight in Sprint 3.
   - **§8 sizing input**: Kleros abandoned commit-reveal (2026) because voters *forget* to
     reveal, not only grief. Sprint 2 must size reveal windows and forfeiture accordingly.
