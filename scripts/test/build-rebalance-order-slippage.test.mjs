/**
 * Card 209: scripts/build-rebalance-order.mjs always encoded the contract's ceiling
 * (`MAX_REBALANCE_SLIPPAGE_BPS`, 200 bps / 2%) as the payload's `maxSlippageBps`, with no CLI
 * override -- every real rebalance authorised the worst loss VaultCore would tolerate, whatever
 * the pool depth or order size. CTO decision 2026-09-23: default to a per-order DERIVED value
 * (`ceil(poolFeeBps + measuredExecutionGapBps) + 25 bps`, capped at 100 bps), with an explicit
 * `--max-slippage-bps N` override bounded by the chain ceiling and by the derived minimum.
 *
 * This does NOT spin up a fake chain for the derivation tests. `validateOverrideRange` and
 * `deriveMaxSlippageBps` (exported from scripts/build-rebalance-order.mjs) are PURE -- no chain
 * call, no `process.exit` -- specifically so every refusal branch is testable directly against
 * plain bigint inputs. The script's own `main()` only runs when invoked as `node
 * scripts/build-rebalance-order.mjs ...` (see the `isMain` guard at the bottom of that file), so
 * importing it here to reach these functions is safe.
 *
 * `buildRebalanceOrder` IS ALSO PURE, and it is what actually assembles the payload bytes
 * `Governance.execute`'s Rebalance branch decodes -- a regression that wires the payload's
 * `maxSlippageBps` word back to the chain ceiling (the original shape of card 209's bug) would
 * NOT be caught by testing `deriveMaxSlippageBps` alone, since that function never touches the
 * payload. The tests below decode the real payload bytes with the real `cast` binary (the same
 * `cast abi-decode` scripts/test/rebalance-payload-shape.test.mjs uses for card 207) against the
 * decode signature read off the compiled VaultCore ABI (`rebalanceDecodeSig`, exported from the
 * same module) rather than a hand-typed shape -- so a drift in either the encoder or the decode
 * signature is caught, not just a drift between two hand-typed copies of one shape.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  validateOverrideRange,
  deriveMaxSlippageBps,
  buildRebalanceOrder,
  rebalanceDecodeSig,
  DERIVED_BUFFER_BPS,
  DERIVED_CAP_BPS,
} from '../build-rebalance-order.mjs';

const BPS = 10000n;
const CEILING = 200n; // VaultCore.MAX_REBALANCE_SLIPPAGE_BPS on the mainnet deploy this targets.

function cast(...args) {
  return execFileSync('cast', args, { encoding: 'utf8' }).trim();
}

/**
 * A baseline set of derivable inputs shaped so the derivation lands comfortably inside the
 * default 100 bps cap: pool fee 5 bps (500 ppm, a real Uniswap V3 tier), a pool paying exactly
 * oracle value pre-fee (zero execution gap), so derivedSlipBps = 5 + 0 + 25 = 30 bps.
 *
 * `grossOut` -- NOT `expectedOut` -- is the field `deriveMaxSlippageBps` reads for the gap
 * measurement. Feeding it the fee-adjusted figure would count the pool fee twice (see that
 * function's docstring); these fixtures name the field the same way to keep that distinction
 * visible at every call site here, not just in the implementation.
 */
function baseInputs(overrides = {}) {
  const unitOut = 10n ** 18n; // 1e18, an 18-decimal basket asset
  const priceOutWad = 2000n * 10n ** 18n; // $2000 per unit, oracle-scaled
  const valueInWad = 1000n * 10n ** 18n; // $1000 of input, at wad scale
  // oracleFloorZeroSlip = ceil(valueInWad * unitOut / priceOutWad) = 1000/2000 * 1e18 = 0.5e18
  const oracleFloorZeroSlip = (valueInWad * unitOut + priceOutWad - 1n) / priceOutWad;
  return {
    poolFeeRawPpm: 500n, // 5 bps
    valueInWad,
    unitOut,
    priceOutWad,
    grossOut: oracleFloorZeroSlip, // pool pays exactly oracle value pre-fee -> zero gap
    overrideBps: null,
    allowBelowDerived: false,
    BPS,
    ...overrides,
  };
}

test('validateOverrideRange: within 1..ceiling is ok', () => {
  assert.deepEqual(validateOverrideRange(1n, CEILING), { ok: true });
  assert.deepEqual(validateOverrideRange(CEILING, CEILING), { ok: true });
  assert.deepEqual(validateOverrideRange(100n, CEILING), { ok: true });
});

