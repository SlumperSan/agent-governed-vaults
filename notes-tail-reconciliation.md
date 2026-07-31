# Non-mega-merchant tail reconciliation (Sprint 7, Chain dept)

Task: close/bound the ~6x gap flagged in STRATEGY.md §0.2 ("the non-mega-merchant tail measured
roughly 6x below what x402scan's own aggregate implies for it"), using MEAN basis only (see
ORG-LESSONS.md "Comparing a median to a stated average").

## Method

1. Reused `onchain_verify_values2.py`'s calldata decoder verbatim (imported, not reimplemented).
   Ran its 4/4 positive control first — PASS.
2. Confirmed disjoint block window against all four prior windows this org has used (checked their
   exact recorded `start_block`/`end_block`):
   `onchain_verify_values.py` 49344877-49344976 · `onchain_verify_values2.py` disjoint_window
   49323515-49323614 · spotcheck_30d_back 48050232-48050251 ·
   `onchain_merchant_dollar_share(+ecosystem)` 49348974-49349273.
   New window: **49339501-49340000** (500 blocks, Coinbase facilitator addresses) — disjoint OK
   against all four.
3. Scanned full population (97,932 tx seen, 1,570 facilitator matches, 1,086 mega-merchant,
   **484 non-mega tail** — full population of the window's tail, not a subsample). Mean tail rate:
   **$0.148026/tx** (median $0.002, min $0.001, max $15.00).

## The original 6x claim's actual basis (checked, not assumed)

`notes-chain-values-method2.md` step 5 derived the original figure as: implied non-mega rate =
`($711,166 − mega_tx × $0.0169) / non-mega_tx` — i.e. it subtracts the mega-merchant's dollars
using **x402scan's own stated $0.0169/tx price**, not an independently-measured on-chain dollar
share. That implicitly puts the mega-merchant's dollar share at **22.3%** of the ecosystem total
(`notes-merchant-concentration.md`'s figure). It compared that implied $0.18286/tx against Method
1's directly-measured non-mega **mean** $0.02942/tx (n=80) → the ~6x gap. **So the original claim
was already mean-basis** — the task brief's assumption that it might have been unpinned was worth
checking; it wasn't the mistake here.

## Two implied-tail bases, computed side by side (this is the actual finding)

Held tx-share fixed at 75.7% both times (`tail_tx_implied = 12,421,896 × 0.243 = 3,018,521`).
Dollar-share for the mega-merchant is where the two bases diverge:

| Basis | Mega $-share used | Implied tail $ | Implied tail rate | Ratio implied/measured |
|---|---|---|---|---|
| **A — same method as original 6x claim** (vendor $0.0169/tx × implied mega tx count) | 22.3% (implied) | $552,249 | **$0.18295/tx** | **1.24x** |
| **B — task-specified proxy** (74.37% doubly-confirmed Coinbase-window on-chain share) | 74.37% | $182,272 | **$0.06038/tx** | **0.41x** |

- **Basis A: the ~6x gap is NOT reproduced this window — ratio ≈1.24x, effectively closed within
  one window's noise.** This is the apples-to-apples test against the original claim's own method.
- **Basis B (what the task brief asked for): ratio flips to 0.41x — measured is ~2.4x ABOVE
  implied**, the opposite direction.

**Why they disagree:** the 22.3% (vendor-derived) and 74.37% (sprint-6 on-chain, single window)
mega-merchant dollar-share estimates disagree with each other by >3x — a tension STRATEGY.md
already flagged ("bracketed against Method 2's range → implied ecosystem share 13.8%–41.2%,
straddling but not confirming the vendor's 22.3%"). **This task did not resolve that tension. It
showed that the tail gap's size and even its direction is entirely an artifact of which mega-share
estimate you plug in** — the tail number inherits all the uncertainty already sitting in the mega
merchant's dollar share, it doesn't add new uncertainty of its own.

**A third data point, from this window itself:** mega-merchant dollar share in this fresh window
is **57.1%** (n=1,086, mean $0.08773) — a third distinct reading, between the 22.3% and 74.37%
extremes. This confirms the mega-merchant's dollar share is genuinely window-dependent (consistent
with the "bursty, 16-19x spikes" behavior already documented in `notes-merchant-concentration.md`),
not a stable constant any single window can pin down.

## Fragility of the measured tail mean itself

The 484-tx tail sample is extremely right-skewed: the top 5 transactions ($15, $10.791 ×2, $5 ×3)
are **65% of the tail's total dollar value**. A single $15 tx from one address
(`0x47d3394c7234714e4b9e9b74827c12be847f9dda`) moves the mean by ~$0.031/tx alone. With n=484, one
or two outlier merchants inside the "tail" can swing the mean-basis estimate by a large factor —
this mirrors the fat-tailed shape already documented for the mega-merchant's own volume. The
$0.148026/tx figure should be read as **this window's measurement, not a settled tail rate**.

## Honest conclusion

- **Gap status: still open, more precisely bounded, direction-sensitive to which mega-dollar-share
  proxy is used.** Basis A (matching the original claim's own method) says the gap is not
  reproduced (~1.24x, near closed). Basis B (the task's specified proxy) says it reverses (~0.41x,
  measured 2.4x above implied). Neither should be quoted alone as "the" answer.
- **Not resolved by this task, correctly left open:** the true mega-merchant ecosystem-wide dollar
  share (22.3% vendor vs 74.37% on-chain-single-window vs 57.1% this-window) — three readings, no
  convergence. This is the actual bottleneck; the tail figure cannot be pinned down until this is.
- **Not done:** did not isolate/exclude a possible second "mini-mega" merchant inside the tail
  (`0x93862e5b2b1fa10a01772e7e9ca7cdc7deb5ca25` contributed 2 of the top-8 tail values) — a
  reasonable next step if this is picked up again, out of scope here.
- **Do not quote** $0.148026/tx, $446,819, or either ratio as settled figures — report them as this
  window's measurement and the two-basis bracket only.

## Files

- `onchain_tail_reconcile.py` — script (imports `onchain_verify_values2` for decoder + control)
- `onchain_tail_reconcile_raw.json` — all 1,570 raw matches (this window)
- `onchain_tail_reconcile_summary.json` — both bases + in-window mega check
- `onchain_tail_reconcile.log` — full run log (control PASS, disjoint check, scan progress)
- `tail_recompute_bases.txt` — the basis-A/basis-B recompute + in-window mega check, raw output
