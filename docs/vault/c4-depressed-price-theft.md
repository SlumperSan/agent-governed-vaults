# C-4 — A depressed oracle price converts directly into theft of members' capital

Because `_mintShares` issues shares inversely proportional to reported NAV and `deposit` mints
immediately in the same transaction, a depressed price is atomically convertible into excess shares
redeemable for real assets — measured at an 88.9% loss to existing members.

## Why it matters

Critical (already Critical — immutability adjustment is a no-op). It is the *consequence* the oracle
findings feed: a wrong or attacker-chosen price at mint time is a direct transfer of existing
members' capital to the depositor.

## Mechanism

`_mintShares` mints `amountWad * totalShares / navWad()` (`VaultCore.sol:480`); `deposit` (`:387`)
mints immediately for any member past the one-time observation window. Measured
(`AuditOracleToShareTheft.t.sol`), price depressed $2,500 → $100 on an 800-wETH basket: 1,000,000
USDC in becomes a 2,777,762 USD claim; victim value 1,000,000 → 111,124 USD (−88.9%); a second test
withdraws 733.33 wETH + 916,668 USDC against 1,000,010 deposited. The oracle findings all bias
**downward** — exactly the exploitable direction. The `VaultCore` half is confirmed rigorously with
the depressed price taken as given (a `MockOracle`); the oracle half is confirmed separately by C-3,
H-1, M-1.

## Status

**CLOSED at `a ≤ 1` oracle sources; RE-OPENED at `a ≥ 2` by [[c6-oracle-byzantine]]** (2026-08-28,
Phase-2 re-verification). The original "root cause closed by C-3/H-1/H-2/M-1" claim was
**inference**, and the Phase-2 end-to-end test (`AuditC4EndToEnd.t.sol`) falsified it: against a
correctly-curated oracle (≥5 genuinely-independent sources, no single actor controlling more than
one) the trigger is gone — a single adversarial source can never move the lower median. But **two**
adversarial sources (cheapest case: a malicious creator listing two sources they control, which
passes every constructor check) seize the reported price the moment one honest leg withholds,
re-opening this measured 88.9% theft through the *real* aggregator. That is C-6. C-4's VaultCore half
is unchanged; its closure is now conditional on the C-6 curation requirement. The suggested mint-time
NAV-deviation defence-in-depth (#32) is deferred (VaultCore byte budget) and **partially subsumed**
by M-15's deposit-side `minSharesOut` overload, which now gives a depositor a transaction-level bound.

## Regression test

`contracts/test/audit/AuditOracleToShareTheft.t.sol` (2 tests, VaultCore half);
`AuditC4EndToEnd.t.sol` (7 tests, Phase-2 re-verification through the real oracle).

## Links

- [[c6-oracle-byzantine]] · [[c3-oracle-brick]] · [[highs]] (H-1, H-2, H-4) · [[oracleaggregator]] ·
  [[chainlinkoracle]] · [[chainlink-direct-pivot]]
- [[vaultcore]] · [[nav-and-shares]] · [[mediums-and-lows]] (M-1, M-15) · [[audit-reverification]] ·
  [[security-index]]