test('validateOverrideRange: above the chain ceiling refuses before any contract call would revert', () => {
  const r = validateOverrideRange(CEILING + 1n, CEILING);
  assert.equal(r.ok, false);
  assert.match(r.reason, /outside 1\.\.200/);
  assert.match(r.reason, /BadSlippageBound/);
});

test('validateOverrideRange: zero refuses (VaultCore requires maxSlippageBps > 0)', () => {
  const r = validateOverrideRange(0n, CEILING);
  assert.equal(r.ok, false);
});

test('deriveMaxSlippageBps: omitted override + derivable -> DERIVED value chosen, never the ceiling', () => {
  const r = deriveMaxSlippageBps(baseInputs());
  assert.equal(r.ok, true);
  assert.equal(r.usedOverride, false);
  // fee 5 + gap 0 + buffer 25 = 30
  assert.equal(r.derivedSlipBps, 30n);
  assert.equal(r.chosenSlipBps, 30n);
  assert.notEqual(r.chosenSlipBps, CEILING, 'must never silently fall back to the ceiling');
});

test('deriveMaxSlippageBps: a real execution gap is measured and added, not ignored', () => {
  // Pool pays 0.5% (50 bps) less than the oracle floor, PRE-FEE -> measuredExecutionGapBps ~= 50,
  // kept small enough that fee(5) + gap(~50) + buffer(25) still lands under the 100 bps default
  // cap, so this test isolates "is the gap measured correctly" from the separate cap-refusal test.
  const inputs = baseInputs();
  const gapped = (inputs.grossOut * 9950n) / 10000n;
  const r = deriveMaxSlippageBps({ ...inputs, grossOut: gapped });
  assert.equal(r.ok, true);
  assert.ok(r.measuredExecutionGapBps >= 49n && r.measuredExecutionGapBps <= 51n,
    `expected ~50 bps gap, got ${r.measuredExecutionGapBps}`);
  assert.equal(r.derivedSlipBps, r.poolFeeBps + r.measuredExecutionGapBps + DERIVED_BUFFER_BPS);
});

test('deriveMaxSlippageBps: the gap is measured PRE-FEE -- feeding it the fee-adjusted fill double-counts the fee', () => {
  // Regression for the "double fee count" defect: if the gap were (wrongly) measured against a
  // fee-adjusted fill instead of the pre-fee grossOut, a pool paying EXACTLY oracle value pre-fee
  // (zero real gap) would still show a gap equal to the fee itself, and derivedSlipBps would come
  // out as 2*fee + 25 instead of fee + 25.
  const inputs = baseInputs({ poolFeeRawPpm: 3000n }); // 30 bps fee, grossOut == oracle floor (no gap)
  const r = deriveMaxSlippageBps(inputs);
  assert.equal(r.ok, true);
  assert.equal(r.measuredExecutionGapBps, 0n, 'a pool at exactly oracle value pre-fee has zero gap');
  assert.equal(r.derivedSlipBps, 30n + 25n, 'fee(30) + gap(0) + buffer(25), not 2x the fee');
});

test('deriveMaxSlippageBps: derived above the 100 bps cap, no override -> REFUSES', () => {
  // Pool fee alone at 100 bps (a 1% Uniswap tier) already exceeds the cap once the buffer is added.
  const r = deriveMaxSlippageBps(baseInputs({ poolFeeRawPpm: 10000n })); // 100 bps fee
  assert.equal(r.ok, false);
  assert.equal(r.derivedSlipBps > DERIVED_CAP_BPS, true);
  assert.match(r.reason, /exceeds the 100 bps default cap/);
  assert.match(r.reason, /--max-slippage-bps/);
});

test('deriveMaxSlippageBps: override above the derived minimum is accepted even above the 100 bps cap', () => {
  const inputs = baseInputs({ poolFeeRawPpm: 10000n, overrideBps: 150n }); // derived > 100, override under ceiling
  const r = deriveMaxSlippageBps(inputs);
  assert.equal(r.ok, true);
  assert.equal(r.usedOverride, true);
  assert.equal(r.chosenSlipBps, 150n);
});

test('deriveMaxSlippageBps: override below the derived minimum -> REFUSES', () => {
  const inputs = baseInputs({ overrideBps: 5n }); // derived is 30 above
  const r = deriveMaxSlippageBps(inputs);
  assert.equal(r.ok, false);
  assert.match(r.reason, /below the derived minimum/);
  assert.match(r.reason, /SwapSlippage/);
  assert.match(r.reason, /--allow-below-derived/);
});

