# Sprint 6 Security Review — Oracle / Execution / Sub-Vault layers

<!-- doc-claims: historical record. The `file:line` citations below describe the tree as reviewed at Sprint 6 and are deliberately NOT re-pointed as the code moves; re-pointing them would falsify the record. `scripts/check-doc-claims.mjs` skips this file. -->

Adversarial review by **Security Agent B**. Scope (Sprints 4–5): `src/OracleAggregator.sol`,
`src/AggregationRouterAdapter.sol`, the sub-vault surface of `src/VaultCore.sol`
(`executeRebalance`, `allocateToChild`, `redeemFromChild`, `_redeemChildMeasured`,
`_childValueWad`, `pullChildEscrow`, and the SV-5 shortfall-unwind inside `_settleExit`),
`src/SubVaultRegistry.sol`, and `VaultFactory.createChildVault`.

Method: every candidate traced against the actual code before write-up. Accepted threat-model
rows (K-1..K-4, SF-2) are **not** re-reported unless a NEW consequence beyond the documented one
was found. Sprint-1 findings H-1/H-2/M-1/M-2 were verified as fixed (see §Verified sound), not
re-reported. Line numbers are against the code as reviewed.

Priority attack targets from the brief (SF-2 induction cost, SV-7 look-through, EE-5 latency,
execution misattribution, sub-vault accounting) are each answered — see the mapping in
§Priority-target answers.

---

## Findings summary

| # | Sev | File:line | Consequence |
| --- | --- | --- | --- |
| 1 | **H** | `VaultCore.sol:245-258` | `_childValueWad` is non-recursive → a depth-3 grandchild's value is omitted from the root's NAV; standing NAVps misprice enables deposit-side extraction and shortchanges exiters. |
| 2 | **H** | `OracleAggregator.sol:51,67` | `maxStaleness` upper-unbounded (`uint32`) → `block.timestamp - maxStaleness` underflows → `priceWad` panics permanently. Immutable oracle = permanent total lockup honeypot, distinct from K-4/SF-2. |
| 3 | **M** | `VaultCore.sol:685-691` | Rebalance leftover-sweep credits *any* physical `tokenIn` excess over accounting into `assetBalance`, absorbing EE-6 escrowed slices (and donations) → NAV overstatement / eventual insolvency. |
| 4 | **M** | `VaultCore.sol:622-623` | A child in its rebalance timelock (Mode-F) makes `_redeemChildMeasured` revert `ChildSettlementPending`, hard-blocking any parent member exit that needs child unwind (idle insufficient). New consequence vs SV-5. |
| 5 | **M** | `VaultCore.sol:485-494, 543-546` | In the shortfall unwind (`credit=false`), a child that EE-6-escrows a slice back returns delta 0; `shortfallWad` is still decremented → the exiter is silently shortchanged and the value strands to remainers. |
| 6 | **M** | `OracleAggregator.sol:49-50,72,87` | No upper price-sanity band + even-`k` average-of-two-middle + no enforced `≥3`/`quorum≥2` floor → one source at small `k` can move or overflow-freeze the median. Contradicts §11 ("≥3") and SF-1 ("⌈n/2⌉"). |
| 7 | **M** | `VaultCore.sol:288, 339-343, 716-723` | EE-5 latency arb: a repeat depositor mints extra shares against a stale-low `navWad`; the exit fee decays to zero (and may be 0), so the profitable-drift threshold is gas, not the exit fee. |
| 8 | **L** | `VaultCore.sol:227-258` | NAV cost is O(children × basketAssets × sources) with no constructor caps on basket/source count; `navWad` runs twice per deposit and per child twice in `_settleExit`. Gas-DoS surface; aggravated by any recursive fix for #1. |

---

## Finding 1 — `_childValueWad` is non-recursive: a depth-3 grandchild's value vanishes from the root NAV (H)

**File:** `VaultCore.sol:245-258` (`_childValueWad`), consumed by `navWad` (`236`) and
`_settleExit` (`444-446`, `478-495`).
**Confidence:** high.

`_childValueWad(child)` values a child position from the child's *internal* accounting — its
`idleUsdc` and per-basket-asset `assetBalance`, priced by the parent's own oracle:

```solidity
uint256 childNav = c.idleUsdc() * usdcScalar;
uint256 n = c.basketLength();
for (uint256 i; i < n; ++i) {
    address a = c.basketAssets(i);
    uint256 bal = c.assetBalance(a);
    if (bal != 0) childNav += bal * oracle.priceWad(a) / assetUnit[a];
}
return childNav * myShares / ts;
```

It reads the child's **idle + basket** but never the child's own `childVaults` positions. The
depth cap permits three levels (`SubVaultRegistry.MAX_DEPTH = 3`: registerChild allows
`parentDepth+1 < 3`, i.e. depths 0,1,2). A depth-1 child can therefore itself be a parent of a
depth-2 grandchild (`createChildVault(p, child)` passes the depth check with `parentDepth=1`).
When that child allocates capital to its grandchild (`allocateToChild`), the child's `idleUsdc`
falls and it gains a `childVaults` position — **which `_childValueWad` does not read**. The
grandchild's value is silently omitted from the child's look-through value, and therefore from
the root's `navWad`.

**Exploit / impact (state).**
- Root NAV = idle + basket + Σ children. Suppose child C (parent P's only child) holds
  1,000,000 USDC of value, of which C has allocated 600,000 to grandchild G. After the
  allocation, `C.idleUsdc()` and `C.assetBalance` reflect only the 400,000 that stayed in C;
  `_childValueWad(C)` returns ~400,000·(P's fraction). P's `navWad` is understated by
  ~600,000·(P's fraction) **persistently** — nothing ever re-discovers it.
- **Depositor extraction.** A new depositor into P mints `amount·ts/navWad` against the
  understated `navWad` → receives more shares than fair → dilutes existing P members and captures
  a share of the hidden 600,000. `navWad`'s donation defense (EE-1) does not help here: the value
  is *real and owned*, merely un-summed.
- **Exiter loss.** A P member exiting receives their pro-rata of the understated NAV — they lose
  their claim on the grandchild slice; §4.6 still holds (the loss accrues to remainers), but the
  exiter is shortchanged relative to true value.
- **Shortfall over-redemption.** In `_settleExit`, `cv = _childValueWad(child)` is understated, so
  `cs = sharesOf(this)·takeWad/cv` redeems *more child shares per unit of shortfall* than the true
  ratio warrants (the `takeWad ≤ cv` clamp keeps `cs ≤ sharesOf`, so it does not revert — but it
  over-unwinds the child at a mispriced internal rate).

This is the flagship SV-7 mechanism failing at exactly the depth the feature advertises. The
threat-model SV-7 mitigation ("parent prices child through the same asset-level look-through") is
correct for one level and wrong for two.

**Minimal fix.** Make the look-through recursive but depth-bounded (the `MAX_DEPTH=3` cap makes it
O(3) and non-exponential): inside `_childValueWad`, after summing idle+basket, also add
`Σ_j _childValueWad(c.childVaults(j))` — i.e. recurse into the child's children, pricing every
level through the parent's oracle. Bound the recursion by the registry depth so a malformed edge
cannot spin it. See Finding 8 for the gas interaction — the recursion must stay depth-capped.

---

## Finding 2 — `maxStaleness` upper-unbounded → arithmetic underflow permanently freezes the oracle (H)

**File:** `OracleAggregator.sol:51` (constructor validation), `:67` (underflow site).
**Confidence:** high.

The constructor validates only the lower bound of `maxStaleness`:

```solidity
require(maxStaleness_[i] > 0, BadOracleConfig());   // line 51 — no upper bound
```

`maxStaleness` is `uint32` (max 4,294,967,295 ≈ 4.29e9). Current `block.timestamp` ≈ 1.787e9 and
stays far below 4.29e9 for decades. In `priceWad`:

```solidity
uint256 minUpdated = block.timestamp - cfg.maxStaleness;   // line 67
```

If any `maxStaleness > block.timestamp`, this subtraction underflows and **panics (0x11)** under
checked arithmetic — every call to `priceWad` reverts unconditionally, via a Panic, *not* the
designed `StaleOracle` breaker. Because the oracle config has no setters (immutable by design) and
`VaultCore.oracle` is immutable, there is no recovery.

**Honeypot sequence (permanent total lockup, state-verified).**
1. Deploy `OracleAggregator` with `maxStaleness_[i] = 4e9` for the basket asset. Constructor
   passes (only `> 0` checked).
2. Deploy a `VaultCore` against it. Members `deposit`: while every `assetBalance == 0`, `navWad`
   skips `priceWad` (guarded by `if (bal != 0)` at `VaultCore.sol:233`) and returns idle only —
   **deposits succeed**, TVL accumulates.
3. Governance runs one `executeRebalance` (USDC → basket asset). `executeRebalance` never calls
   `navWad`/`priceWad` (verified: it debits/credits internal accounting directly), so it
   **succeeds** and sets `assetBalance > 0`.
4. From this point every NAV-reading path — `deposit`, `requestExit`/`_settleExit`,
   `navWad`, the 4626 views — hits `priceWad` → underflow panic → reverts **forever**. All
   deposited capital is trapped with no exit.

**Why this is a NEW consequence (not K-4/SF-2).** K-4/SF-2 accept a freeze from *induced or
honest staleness*, mitigated by source count and reversible when sources refresh. This is a
*deterministic, source-independent, irreversible* panic from a single unvalidated config integer
— it fires even with perfectly fresh, honest sources, and no source behaviour can clear it. It is
also a distinct, cheaper honeypot than H-1 (needs no malicious module, only a config value the
constructor accepts).

**Minimal fix.** Upper-bound `maxStaleness_[i]` in the constructor (e.g.
`require(maxStaleness_[i] > 0 && maxStaleness_[i] <= 7 days, BadOracleConfig())`), or compute
`minUpdated` saturating (`block.timestamp > maxStaleness ? block.timestamp - maxStaleness : 0`).
A sane protocol ceiling on staleness is the correct fix — a multi-year staleness bound is never
legitimate.

---

## Finding 3 — Rebalance leftover-sweep absorbs EE-6 escrowed slices (and donations) into `assetBalance` → NAV overstatement / insolvency (M)

**File:** `VaultCore.sol:685-691` (the unspent-input sweep in `executeRebalance`).
**Confidence:** high on the mechanism; medium on likelihood (needs escrow + a rebalance on that
asset).

After each swap, the sweep reclaims unspent `tokenIn` the adapter returned by comparing physical
balance to internal accounting:

```solidity
uint256 inBal = IERC20Metadata(o.tokenIn).balanceOf(address(this));
uint256 accounted = o.tokenIn == usdc ? idleUsdc + totalPendingUsdc : assetBalance[o.tokenIn];
if (inBal > accounted) {
    uint256 refund = inBal - accounted;
    if (o.tokenIn == usdc) idleUsdc += refund;
    else assetBalance[o.tokenIn] += refund;
}
```

`accounted` for a basket `tokenIn` is `assetBalance[tokenIn]` only. But the vault can physically
hold that token *outside* `assetBalance`: EE-6 escrow. When an in-kind slice transfer fails,
`_settleExit` sets `claimable[member][a] += memberPart` while `assetBalance[a]` was already
decremented by the full slice (`VaultCore.sol:470`) — so the escrowed tokens are physically
present but deliberately **not** in `assetBalance` (correctly excluded from NAV). The sweep's
`inBal > accounted` test cannot distinguish "adapter leftover" from "escrowed-owed tokens": it
credits **both** into `assetBalance`.

**Sequence (state).**
1. A basket token `X` starts blacklisting/reverting on transfer. A member exits; the `X` slice
   fails → `claimable[member][X] = q`, physical `X` held = accounted + `q`.
2. Governance (reasonably) rebalances *out of* `X` (`tokenIn = X`) — precisely when escrow of `X`
   exists.
3. Post-swap sweep: `inBal = assetBalance[X] - spent + q`, `accounted = assetBalance[X]`, so
   `refund = (amountIn - spent) + q`. The escrowed `q` is credited into `assetBalance[X]`.
4. `X` is now double-counted: in NAV (`assetBalance[X]`) **and** owed via `claimable`. NAV is
   overstated by `q`; a later sale of `X` or the member's eventual `claimEscrowed` leaves the
   vault physically short — last claimants cannot be paid (insolvency).

The same mechanism re-opens a narrow donation-into-NAV path (donate `X`, governance rebalance on
`X` absorbs it) that `navWad`'s internal-accounting discipline (EE-1) otherwise closes — lower
severity because `executeRebalance` is governance-gated.

**Minimal fix.** Track escrowed physical holdings per asset (e.g. a `escrowedBalance[asset]`
accumulator incremented alongside `claimable`) and compute
`accounted = assetBalance[tokenIn] + escrowedBalance[tokenIn]` in the sweep; or cap the sweep
refund at the amount actually approved/unspent (`o.amountIn - spent`) rather than "all physical
excess," by measuring `tokenIn` spent from the pre/post adapter balances instead of a
whole-vault balance comparison.

---

## Finding 4 — A child mid-rebalance (Mode-F) hard-reverts parent member exits that need child unwind (M)

**File:** `VaultCore.sol:622-623` in `_redeemChildMeasured`, reached from the SV-5 shortfall loop
(`485`) and `redeemFromChild` (`603`).
**Confidence:** high.

```solidity
VaultCore(child).requestExit(shares);
require(VaultCore(child).queuedExitShares(address(this)) == 0, ChildSettlementPending());
```

If the child currently has a passed-but-unexecuted rebalance, `child.requestExit` takes the
child's **Mode-F** branch (`VaultCore.sol:376-383`): it *queues* the parent's exit
(`queuedExitShares[parent] = shares`) rather than settling. The subsequent `require` then reverts
the entire parent `_settleExit`. The parent member's `requestExit` reverts.

The dominant, no-adversary-needed variant: **any routine child rebalance**, during its
governance timelock + execution window, blocks every parent member exit whose cash need exceeds
parent idle (SV-5 draws idle first, so the child is only touched for the shortfall). This is the
new consequence versus SV-5, which contemplates *bad prices* on child unwind ("no profitable
vector beyond ordinary redemption impact") — not a hard **revert** that denies liveness. It
contradicts the H-1 design commitment that exits are never blockable.

The state rolls back cleanly (no corruption), and the member can retry once the child settles, so
this is bounded per cycle. Aggravator: child governance that keeps proposals perpetually pending
(propose → pass → expire → repeat) can sustain the block indefinitely for members who lack idle
coverage; the parent is usually the child's dominant holder, so sustaining this against the
parent's own vote is hard, which is why the benign-rebalance variant is the real risk.

**Minimal fix.** Do not let a transient child Mode-F state revert an in-flight parent settlement.
Options: (a) skip a child that queues instead of settling and continue the shortfall loop to the
next child, escrowing the un-serviceable remainder and letting the member claim once the child
settles (a `pullChildEscrow`-style crank); or (b) size the parent exit's cash target to what is
*immediately* redeemable and settle the rest via a claimable follow-up, rather than reverting the
whole exit.

---

## Finding 5 — Shortfall unwind strands exiter value when the child EE-6-escrows a slice (M)

**File:** `VaultCore.sol:485-494` (shortfall loop) with `_redeemChildMeasured(child, cs, false)`
at `485`; interacts with `543-546`.
**Confidence:** high on mechanism; medium on likelihood.

In the shortfall unwind the parent redeems child shares with `credit = false` and distributes the
*measured deltas* directly to the exiter:

```solidity
(uint256 childUsdc, uint256[] memory childDeltas) = _redeemChildMeasured(child, cs, false);
usdcPay += childUsdc;
payoutValueWad += childUsdc * usdcScalar;
for (uint256 j; j < childDeltas.length; ++j) { ... slices[j] += childDeltas[j]; ... }
shortfallWad -= takeWad;   // decremented by the full takeWad regardless of what arrived
```

`_redeemChildMeasured` measures deltas as `balanceOf(after) - balanceOf(before)`. If the child's
in-kind transfer of some asset to the parent **fails**, the child's own EE-6 path escrows that
slice in the *child's* `claimable[parent][asset]` and transfers nothing → the parent's measured
`delta = 0` for that asset. But `shortfallWad -= takeWad` still subtracts the full intended value.
Net effect: the exiter's `payoutValueWad`/`slices` omit the escrowed slice, yet the shortfall is
recorded as satisfied → **the exiter is silently underpaid**, and the escrowed value sits in the
child recoverable only later via `pullChildEscrow`, which credits the *parent's* accounting
(benefiting remainers), never the original exiter.

This is the direct answer to the brief's "can `redeemFromChild`/shortfall strand value if the
child escrows (EE-6) a slice back to the parent?" — yes, on the member-exit shortfall path.
Likelihood is bounded (needs a child in-kind transfer to the parent to fail — e.g. a token that
blacklists the parent address or a returndata-bomb caught by the child's `tryTransfer`), but the
consequence is a value transfer away from the exiting member with no accounting trail tying it
back to them.

**Minimal fix.** After `_redeemChildMeasured` in the shortfall loop, reduce `shortfallWad` by the
*measured* value actually received (`childUsdc + Σ value(childDeltas)`), not by the intended
`takeWad`; and/or detect a child escrow (compare requested `cs` value to received value) and
credit the exiter a claimable entry for the shortfall so the later `pullChildEscrow` proceeds can
be routed to them rather than absorbed by remainers.

---

## Finding 6 — Oracle median manipulation surface: no upper price band, even-`k` averaging, no enforced `≥3`/`quorum≥2` floor (M)

**File:** `OracleAggregator.sol:49-50` (source/quorum bounds), `:72` (freshness accept), `:87`
(median).
**Confidence:** high on the code facts; the exploit is config-gated.

Three compounding gaps, all bearing on priority target #1:

1. **No upper price sanity band** (`:72`): `if (p > 0 && updatedAt >= minUpdated)` accepts any
   positive price up to `type(uint256).max`. There is no per-source deviation-band check against
   the running set.
2. **Even-`k` average-of-two-middle** (`:87`):
   `k % 2 == 1 ? fresh[k/2] : (fresh[k/2-1] + fresh[k/2]) / 2`. At small `k` this is fragile — a
   single source at an extreme drags the average by ~half its deviation (e.g. a Chainlink feed
   pinned at its `minAnswer`/`maxAnswer` circuit limit needs no compromise at all), and the
   `(a+b)` sum is checked arithmetic that **panic-overflows** if a source reports a colossal
   value, freezing the asset via panic rather than `StaleOracle`. The `try/catch` at `:71-73`
   guards the *source* call, not the aggregator's own median arithmetic or the downstream
   `navWad` multiply (`VaultCore.sol:233`).
3. **No enforced source/quorum floor** (`:49-50`): the constructor allows `m` as low as 1 and
   `quorum` as low as 1 (`m > 0`, `0 < quorum ≤ m`). A single-source, quorum-1 oracle is
   deployable — directly contradicting ARCHITECTURE §11 ("median of **≥3** independent sources")
   and undercutting SF-1's "compromise of ⌈n/2⌉ sources" bound to "compromise of 1."

**Combined with cheap staleness induction (SF-2 quantified).** The cost to *freeze* an asset is
disabling `(m − quorum + 1)` sources; a creator who sets `quorum = m` (max freshness) makes that
**one** source — and low-liquidity feeds go stale on their own heartbeat. To *move* the median
without freezing, an attacker induces staleness down toward `k = 2`, at which point the even-`k`
average lets a single controlled/pinned source swing the price by half its deviation. So the
practical answer to "how cheaply can an attacker push an asset below quorum / move the median" is:
**as cheaply as one source when the config is tight or small**, well below SF-1's stated bound.

**Minimal fix.** Enforce a real source/quorum floor in the constructor (e.g. `m ≥ 3`,
`quorum ≥ (m/2)+1`) to match §11/SF-1; add an upper price-sanity band (reject a fresh source whose
price deviates beyond X% from the provisional median, or cap prices to a per-asset ceiling) so one
outlier can neither swing an even-`k` average nor overflow the sum; consider using a
lower-median (`fresh[(k-1)/2]`) instead of averaging to remove the even-`k` sum entirely.

---

## Finding 7 — EE-5 latency arbitrage: profitable-drift threshold is gas, not the exit fee (M)

**File:** `VaultCore.sol:288` (immediate-mint branch), `:339-343` (`_mintShares` against
`navWad()`), `:716-723` (`_exitFeeBps` decay), constructor `:195` (exit fee may be 0).
**Confidence:** high.

The threat model (EE-5) defers "the profitable-drift threshold vs. exit fee" to Sprint 6. The
answer is that the exit fee does **not** bound it:

- A repeat depositor (or any `windowCleared` member) mints immediately at current `navWad`
  (`:288` → `:339`). `navWad` reads the oracle median, which lags real price within `maxStaleness`.
  When the oracle is stale-**low** relative to true value (median lagging a real appreciation),
  the depositor mints `amount·ts/navWad` → **more shares than fair**, a permanent claim on the
  pool.
- To realise it the attacker need not time an exit against the oracle: the extra shares dilute
  every other member permanently. `_exitFeeBps` decays linearly to zero at `exitFeeDecayPeriod`
  (`:721`), and `exitFeeMaxBps` may legitimately be **0** (`constructor:195` permits it), so a
  patient attacker simply holds past the decay and exits free.

Therefore the profitability condition is **favorable oracle-vs-true drift > gas**, not
`drift > exitFeeMax (≤1%)`. The observation window does not help: it gates only the *first* entry
per agent; repeat deposits mint immediately. For volatile crypto baskets, intra-heartbeat /
intra-deviation drift (Chainlink deviation thresholds are commonly ~0.5%) routinely exceeds gas
cost, so the window is exploitable on any vault whose `maxStaleness`/deviation band admits
meaningful drift — and is *always* exploitable when `exitFeeMaxBps = 0` or after the decay period.

**Minimal fix.** Gate minting freshness on the oracle, not only the wall clock: reject deposits
(or apply an entry swing) when the median's `updatedAt` age exceeds a tight mint-time bound, so a
depositor cannot mint against a valuation known to be stale. Tightening `maxStaleness` (see
Finding 6 floor) and keeping a non-zero exit fee narrow but do not close the window.

---

## Finding 8 — Unbounded NAV gas scaling (L)

**File:** `VaultCore.sol:227-258` (`navWad`/`_childValueWad`); constructor imposes no basket-length
or source-count cap; `MAX_CHILDREN = 8`; `OracleAggregator` allows ≤15 sources/asset.
**Confidence:** high on cost model; low as a standalone DoS.

`navWad` is O(children × basketAssets × sources): each child triggers `_childValueWad` (4 child
staticcalls + per-asset `assetBalance` + `oracle.priceWad`, which itself loops ≤15 source
staticcalls with a sort), plus the parent's own basket loop. `navWad` runs **twice** per
`deposit` (capacity check + `_mintShares`) and `_childValueWad` runs twice per child in
`_settleExit` (the `childValTotalWad` loop at `444-446` and the shortfall loop at `478`). At an
extreme but permitted config (8 children × 10 basket assets × 15 sources) this is on the order of
a few million gas per `navWad` — under the block limit today, so not a hard brick by itself, but a
real cost/DoS surface that grows with configuration and cold-access stacking.

**Interaction with Finding 1's fix.** Making `_childValueWad` recursive (the correct fix for #1)
multiplies this cost per depth level. The fix must therefore be **depth-bounded** by the registry
depth (≤3), and the constructor should cap `basketAssets.length` so the product stays bounded.

**Minimal fix.** Add a constructor cap on `basketAssets.length`; keep the #1 recursion
depth-limited; consider caching `oracle.priceWad` results within a single `navWad` pass when the
same asset appears across parent and child baskets.

---

## Priority-target answers (brief mapping)

1. **SF-2 / staleness-induction cost & median parity** — Finding 6. Freeze cost = disabling
   `(m−quorum+1)` sources, which the constructor lets a creator drive to **one** (`quorum=m`, or a
   1-source set). Even-`k` average is manipulable at small `k`; a single high/low outlier moves
   the median by ~half its deviation once `k` is induced down to 2, and an unbounded outlier
   panic-freezes the asset (Findings 2 and 6).
2. **SV-7 look-through** — Finding 1: the child's own child positions are omitted, so depth-3
   NAV is mispriced. Child `idle`/`assetBalance`/`totalShares` dust manipulation is **not**
   exploitable (fair mint preserves the ratio — see Verified sound). Cross-oracle immunity holds
   (parent always prices via its own oracle). Reentrancy from child→parent is blocked by per-vault
   locks (Verified sound).
3. **EE-5 latency arbitrage** — Finding 7: threshold is gas, not exit fee; exploitable via repeat
   deposits against stale `navWad`.
4. **Execution misattribution** — `executeRebalance` output measurement is sound against
   fake-token / router-return attacks (measured on the vault's own balance of the fixed, basket-
   constrained `tokenOut`); the selector allowlist and approval hygiene hold (Verified sound). The
   one real accounting defect is the leftover-sweep absorbing escrow/donations (Finding 3).
5. **Sub-vault accounting / SV-5 unwind** — Findings 4 (Mode-F revert) and 5 (escrow strands
   value). CEI across the depth chain is sound (Verified sound); the `childValTotalWad` vs
   per-child unwind math conserves value and preserves §4.6 for remainers *except* under Finding 1
   (grandchild) and Finding 5 (escrow) — both shift value away from the exiter toward remainers,
   never the reverse, so the invariant's direction is not violated, but the exiter is shortchanged.

---

## Verified sound (examined, no vector found)

- **Sprint-1 H-1 fix present.** `feeEngine`/`operatorRegistry`/`governance` are all reached via
  `BoundedCall` (`VaultCore.sol:394-398, 505-518, 531-533, 699-704`) with `MODULE_CALL_GAS=300k`
  and non-blocking fallbacks (fee → 0, registry → event, governance → Mode-I). `BoundedCall`
  copies ≤1 word, defusing returndata bombs. Exit liveness no longer depends on module behaviour.
- **Sprint-1 H-2 fix present.** `SafeTransferLib.tryTransfer` (`:34-57`) is assembly, gas-capped,
  and returndata-bounded: 0-length → success, 1–31 bytes → failure, ≥32 → decode, bomb → only
  `0x20` copied. A malformed/bomb basket token now degrades to EE-6 escrow, never reverts
  settlement.
- **Sprint-1 M-1 fix present.** Creator gate checked at *queue* time (`requestExit`, `:379`) and
  deliberately not re-checked for queued settlements (`_settleExit`, `:430`, `fromQueue`).
- **Sprint-1 M-2 fix present.** Perf fee withheld uniformly across cash + in-kind via `feeFracWad`
  (`:524-560`); an in-kind-heavy exit no longer dodges the fee.
- **Execution fake-token / EX-3 defense.** `executeRebalance` (`:659-693`) constrains `tokenOut`
  to `usdc`/basket, measures `received` on the vault's own `balanceOf` of that fixed token, and
  requires `received ≥ minAmountOut` — the router's return value is never the accounting source. A
  fake token cannot satisfy the delta on the real `tokenOut` address.
- **Adapter selector allowlist & approval hygiene.** `AggregationRouterAdapter` pins `router`
  immutable, requires the routeData selector on the construction allowlist (`:52-54`), mandates
  `minAmountOut > 0` and `tokenIn != tokenOut` (`:50-51`), enforces minOut on measured deltas
  (`:65`), and revokes approval to 0 after the swap (`:67`). No cross-transaction approval residual
  remains. `executeRebalance` mirrors this with its own approve/execute/approve-0 per leg.
- **SV-7 dust manipulation.** Depositing dust into a child cannot mislead `_childValueWad`: the
  child's fair mint (`minted = amount·ts/childNav`, rounded down, `minted>0` required) preserves
  `childNav/ts`, so the parent's `childNav·myShares/ts` is unchanged. The parent prices through
  its own oracle regardless of the child's oracle choice.
- **Reentrancy / CEI across the depth chain.** Every state-mutating external entrypoint is
  `nonReentrant` with a per-contract lock; each vault in a parent→child→grandchild chain locks
  itself during its own `_settleExit`, so a malicious basket token's transfer hook cannot re-enter
  any vault in the chain. Within `_settleExit`, shares/accounting are finalised before external
  transfers; escrow-on-failure keeps `assetBalance`/`claimable` consistent with physical tokens.
- **Recursion / cycle prevention (SV-3).** Edges are creation-time only (`registerChild` requires
  `parentOf[child]==0`); `allocateToChild` only follows `parentOf(child)==this`; cycles are
  structurally impossible. Depth cap enforced at registration.
- **`_redeemChildMeasured` credit path (governance).** With `credit=true`, measured deltas are
  credited to `idleUsdc`/`assetBalance`; a child escrow leaves `delta=0` recoverable via
  `pullChildEscrow` — acceptable on the governance path (unlike the member-exit path, Finding 5).
