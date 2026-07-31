# DRAFT — Not for publication. Michael's call before any word of this goes public.

# How much of the x402 economy does the CDP catalog actually show?

**Status: draft, Sprint 8, Intel department. Built strictly from the verified baseline in
`ORG-CHARTER.md`/`STRATEGY.md` §0.2. No new measurement was run for this document — it is a narrative
assembly of already-verified numbers, cross-checked against source before writing.**

---

## Why this isn't called "9x smaller"

Backlog #8 named this analysis "the x402 economy is 9× smaller than reported." That framing traces
back to a since-refuted comparison (~$62.8k catalog-derived GMV vs. the discarded $52.6M/$28.6M
on-chain dollar claims). Both ends of that original ratio are gone: the $52.6M/$28.6M figures were
refuted by two independent on-chain methods (§0.2, `STRATEGY.md`), and the current CDP sweep figure
($62,801) is compared here against a different, better-sourced baseline. Reusing "9×" would be
carrying a dead number's conclusion into a new argument it was never derived from. This draft
re-derives the ratio from scratch on the current baseline instead.

---

## The verified baseline (30 days, all figures already established — not re-derived here)

| Metric | Real x402 economy (all facilitators, x402scan) | CDP catalog sweep (our measurement) |
|---|---|---|
| Transactions | 12,421,896 | 373,056 |
| Dollar volume | $711,166 | $62,801 (derived GMV) |

Coverage: **CDP's catalog captures 3.0% of real transactions and 8.8% of real dollar volume.**

This is a matched-window, matched-timeframe comparison — both sides cover the same 30-day period —
and it converges with an independent on-chain check (Coinbase's 40 facilitator addresses have relayed
106,602,243 lifetime settlements, matching x402scan's independent count to 0.02%). Two different
methods agree the catalog is a small slice of the real market. This is the best-verified finding
available and the one this draft leads with.

## Does a single "Nx smaller" number survive?

Inverting the coverage percentages gives two honest ratios:

- **By transaction count:** 1 / 0.030 ≈ **33×** — the real economy transacts roughly 33 times more
  often than the catalog shows.
- **By dollar volume:** 1 / 0.088 ≈ **11.4×** — real dollar volume is roughly 11.4 times the catalog's
  derived GMV.

**These two ratios do not agree with each other, and neither is "9×."** The gap between them (33x vs.
11.4x) is itself informative, not noise: it says the transactions the catalog misses skew cheaper,
on average, than the ones it captures. That is consistent with the mega-merchant finding below — a
huge share of real transaction count sits at a very low per-call price, so a coverage measure based on
counting transactions will always show a bigger miss than one based on counting dollars.

**Conclusion: there is no single clean "Nx smaller" headline that honestly represents this data.**
Stating one number (33x, 11.4x, or the old refuted 9x) without the other misrepresents which
dimension it's measuring. The honest finding is the coverage pair itself — **3.0% of transactions,
8.8% of dollars** — reported together, with the 33x/11.4x figures offered as a secondary, explicitly
dual-basis illustration rather than a standalone headline.

## Why transaction-share and dollar-share diverge: the mega-merchant

One address, `0xe9030014f5dae217d0a152f02a043567b16c1abf`, accounts for **75.7% of all x402
transactions**, at a per-transaction price of approximately **$0.0169** — corroborated three
independent ways (two disjoint on-chain measurement windows plus x402scan's own stated figure, all
landing in the $0.0157–$0.0182 band). A single high-frequency, low-price merchant dominating
transaction count while contributing a much smaller share of dollar volume is exactly the mechanism
that would produce a transaction-coverage ratio (33x) larger than a dollar-coverage ratio (11.4x).

## The one quotable dollar figure, and its caveat

Extrapolating on-chain per-transaction dollar figures across Intel's bridged 30-day Coinbase
transaction-count range gives a mean-basis range of **$132,393–$394,355** for 30-day Coinbase-specific
dollar volume. This is the only dollar-level extrapolation from this line of work that is quotable —
it is **not** more settled than that. Per Backlog #22, this range still carries **mega-merchant
dollar-share uncertainty**: the mega-merchant's true ecosystem-wide dollar share has three disagreeing
readings across sprints (22.3%, 74.37%, 57.1%, no convergence), and this range inherits that
uncertainty. It should not be presented as a single settled dollar figure, only as a bounded range
with this caveat attached every time it's cited.

**Do not quote, anywhere, as settled:** $52.6M, $28.6M, $0.55M, $2.98M, $24K, or "$24K–$394K" (the
median-basis low end is mathematically invalid — median × count discards the tail mass of a
right-skewed distribution).

## The headline this draft recommends

> **"Coinbase's own catalog shows 3.0% of the transactions and 8.8% of the dollars that the real x402
> economy settles."**

This is matched-window, cross-corroborated, and doesn't force a single ratio onto two dimensions that
disagree. If a single number is wanted for a punchier headline, dollar-basis 11.4x ("real x402 dollar
volume runs about 11x what Coinbase's catalog shows") is the more defensible of the two derived
ratios, since dollar coverage is less distorted by one dominant cheap merchant than transaction-count
coverage is — but it should still be presented alongside the 33x transaction figure, not instead of
it, so the mega-merchant effect is visible rather than hidden.

---

## What this draft deliberately does not do

- Does not re-run or re-derive the underlying coverage/mega-merchant measurements — they are cited
  from `STRATEGY.md` §0.2 as established.
- Does not resolve the mega-merchant dollar-share disagreement (22.3% / 74.37% / 57.1%) — that is
  still open per Backlog #22 and out of scope here.
- Does not publish anything. This file is a draft only; publication is Michael's decision.

**File:** `C:/Users/Micha/Desktop/x402/notes-economy-size-draft.md`