test('deriveMaxSlippageBps: override below derived minimum + --allow-below-derived -> accepted', () => {
  const inputs = baseInputs({ overrideBps: 5n, allowBelowDerived: true });
  const r = deriveMaxSlippageBps(inputs);
  assert.equal(r.ok, true);
  assert.equal(r.usedOverride, true);
  assert.equal(r.chosenSlipBps, 5n);
});

test('deriveMaxSlippageBps: underivable (no oracle price) -> REFUSES, never falls back to a constant', () => {
  const r1 = deriveMaxSlippageBps(baseInputs({ priceOutWad: 0n }));
  assert.equal(r1.ok, false);
  assert.equal(r1.chosenSlipBps, undefined);
  const r2 = deriveMaxSlippageBps(baseInputs({ priceOutWad: null }));
  assert.equal(r2.ok, false);
});

test('deriveMaxSlippageBps: underivable (no pool fee) -> REFUSES, never falls back to a constant', () => {
  const r = deriveMaxSlippageBps(baseInputs({ poolFeeRawPpm: null }));
  assert.equal(r.ok, false);
  assert.equal(r.chosenSlipBps, undefined);
});

test('deriveMaxSlippageBps: underivable (no expected fill) -> REFUSES, never falls back to a constant', () => {
  const r = deriveMaxSlippageBps(baseInputs({ grossOut: null }));
  assert.equal(r.ok, false);
  assert.equal(r.chosenSlipBps, undefined);
});

