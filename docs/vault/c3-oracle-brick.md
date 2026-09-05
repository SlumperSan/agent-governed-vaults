# C-3: One malformed price source permanently bricks all pricing on an aggregator

A single price source returning anything other than ≥64 well-formed bytes makes `priceWad` revert
**unconditionally, regardless of quorum**: permanently bricking pricing for every vault on that
aggregator, with no recovery.

## Why it matters

Critical (base High × immutable). One source out of fifteen suffices, unilaterally and permanently.
Value at risk: 100% of active share capital in every vault wired to the aggregator; no deposit can
be accepted and no exit can settle.

## Mechanism

The aggregator used `try IPriceSource(...).latestPrice() returns (uint256 p, uint256 updatedAt) {...}
catch {}` (`OracleAggregator.sol:88-90`). Solidity decodes the returned buffer in the **caller's**
frame *after* the callee returns successfully, so a `catch` clause cannot absorb a decode failure. A
source returning 32 bytes, 0 bytes, or living at a codeless address makes the whole call revert with
empty returndata, **not** `StaleOracle`. A genuine `revert("boom")` is correctly absorbed (the
passing control that isolates the defect). Two reachable paths: (a) a deploy-time typo: the
constructor performs no `code.length` check on any source, so one mistyped address bricks the asset
forever; (b) a creator-authored source serving well-formed data through the deposit phase, then
flipping to a 32-byte return with a single `SSTORE`. This defeats the K-4 premise, which accepts a
freeze requiring a *quorum failure*.

## Status

**FIXED** (earlier remediation). The `try/catch` was replaced with a `staticcall` + explicit
`ret.length >= 64` length check before `abi.decode`, and the constructor now requires
`source.code.length > 0`. A reverting or malformed source is now simply not-fresh; quorum holds
elsewhere. Requires redeploy + re-review of every aggregator instance. Note the entire custom-
aggregation oracle class is superseded at launch by [[chainlinkoracle]] / [[chainlink-direct-pivot]].

## Regression test

`contracts/test/audit/AuditAggregatorDecodeBrick.t.sol` (5 tests).

## Links

- [[oracleaggregator]] · [[oracle-sources]] · [[oracle-layer]] · [[chainlinkoracle]] ·
  [[chainlink-direct-pivot]]
- [[c6-oracle-byzantine]] · [[highs]] (H-1 lower-median) · [[threat-model-commitments]] (SF-1, K-4) ·
  [[security-index]]
