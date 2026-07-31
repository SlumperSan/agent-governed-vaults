# Mega-merchant DOLLAR share — independent on-chain verification

**Author:** Chain dept, Sprint 6. **Date:** 2026-07-31. Reuses the calldata decoder built and
positive-controlled in `onchain_verify_values2.py` (imported, not reimplemented). Read-only RPC only
(`base-rpc.publicnode.com`, fallback `base.llamarpc.com`). No tx signed/sent, no paid endpoint
touched. Script: `C:/Users/Micha/Desktop/x402/onchain_merchant_dollar_share.py`.

**Target claim:** `notes-merchant-concentration.md` states the mega-merchant
(`0xe9030014f5dae217d0a152f02a043567b16c1abf`, BlockRun.AI) is **22.3%** of the ecosystem's 30-day
dollar volume — explicitly flagged there as vendor-derived (x402scan's own $0.0169/tx), never
independently confirmed. This task computes the dollar share directly from decoded calldata.

## Window and disjointness

- **Blocks 49,348,974 – 49,349,273** (300 blocks, 2026-07-31 08:41:35Z – 08:51:33Z, ~10 min of chain
  time).
- Checked in code against all three prior windows before scanning; script aborts on overlap
  (none occurred):
  - Method 1 (`notes-chain-values.md`): 49,344,877–49,344,976
  - Method 2 disjoint (`notes-chain-values-method2.md` step 3): 49,323,515–49,323,614
  - Method 2 30d spot-check (step 6): 48,050,251–48,050,270
- This window is **entirely later** than all three (starts ~4,000 blocks / ~2.3h after Method 1's
  end) — no shared blocks, confirmed programmatically, not just by inspection.

## Positive control (re-run, not assumed)

```
=== METHOD 2 POSITIVE CONTROL: decode calldata of our own known $0.01 payments ===
  0x54c985eeba... expected=$0.01 decoded=$0.01 selector=0xe3ee160e contract_is_usdc=True match=True
  0x342cf6e911... expected=$0.01 decoded=$0.01 selector=0xe3ee160e contract_is_usdc=True match=True
  0x3d7c3ee3d0... expected=$0.01 decoded=$0.01 selector=0xe3ee160e contract_is_usdc=True match=True
  0xfcbdba929b... expected=$0.01 decoded=$0.01 selector=0xe3ee160e contract_is_usdc=True match=True
CALLDATA POSITIVE CONTROL: PASS (4/4)
```

## Scan result

- Blocks scanned: 300/300. Total tx seen in window: 45,079. Facilitator-submitted matches
  (Coinbase's 40 Base addresses, `tx.from`): **1,400**. All 1,400 decoded as USDC calls (0 excluded
  as non-USDC), single-selector `0xe3ee160e` throughout — same shape as Method 2's 573-tx window.
- Per-tx recipient (`payee_to`) persisted for every one of the 1,400 matches — the gap explicitly
  named in `notes-chain-values-method2.md` ("per-tx recipient was not persisted for this run") is
  fixed for this window. Raw file: `onchain_merchant_dollar_share_raw.json`.

## Per-payee breakdown (top 10 by dollar value)

| Rank | Payee | n tx | $ value | Share |
|---|---|---:|---:|---:|
| 1 | `0xe9030014f5dae217d0a152f02a043567b16c1abf` (mega-merchant) | 994 | $175.7993 | **74.37%** |
| 2 | `0x68396bd35874695ad86cd29410bd80a550991a2b` | 50 | $51.1110 | 21.62% |
| 3 | `0x47d3394c7234714e4b9e9b74827c12be847f9dda` | 4 | $7.5000 | 3.17% |
| 4 | `0xa9dd7cc9cbf0e05551332209289f04be36bc2315` | 269 | $0.5380 | 0.23% |
| 5 | `0x478bcdea94b9cb5ea14c33e6f0d7e920743d39f2` | 1 | $0.5000 | 0.21% |
| 6 | `0x3ccc6565511f404716cad2d578851ff3ff95fd85` | 14 | $0.2102 | 0.09% |
| 7 | `0x7d2ceb7a0e0c39a3d0f7b5b491659fde4bb7bcfe` | 4 | $0.2000 | 0.08% |
| 8 | `0x9dba414637c611a16bea6f0796bfcbcbdc410df8` | 30 | $0.1800 | 0.08% |
| 9 | `0x158e90dd58fbe897ed8c244f472febee37283d00` | 13 | $0.1380 | 0.06% |
| 10 | `0x40a8cdd6a10ec1a8cb3dfb2834675e7a2cf4ad8b` | 7 | $0.0520 | 0.02% |

- **Total decoded value in window: $236.3795** across 21 distinct payees, 1,400 tx.
- **Mega-merchant dollar share (measured): 74.37%** ($175.80 / $236.38). Count share this window:
  994/1400 = 71.0%.
- **Top-2 concentration: 95.99%. Top-5 concentration: 99.61%** (per ORG-LESSONS.md's standing
  concentration-check rule — this report does not repeat the "aggregate without concentration"
  mistake).
- Second-largest payee (`0x6839...91a2b`) alone is 21.6% — worth naming since it is close in size to
  the vendor's *entire ecosystem-wide* mega-merchant estimate.

## Why 74.4% diverges sharply from the vendor's 22.3%, and why that's not a refutation

Broke down the mega-merchant's own 994 tx by value:
- **Median per-tx: $0.0193** — within 14% of x402scan's stated $0.0169/tx. Consistent with the
  three-way corroboration already established in `notes-chain-values-method2.md` step 4.
- **Mean per-tx: $0.1769** — ~10.5× the median, because **33 of 994 tx (3.3%) are priced $1.02–$4.30
  and together total $86.20 — 49% of the mega-merchant's entire dollar value in this window** from
  just 3.3% of its transaction count.
- **All 33 of those large transactions share one payer**: `0x2b4ee3387008e5ff1a9996fc8b48d2fd61389037`
  — the exact "single dominant counterparty" buyer EOA already identified in
  `notes-merchant-concentration.md` §1. Only 3 unique payers appear across all 994 mega-merchant tx
  in this window; one of the three drove the entire tail.
- This matches the burst pattern `notes-merchant-concentration.md` §2 already documented (rates
  swinging up to 16–19× between 500-block windows, per-tx value ranging $0.002–$1.48 there; this
  window extends that range to $4.30). A single ~10-minute window falling inside or outside one of
  these buyer-driven bursts can swing the dollar total by roughly 2×, independent of anything about
  the vendor's average being wrong.

## Scope check (flagged by review, tested empirically): does the 74.4% denominator even match the vendor's 22.3%?

The vendor's 22.3% denominator is **all-facilitator, all-chain** dollars ($711,166). The first-pass
74.37% denominator above was **Coinbase-Base-facilitator dollars only** (40 addresses) — a narrower
scope, and comparing the two directly risked repeating the exact "scope mismatch" failure mode
already named as an open hypothesis in `notes-merchant-concentration.md` §5. Tested this rather than
assuming it explained the gap: re-scanned the **identical block range** (49,348,974–49,349,273,
already chain-final) with the **union of all 20 facilitators' Base addresses** (118 unique, vs. 40)
from `facilitator_addresses.json`. Script: `onchain_merchant_dollar_share_ecosystem.py`.

```
Union of ALL facilitators' Base addresses: 118 unique
SCAN DONE (union, same window as prior run): blocks_scanned=300/300 total_tx_seen=45079 matches=1412
total decoded value (all-Base-facilitator, this window): $237.709499
MEGA-MERCHANT: n_tx=994 value=$175.799308 share=0.739555250166927
by facilitator (dollar value this window):
  coinbase: n=1400 $236.379499 share=0.9944049354123655
  anyspend: n=1 $1.000000 share=0.0042
  fluxa: n=2 $0.230000 share=0.0010
  polymer: n=1 $0.100000 share=0.0004
```

**Result: the denominator barely moves (74.37% → 73.96%, <0.5pp) because Coinbase was 99.4% of
all-Base-facilitator dollar volume in this specific window** — the non-Coinbase-Base facilitators
matched almost nothing here. So the Base-vs-Coinbase-only scope gap is empirically shown to be a
small effect for *this window*, not the primary driver of the divergence from 22.3%.

**A real scope gap does remain, though, and is not closed by this check: Solana-settled facilitator
flow.** Both scans here are Base-chain only. `facilitator_addresses.json` lists Solana addresses for
several facilitators (`coinbase`, `payAI`, `dexter`, etc.) that were not queried — this project has
no free-RPC Solana decode pipeline built. If a material share of the vendor's $711,166 settles on
Solana, that portion is invisible to both scans and the true all-chain mega-merchant share could
differ from anything measured here in either direction. **Named, not resolved.**

## Bracket check: does 74.4% (this window) reconcile with 22.3% once you account for Coinbase's own share of the ecosystem?

Using `notes-chain-values-method2.md`'s own Coinbase 30-day dollar-volume range ($132,393–$394,355,
mean-based bases — the only valid rows per that note's median×count caveat) and this window's
mega-merchant share of Coinbase's Base dollars (74.37% — effectively all of mega-merchant's traffic
in this window was Coinbase-submitted, confirmed above: n_tx unchanged at 994 whether scoped to
Coinbase-only or all-Base-facilitators):

