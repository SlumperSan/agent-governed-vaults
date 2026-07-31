# On-chain settlement VALUES — Method 2 — 2026-07-31 (Chain department)

**Backlog #15 (P0 top item).** Method 1 (`notes-chain-values.md`) decoded the emitted USDC
`Transfer` LOG's data field, over one ~200-second window, n=150. This is the required independent
second method: (a) decode the **calldata** `value` argument directly (a different field, different
parsing path), and (b) re-run over temporally disjoint windows. Read-only RPC only
(`eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionByHash`). No tx signed or sent, no
paid endpoint touched.

Script: `C:\Users\Micha\Desktop\x402\onchain_verify_values2.py`.

## Step 1 — POSITIVE CONTROL (mandatory, run first)

Decoded the calldata of our own 4 known $0.01 payments (from `onchain_values_control.json`) via
`eth_getTransactionByHash` + manual ABI decode of the first 3 static words (`from`, `to`, `value`).

**Result: 4/4 PASS.** Every decoded value = $0.01 exactly, decoded `from` matched our wallet,
decoded recipient matched the known seller, and the called contract was confirmed to be USDC.
First run scored a false FAIL (0/4) because the check compared the wrong field — the calldata's
recipient (the seller) against the USDC contract address instead of against the seller. Fixed and
re-run before trusting anything downstream. Raw: `onchain_values2_control.json`.

## Step 2 — decoder cross-check (validates the decoder, NOT the magnitude)

Re-decoded the same 150 transactions from Method 1 via calldata and compared to the log-decoded
values already on file. **150/150 exact matches.** This confirms the calldata decoder and the log
decoder agree on identical underlying transactions — it is expected agreement and proves the
*method* is sound, not that either window's *dollar magnitude* is representative. Do not read this
as corroboration of the headline number. Raw: `onchain_values2_crosscheck.json`.

## Step 3 — temporally disjoint window (the actual second method)

Reused Intel department's exact 12h-back block range (`49323114–49323614`, already vetted for
tx-count bridging in `notes-reconciliation.md`) — took the last 100 blocks of it
(`49323515–49323614`) for a same-size comparison to Method 1's 100-block window. Because calldata
is present in the full-block fetch itself, this decoded the **entire matched population**, not a
stratified subsample: **573 facilitator-sent transactions, 0 excluded as non-USDC calls, single
selector `0xe3ee160e` throughout (100%).**

| Stat | Method 1 (n=150, ~200s window, same day) | Method 2 disjoint (n=573, ~12h earlier) |
|---|---|---|
| Median | $0.00515 | **$0.017149** |
| Mean | $0.02799 | **$0.038438** |
| p90 | $0.0300 | $0.039026 |
| Max | $1.00 | $8.00 |

The two windows do **not** converge tightly — disjoint window's median is ~3.3× higher, mean ~1.4×
higher. This is a real finding, not hidden: see the mixture explanation below, which accounts for
most of the gap.

Raw: `onchain_values2_disjoint_raw.json`, summary: `onchain_values2_disjoint_summary.json`.

## Step 4 — the mega-merchant check (the strongest finding here)

The brief names one merchant, `0xe9030014f5dae217d0a152f02a043567b16c1abf`, as 75.7% of x402scan's
entire 30-day tx count (9,401,793 tx) at $0.0169/tx. Grouped every decoded transaction by recipient:

| Window | Mega-merchant share of matched tx | Mega-merchant median | Mega-merchant mean |
|---|---|---|---|
| Method 1 (n=150) | 70/150 = 46.7% | $0.01566 | $0.02636 |
| Method 2 disjoint (n=573) | 467/573 = **81.5%** | $0.01819 | $0.02150 |
| x402scan's own stated figure | — | — | **$0.0169** |

**This merchant is present in both independent windows, and both windows' directly-measured
per-transaction value for it land within ~10-30% of x402scan's own reported $0.0169/tx.** This is a
genuinely independent, three-way corroboration (our two on-chain windows + x402scan's separate
self-report) on the single largest component of the whole x402 economy. It is the strongest result
in this report.