test('deriveMaxSlippageBps: an underivable input still refuses even when an override is supplied', () => {
  // No silent fallback anywhere (card 209): the below-derived comparison itself needs a real
  // derivation, so a missing oracle price refuses regardless of whether --max-slippage-bps was
  // passed -- it must never fall through to "use the override, skip the check".
  const r = deriveMaxSlippageBps(baseInputs({ priceOutWad: 0n, overrideBps: 50n }));
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------------------------
// buildRebalanceOrder: the payload-assembly layer. These are the tests that actually exercise
// card 209's original bug SITE (the payload word), not just the pure derivation.
// ---------------------------------------------------------------------------------------------

/** A full set of buildRebalanceOrder inputs on top of baseInputs's derivable numbers. */
function orderInputs(overrides = {}) {
  const b = baseInputs(overrides);
  return {
    adapter: '0x000000000000000000000000000000000000A1',
    usdc: '0x000000000000000000000000000000000000B2',
    tokenOut: '0x000000000000000000000000000000000000C3',
    amountIn: 1000000n, // matches baseInputs' $1000 valueInWad at a 6-decimal settlement token
    unitOut: b.unitOut,
    priceOutWad: b.priceOutWad,
    usdcScalar: b.valueInWad / 1000000n, // amountIn * usdcScalar === valueInWad
    poolFeeRawPpm: b.poolFeeRawPpm,
    grossOut: b.grossOut,
    overrideBps: b.overrideBps,
    allowBelowDerived: b.allowBelowDerived,
    floorBufferBps: 10n, // well under the ~30 bps derived default in these fixtures
    deadline: 4102444800n, // an arbitrary far-future unix timestamp
    BPS,
    ...overrides,
  };
}

test('buildRebalanceOrder: encodes the DERIVED maxSlippageBps into the real payload bytes, not the ceiling', () => {
  const order = buildRebalanceOrder(orderInputs());
  assert.equal(order.ok, true);
  assert.equal(order.chosenSlipBps, 30n); // fee 5 + gap 0 + buffer 25, as in the pure-derivation test above
  assert.notEqual(order.chosenSlipBps, CEILING);

  const decoded = cast('abi-decode', '--input', rebalanceDecodeSig(), order.payload);
  const lines = decoded.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.equal(lines.length, 3, `expected 3 decoded values (adapter, maxSlippageBps, orders): ${decoded}`);
  const decodedSlippage = BigInt(lines[1]);
  assert.equal(decodedSlippage, order.chosenSlipBps,
    'the payload\'s maxSlippageBps word must equal the derived/chosen value, never the ceiling');
  assert.notEqual(decodedSlippage, CEILING);
});

test('buildRebalanceOrder: an explicit --max-slippage-bps override is what actually lands in the payload', () => {
  const order = buildRebalanceOrder(orderInputs({ overrideBps: 77n }));
  assert.equal(order.ok, true);
  assert.equal(order.chosenSlipBps, 77n);
  const decoded = cast('abi-decode', '--input', rebalanceDecodeSig(), order.payload);
  const decodedSlippage = BigInt(decoded.split('\n')[1].trim());
  assert.equal(decodedSlippage, 77n);
});

test('buildRebalanceOrder: floor-buffer-bps at or above the CHOSEN value refuses (checked against chosen, not ceiling)', () => {
  // Derived is 30 here; a 30 bps floor buffer is incoherent against a 30 bps chosen tolerance even
  // though it is nowhere near the 200 bps chain ceiling -- card 209 re-pointed this check at the
  // chosen value specifically so a buffer like this cannot slip through because it looks small
  // next to the ceiling.
  const order = buildRebalanceOrder(orderInputs({ floorBufferBps: 30n }));
  assert.equal(order.ok, false);
  assert.match(order.reason, /floor-buffer-bps 30 is at or above the chosen maxSlippageBps 30/);
});

test('buildRebalanceOrder: an underivable input refuses before any payload is built', () => {
  const order = buildRebalanceOrder(orderInputs({ priceOutWad: 0n }));
  assert.equal(order.ok, false);
  assert.equal(order.payload, undefined);
});

test('buildRebalanceOrder: unaffordable at the pool\'s spot price refuses rather than emitting a doomed order', () => {
  // floorBufferBps 26, still comfortably under the chosen 30 bps (passes the coherence check),
  // but the 25 bps of headroom the derivation's own buffer bought is only exactly 25 bps -- one
  // more bps of floor buffer than that is not affordable against what this fixture's pool would
  // actually pay net of its fee.
  const order = buildRebalanceOrder(orderInputs({ floorBufferBps: 26n }));
  assert.equal(order.ok, false);
  assert.match(order.reason, /reverts SwapSlippage/);
});

test('buildRebalanceOrder: bareFloor rounds the oracle floor UP, not down, at a non-divisible edge (V-380-r1)', () => {
  // Security's V-380-r1 mutation M6 (rounding `bareFloor` DOWN instead of up) survived all fixtures
  // above -- every one of them happens to land on a priceOutWad that divides requiredValueWad *
  // unitOut evenly, so ceil-division and floor-division produce the same integer and the mutation
  // is invisible. This fixture is chosen so it does NOT divide evenly (priceOutWad = 3), which is
  // the exact edge the fuzz found: a floor-rounded bareFloor is one wei under the contract's own
  // floor-division floor and reverts MinOutTooLow at execution, after a full vote cycle, even
  // though every input was individually valid.
  const order = buildRebalanceOrder({
    adapter: '0x000000000000000000000000000000000000A1',
    usdc: '0x000000000000000000000000000000000000B2',
    tokenOut: '0x000000000000000000000000000000000000C3',
    amountIn: 10000000n,
    usdcScalar: 1n,
    unitOut: 1n,
    priceOutWad: 3n,
    poolFeeRawPpm: 500n, // 5 bps
    grossOut: 3333334n, // ceil(10,000,000 * 1 / 3): zero execution gap at this price, isolates rounding
    floorBufferBps: 0n, // isolates bareFloor itself -- the buffer widening is a separate ceiling div
    deadline: 4102444800n,
    BPS,
  });
  assert.equal(order.ok, true);
  assert.equal(order.chosenSlipBps, 30n); // fee 5 + gap 0 + buffer 25, same derivation as above
  assert.equal(order.minAmountOut, order.bareFloor, 'floorBufferBps 0 -> minAmountOut === bareFloor');

  // requiredValueWad = ceil(valueInWad * (BPS - chosenSlipBps) / BPS), reproduced here from the
  // same inputs so this test is not just restating whatever bareFloor the implementation returns.
  const requiredValueWad = (10000000n * (BPS - order.chosenSlipBps) + BPS - 1n) / BPS;

  // VaultCore's OWN floor-division inequality at execution time (_valueWad rounds down): bareFloor
  // * priceOutWad must be at least requiredValueWad * unitOut, or the fill reverts MinOutTooLow
  // regardless of price. This is the contract's exact check, not a re-implementation of it -- a
  // floor-rounded bareFloor lands one wei under it on this non-divisible input and the assertion
  // goes red under mutation M6.
  assert.ok(order.bareFloor * 3n >= requiredValueWad * 1n,
    `bareFloor ${order.bareFloor} must satisfy VaultCore's own floor-division floor `
    + `(requiredValueWad*unitOut = ${requiredValueWad})`);

  // And it must be the TIGHTEST integer satisfying that -- one less already fails -- which pins
  // this down to exactly ceiling division rather than any other value that happens to pass.
  assert.ok((order.bareFloor - 1n) * 3n < requiredValueWad * 1n,
    'bareFloor must be the minimal integer satisfying the contract inequality, not merely a safe one');
});
