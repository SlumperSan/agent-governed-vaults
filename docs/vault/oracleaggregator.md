# OracleAggregator

> **⚠ RETIRED — not the launch oracle, and no longer in `contracts/src/`.** Finding
> [[c6-oracle-byzantine]] proved this design could not be secured by curation, so it was
> **replaced** by [[chainlinkoracle]] rather than patched ([[chainlink-direct-pivot]]). The source
> now lives at **`contracts/test/retired/OracleAggregator.sol`**, kept only as the C-4/C-6 exploit
> evidence; the `VaultFactory` oracle allowlist makes it non-selectable on the launch path. This
> note is the design record. Read it as history.

The bespoke per-vault price oracle: a **multi-source median** with a per-asset staleness circuit
breaker. Config was immutable after construction — no admin could swap sources, retune staleness, or
lower the quorum. `contracts/test/retired/OracleAggregator.sol` (was `contracts/src/`).

## Why it matters

NAV is priced through this contract, so it decides what a share is worth on every deposit,
redemption, and rebalance. A wrong or manipulable price here is a direct theft vector (mint cheap
shares, redeem rich). It is also the contract that **could not be fully secured** against an
adversarial source set — finding [[c6-oracle-byzantine]] is fundamental to the median design, which
is exactly why [[chainlinkoracle]] replaced it. Nothing here prices a launch vault.

## Key state and constants

- `_cfg[asset]` — `AssetConfig { address[] sources; uint32 maxStaleness; uint8 quorum; }`.
- `MAX_STALENESS_CEILING` = 1 day (bounds the underflow honeypot and the latency-arb window).
- `MIN_SOURCES` = 3 (§11 / SF-1: median of >= 3 independent sources).
- `MIN_MEDIAN` = 3 — quorum must reach this so a config can never select `min()`.

## How it prices (`priceWad`)

1. Poll every source via `_tryLatestPrice` (a raw staticcall, C-3 remediation — see below).
2. Keep the fresh set: `ok && p > 0 && updatedAt >= block.timestamp - maxStaleness`. A saturating
   lower bound avoids underflow-panic.
3. If fewer than `max(quorum, MIN_MEDIAN)` fresh sources: **revert `StaleOracle`** (breaker).
4. Insertion-sort the fresh set (m <= 15) and return the **lower median** `fresh[(k-1)/2]` — no
   averaging, so no even-k swing and no sum-overflow freeze.

An unlisted asset reverts `StaleOracle`, never returns 0. Failure freezes every NAV path in
consuming vaults, including exits (K-4, by design).

## Security findings that live here

- [[c6-oracle-byzantine]] — **the core one.** The lower-median selection is honest only when the
  honest sources are a majority of the *fresh* set: with `a` adversarial sources the lower median is
  honest iff `k > 2a`; at `k = 2a` it lands inside the adversarial minority and returns their quote.
  `k` can fall to the quorum via withholding, and one honest leg going quiet (a TWAP on a stalled
  pool) suffices at `m = 5`. Safety against `a` adversaries needs `quorum >= 2a+1`, and to also
  tolerate `f` benign withholdings, `m >= 2a+f+1` — which `m = 5` cannot satisfy for `a >= 2`. **The
  constructor cannot see `a`,** so this is a **listing requirement** (genuinely independent
  sources), not a code check. This is why [[chainlinkoracle]] exists — see
  [[chainlink-direct-pivot]]. Because the listing requirement is uncheckable in this contract, the
  complementary lever lives one level up: [[vaultfactory]]'s `allowedOracles_` allowlist (**DONE, PR
  #50**) can make this aggregator **non-deployable**, reverting `OracleNotAllowed` for any vault that
  tries to select it, once the allowlist is populated with blessed oracles.
- **H-1** — the constructor now requires `quorum >= MIN_MEDIAN` and `quorum > m/2`. Previously
  quorum 2-of-3 was allowed, so the lower median `fresh[(k-1)/2]` at `k = 2` was `fresh[0]` — the
  **minimum**, biased one-directionally downward, the exploitable direction for share issuance
  (C-4). Consequence, stated in the code: at `m = 3` this forces `quorum == 3` (zero fault
  tolerance — any one source failing trips the breaker). Fault tolerance and median integrity cannot
  both be had at `m = 3`; the resolution is **`m >= 5`**, not a lower quorum. `priceWad` re-checks
  both bounds because deployed aggregators may carry a pre-H-1 quorum of 2.
- **C-3** — `_tryLatestPrice` is a raw `staticcall` with an explicit 64-byte length check. A
  `try/catch` **cannot** absorb a decode failure: Solidity decodes the returned buffer in the
  caller's frame *after* the callee returned successfully, so a source returning 32/0 bytes (or
  having no code) made `priceWad` revert unconditionally with empty returndata — for every wired
  vault, permanently. The raw call also bounds the copy to two words, so a returndata bomb cannot
  OOG the reader.
- **M-1** — literal address-equality dedupe: `[S, S, S]` satisfied "3 sources" and any quorum but
  its median was just `S`. Correlated upstreams behind *distinct* addresses stay out of code's reach
  (the accepted SF-1 residual — [[c6-oracle-byzantine]] again), but literal duplicates do not.
- **Finding 2** — staleness bounded on both sides (nonzero and <= ceiling).
- **Finding 6** — the >= 3 sources + strict-majority-freshness floor.

Also defined in this file: `ChainlinkSourceAdapter` (an `IPriceSource` — documented in
[[oracle-sources]]) and the `IAggregatorV3` interface reused by [[chainlinkoracle]].

## Launch consequence

Because H-1 forces `m >= 5` for any fault tolerance, Base mainnet's shipped 3-source config is
rejected — each asset needs 5 real, independent, non-invented source addresses. This is why
launch-readiness gate 5 (mainnet oracle stack) is **NO-GO**. See [[launch-readiness-gates]].

## Size — EIP-170

Runtime ~1,215 B; margin ~23,361 B. Not size-constrained.

## Links

- [[contracts-index]] · [[chainlinkoracle]] · [[oracle-sources]] · [[vaultcore]] · [[vaultfactory]]
- Architecture: [[oracle-layer]] · [[nav-and-shares]]
- Findings: [[c6-oracle-byzantine]] · [[c3-oracle-brick]] · [[c4-depressed-price-theft]] · [[highs]]
- Decision: [[chainlink-direct-pivot]] · [[threat-model-commitments]] · [[launch-readiness-gates]]