```
implied mega-merchant 30d $: $98,463 – $293,288
implied share of ecosystem $711,166: 13.8% – 41.2%
```

**This range straddles the vendor's 22.3%** — so once Coinbase's own share of the all-chain
ecosystem is factored in, this window's high raw share is *consistent with* 22.3%, not a clean
refutation of it. But the bracket itself is ~3× wide (inherited directly from Method 2's own
disclosed ~3× spread across its bases, itself driven by burst-window mixture swings) — too wide to
call this a confirmation. **"Consistent with, does not confirm" is the honest read.**

## Verdict: does this settle the 22.3% figure?

**No — a real gap remains, not rounded up.** This window's raw, scope-matched mega-merchant dollar
share of Base-chain facilitator activity (~74%) is well above 22.3% taken at face value, but the
bracket check above shows that gap is largely explained by Coinbase itself being a fraction (not all)
of the all-chain ecosystem total, plus window-to-window burst variance — not by a residual
denominator error. What follows from everything measured here:

- The mega-merchant's own **median** per-tx price ($0.0193) *is* close to the vendor's $0.0169 —
  agreeing with the already-corroborated per-tx price finding.
- The **divergence in the aggregate dollar share is attributable to tail/burst dynamics** (one buyer,
  33 tx, 49% of the merchant's window-dollars) that this project has already independently documented
  as a real, recurring feature of this merchant's traffic — not to a decoder error, a wrong recipient
  match, or a control failure (control re-ran clean, 4/4).
- A single ~10-minute window cannot distinguish "the vendor's 22.3% is right and this window caught an
  atypical burst" from "the vendor's 22.3% underestimates this merchant's true 30-day dollar share."
  Both are consistent with everything measured here and in prior notes. Resolving it would require
  either (a) many more disjoint windows summed by mean (not median) the way
  `notes-chain-values-method2.md` did for the ecosystem-wide extrapolation, or (b) the full 30-day
  window, neither of which was in this task's budget.

**This does NOT count as a second independent method that confirms 22.3%.** It is a genuine,
honestly-reported on-chain data point: the raw window share (~74% of Base-chain facilitator dollars)
is *not* a contradiction of 22.3% once Coinbase's own share of the all-chain ecosystem is factored
in (13.8%–41.2% bracket straddles it), but that bracket is wide enough (~3×) and inherited from
already-caveated upstream ranges that it cannot be called confirmatory either. The dollar-share
question stays open — flagged, not resolved, and specifically **not rounded up to "confirmed."**

## What was not done

- Only one fresh window (300 blocks / ~10 min) for the direct measurement — not a multi-window sweep
  summed by mean the way the transaction-count corroboration used 10 windows. Budget/time did not
  allow it this cycle.
- **Solana-settled facilitator flow was not measured at all** — both scans here are Base-chain only,
  and the vendor's $711,166 / 22.3% figures are stated as all-chain. This is a real, unclosed scope
  gap, not just the Base-facilitator-union gap that was tested and found small.
- Did not attempt to determine whether the single dominant buyer's $1–$4.30 burst here is itself
  representative of its own long-run behavior, or a one-off spike.
- Did not reconcile this window's $236.38/300-block rate against a full 30-day extrapolation directly
  — used Method 2's own already-computed Coinbase 30-day range instead (bracket check above) rather
  than repeating that extrapolation exercise.

## Files

- Scripts: `C:/Users/Micha/Desktop/x402/onchain_merchant_dollar_share.py` (Coinbase-only scan),
  `C:/Users/Micha/Desktop/x402/onchain_merchant_dollar_share_ecosystem.py` (same-window, all-20-facilitator
  union re-scan, run to test the scope-mismatch concern raised in review)
- Raw (Coinbase-only, 1,400 matches, per-tx payee persisted): `onchain_merchant_dollar_share_raw.json`
- Summary (Coinbase-only): `onchain_merchant_dollar_share_summary.json`
- Raw (all-facilitator-Base union, 1,412 matches): `onchain_merchant_dollar_share_ecosystem_raw.json`
- Summary (all-facilitator-Base union, by-facilitator breakdown): `onchain_merchant_dollar_share_ecosystem_summary.json`
- Run logs: `logs/merchant_dollar_share_run.log`, `logs/merchant_dollar_share_ecosystem_run.log`