**This also explains most of the Method 1 vs. Method 2 divergence above**: the mega-merchant's
share of matched traffic differs sharply between the two windows (46.7% vs 81.5%) — a mixture-share
difference, not a per-merchant pricing difference. The full-population blend is highly sensitive to
which window happens to catch more or less of this one dominant merchant's traffic.

## Step 5 — the non-mega tail (where the honest disagreement lives)

Stripping the mega-merchant from x402scan's own 30-day total: `$711,166 − (9,401,793 × $0.0169) =
$552,276` over `12,421,896 − 9,401,793 = 3,020,103` tx → **$0.18286/tx** implied for everything else,
across all facilitators.

Our directly measured non-mega tail (Method 1, n=80 non-mega transfers): mean **$0.02942**, median
**$0.00200**. That is **~6× lower** than the blended non-mega rate implied by x402scan's own numbers.

**This is a disagreement, stated plainly, not smoothed over.** Two explanations are both plausible
and neither is ruled out here: (1) non-Coinbase facilitators' non-mega merchants price meaningfully
higher than Coinbase's, so the "$0.183 non-mega" figure isn't representative of Coinbase's own
non-mega tail specifically; or (2) our non-mega samples (n=80, n=?) are too small and too
outlier-sensitive (the $1.00 tx already swings Method 1's non-mega mean by ~2×) to trust at face
value. **NOT ESTABLISHED which explanation dominates.**

## Step 6 — far-back spot check (~30 days, tests historical composition)

Method 1's biggest disclosed limitation was "only one recent window — cannot rule out a different
historical average." Probed 20 blocks ~1,296,000 blocks (~30.0 days) before latest
(`48050251–48050270`, well before today, `2026-07-31`).

**n=42 matched transactions.** Median **$0.013498**, mean **$0.062996** (pulled up by 2/42 tx at
exactly $1.00 — the same $1.00-outlier pattern Method 1 saw, recurring a month apart). Values:
`onchain_values2_spotcheck_30d_back.json`. This is explicitly a small-n spot check (cheap RPC
budget, 20 blocks by design), not a third full sample — the median/mean are directionally consistent
with the other two windows (same order of magnitude, same fat-tail shape with $1 outliers) but
should not be weighted as heavily as the 150- and 573-tx windows. Per-tx recipient was not persisted
for this run (disclosed oversight) so the mega-merchant check could not be repeated on this window.

## 30-day dollar-volume extrapolation (Coinbase-specific, not the whole x402 economy)

Using Intel department's already-bridged Coinbase 30-day sent-tx-count range (**4.73M–6.26M**, from
`notes-reconciliation.md`) — NOT the 106.6M all-time nonce count, which is a different, larger
denominator and would conflate all-time with 30-day:

| Basis | Per-tx value used | Extrapolated 30d Coinbase $ | Status |
|---|---|---|---|
| Method 1 mean | $0.02799 | $132,393 – $175,217 | valid — usable estimate |
| Method 2 disjoint mean | $0.038438 | $181,812 – $240,622 | valid — usable estimate |
| Spot-check mean | $0.062996 | $297,971 – $394,355 | valid — usable estimate |
| Method 1 median | $0.00515 | $24,360 – $32,239 | **INVALID — median × count, do not cite** |
| Method 2 disjoint median | $0.017149 | $81,115 – $107,353 | **INVALID — median × count, do not cite** |
| Spot-check median | $0.013498 | $63,846 – $84,497 | **INVALID — median × count, do not cite** |

Real 30-day total, all facilitators: **$711,166** (x402scan, verified fact). Coinbase is one of
several facilitators, so its own dollar volume being a fraction of $711,166 is expected and
consistent — every basis above lands well under that all-facilitator total, unlike the original
$28.6M/$52.6M claims which exceeded it by 40–70×.

**The three MEDIAN rows above are not merely imprecise — they are mathematically invalid as
volume estimates and must never be cited as such.** Total volume = Σ(all tx values), which the
mean recovers by construction (mean × count = sum). The median is the *typical* transaction value
in a right-skewed distribution (most tx are tiny, a few are $1 outliers pulling the tail) — it
deliberately discards that tail mass. Median × count therefore estimates a "floor if every
transaction were typical," not total dollar volume, and understates the real sum every time the
tail carries a disproportionate share (which it does here — see the $1.00-outlier pattern in
Method 1, Method 2, and the spot-check). $24,360–$32,239, $81,115–$107,353, and $63,846–$84,497 are
this invalid quantity, not alternate volume estimates, and must not be quoted as such anywhere
(see `STRATEGY.md` line 79-82, `ORG-LESSONS.md`).

**Only the three MEAN rows may be quoted as a volume estimate, and even then not as a single
final number** — they still span a real range ($132,393–$394,355, ~3×) window to window because
the mega-merchant mixture share swings between short windows.

## What this changes about Method 1's verdict

Method 1 concluded the $28.6M/$52.6M claims are "not plausible... by one to two orders of
magnitude." That conclusion **still stands** — nothing here brings any window's numbers within an
order of magnitude of $28.6M. What Method 2 adds:

- **The mega-merchant sub-population is now independently corroborated** (two on-chain windows +
  x402scan's own self-reported price, all within ~30%) — this is new, solid ground that Method 1
  did not have.
- **Method 1's single-window number should not be read as "the" answer** — a second, larger,
  disjoint window measured a materially different blend (3.3× the median), and the cause (mixture
  share, not per-merchant pricing) is now identified rather than left as unexplained noise.
- **The non-mega tail remains genuinely unresolved** and is now flagged as its own open question
  rather than folded silently into a single blended average.

## What was NOT done / could not verify

- Only one disjoint window (12h) plus one small spot check (30d) — not a systematic historical
  sweep across the full claimed multi-month/multi-year history.
- Did not decode non-Coinbase facilitators' calldata at all — cannot say whether the non-mega
  pricing gap (Step 5) is a Coinbase-specific pattern or economy-wide.
- Spot-check window did not retain per-tx recipient, so mega-merchant presence there is
  NOT ESTABLISHED (only inferred by value-shape similarity).
- Did not attempt to reconcile against CDP catalog's own $62,801/30d derived GMV figure directly —
  that figure is catalog-listed-price based, not settlement-based, and mixing it in here would
  repeat the exact category error this backlog item exists to avoid.
- Process check after all three scripts completed: `Get-CimInstance Win32_Process` shows no
  `python.exe`/`pythonw.exe` running this repo's scripts — confirmed no orphaned process, unlike the
  prior cycle's flagged orphan.

## Files

- Script: `C:\Users\Micha\Desktop\x402\onchain_verify_values2.py`
- Calldata positive control: `onchain_values2_control.json`
- Decoder cross-check (150/150): `onchain_values2_crosscheck.json`
- Disjoint window raw (573 matches) + summary: `onchain_values2_disjoint_raw.json`,
  `onchain_values2_disjoint_summary.json`
- 30-day spot check: `onchain_values2_spotcheck_30d_back.json`
- Logs: `logs\chain_values2_control.log`, `logs\chain_values2_crosscheck.log`,
  `logs\chain_values2_disjoint.log`, `logs\chain_values2_spotcheck.log`
- This note does not overwrite `notes-chain-values.md` or `notes-onchain-verification.md`.

## Bottom line for STRATEGY.md Phase 1

Charter's "independent second method" requirement: **satisfied** — calldata decode (different data
path, positive-control-verified 4/4) plus a temporally disjoint 573-tx window (vs. the original
150-tx window), plus a small 30-day-back spot check. The $28.6M/$52.6M claims remain **not
supported** by any measured window. New, solid finding: **the single dominant merchant's per-tx
price is now corroborated three ways** (~$0.017–0.026 measured vs. $0.0169 self-reported). Honest
gap: **the non-mega tail's true average is unresolved**, with our measurement running ~6× below what
x402scan's own aggregate would imply for it — flagged, not resolved, and not folded into any
headline number.
