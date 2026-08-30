import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareAggregatorPin, isUsdQuoted } from '../verify-chainlink-oracle.mjs';

// ---------------------------------------------------------------------------
// AGGREGATOR-SWAP DRIFT — the off-chain half of the accepted residual.
//
// The configured feed addresses are Chainlink `EACAggregatorProxy` instances, and Chainlink swaps
// the aggregator behind them as routine operation. `ChainlinkOracle` reads `decimals()` ONCE, in
// its constructor, and caches `scale = 10**(18 - decimals)` forever. Nothing on-chain re-checks —
// that is the decision recorded in docs/LAUNCH-READINESS.md §4 row 13, argued there against an
// on-chain re-check because a re-check turns a benign upstream swap into an unrecoverable
// vault-wide freeze (the vault's oracle is immutable and there is no rotation lever).
//
// So detection lives here. The rule this file pins: a swap is a NOTICE, never a failure. Hard
// failing on it would reproduce on-chain-freeze semantics in the deploy gate — blocking a correct
// deployment for an event Chainlink performs on purpose. The safety verdict stays with the
// separate `decimals() == 8` check, which is a COMPLETE test of the residual regardless of how
// many swaps happened.
//
// Real values below, read from Base mainnet 2026-08-30 (`aggregator()` / `phaseId()` on the
// ETH/USD proxy 0x50015f8b…3a8b, the launch WETH feed).
// ---------------------------------------------------------------------------

const IMPL = '0x05c84a58Fe042275b37DB038BAacd15F410c7bB0';
const PIN = { implementation: IMPL, phaseId: 1, decimals: 8, observedAt: '2026-08-30' };

test('unchanged aggregator and phaseId is ok, not a notice', () => {
  const r = compareAggregatorPin(PIN, { implementation: IMPL, phaseId: '1' });
  assert.equal(r.status, 'ok');
  assert.match(r.message, /unchanged since the pin/);
});

test('address comparison is case-insensitive — cast prints lowercase, configs are checksummed', () => {
  const r = compareAggregatorPin(PIN, { implementation: IMPL.toLowerCase(), phaseId: '1' });
  assert.equal(r.status, 'ok', 'a checksum-case difference must not read as a swap');
});

test('phaseId is compared as a string — RPC returns "1", config holds the number 1', () => {
  const r = compareAggregatorPin({ implementation: IMPL, phaseId: '1' }, { implementation: IMPL, phaseId: 1 });
  assert.equal(r.status, 'ok');
});

test('a new aggregator behind the same proxy is DRIFT — the exact event the residual is about', () => {
  // Base ETH/USD 0x71041ddd… really did move phase 1 -> 2 -> 3 with decimals 8 throughout.
  const r = compareAggregatorPin(PIN, {
    implementation: '0x1e0b2c3896338Fbb201C4F0a27c6904801dcA06b',
    phaseId: '2',
  });
  assert.equal(r.status, 'drift');
  assert.match(r.message, /AGGREGATOR SWAPPED/);
  assert.match(r.message, /NOT a failure/, 'the message must tell the operator this does not block a deploy');
  assert.match(r.message, /decimals/, 'and must point at the check that carries the actual verdict');
});

test('a bumped phaseId alone is DRIFT even if the implementation somehow matched', () => {
  const r = compareAggregatorPin(PIN, { implementation: IMPL, phaseId: '2' });
  assert.equal(r.status, 'drift');
});

test('a missing pin is UNPINNED and hands back the exact JSON to paste', () => {
  const r = compareAggregatorPin(undefined, { implementation: IMPL, phaseId: '3' });
  assert.equal(r.status, 'unpinned');
  assert.match(r.message, new RegExp(`"implementation":"${IMPL}"`));
  assert.match(r.message, /"phaseId":3/);
});

test('an empty pin object is treated as unpinned, not as a mismatch', () => {
  assert.equal(compareAggregatorPin({}, { implementation: IMPL, phaseId: '1' }).status, 'unpinned');
});

test('a proxy answering neither view is UNREADABLE, distinct from a swap', () => {
  const r = compareAggregatorPin(PIN, { implementation: null, phaseId: null });
  assert.equal(r.status, 'unreadable', 'a non-EACAggregatorProxy feed must not be reported as a swap');
});

// This case is here because the FIRST live run of the notice produced a false alarm on it: a
// rate-limited public RPC dropped one `aggregator()` call mid-sweep and the notice announced
// "AGGREGATOR SWAPPED -> now null". A read that did not answer is not evidence of a swap, and a
// drift notice that cries wolf on network noise is one an operator learns to ignore.
test('an unanswered aggregator() read with a matching phaseId is UNREADABLE, never a swap', () => {
  const r = compareAggregatorPin(PIN, { implementation: null, phaseId: '1' });
  assert.equal(r.status, 'unreadable');
  assert.doesNotMatch(r.message, /SWAPPED/, 'a dropped RPC call must never be reported as a swap');
  assert.match(r.message, /NOT confirmed/);
});

test('phaseId alone can convict: it moved, so a swap happened even with aggregator() unread', () => {
  const r = compareAggregatorPin(PIN, { implementation: null, phaseId: '2' });
  assert.equal(r.status, 'drift');
  assert.match(r.message, /phaseId moved 1 -> 2/);
  assert.match(r.message, /NOT a failure/);
});

// --- regression guard for the #75 denomination predicate --------------------
// Kept here because `compareAggregatorPin` and `isUsdQuoted` are the two pure decisions in this
// script, and the denomination one previously had no unit coverage at all — only the Solidity
// mirror in AuditFeedDenomination.t.sol. Both halves must agree byte for byte.

test('isUsdQuoted accepts the real launch descriptions', () => {
  for (const d of ['ETH / USD', 'BTC / USD', 'LINK / USD', 'CBETH / USD', 'ETH/USD']) {
    assert.equal(isUsdQuoted(d), true, d);
  }
});

test('isUsdQuoted rejects the ETH-denominated feed that caused cbETH to be dropped', () => {
  assert.equal(isUsdQuoted('CBETH / ETH'), false);
});

test('isUsdQuoted rejects a USD-ish TOKEN quote leg — the separator is what does it', () => {
  assert.equal(isUsdQuoted('ETH / PYUSD'), false, 'PYUSD is a token, not USD');
  assert.equal(isUsdQuoted('XUSD'), false);
});

test('isUsdQuoted rejects non-strings and short strings without throwing', () => {
  for (const d of [null, undefined, 42, '', 'USD']) assert.equal(isUsdQuoted(d), false, String(d));
});
