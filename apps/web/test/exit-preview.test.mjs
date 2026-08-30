// @ts-check
/**
 * The exit calculator against hand-computed VaultCore values. The point of these is the ORDER of
 * the integer divisions, not the arithmetic: `_settleExit` floors at each `/`, so an
 * algebraically-identical reordering returns a different number of tokens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitFeeBps, secondsUntilFeeBps, previewExit, SHORTFALL_DUST_WAD } from '../src/exit-preview.mjs';

const WAD = 10n ** 18n;
const DAY = 86_400n;

test('exitFeeBps mirrors maxBps * (period - tenure) / period', () => {
  const p = { exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 90n * DAY };
  assert.equal(exitFeeBps({ ...p, tenureSec: 0n }), 100n); // full 1% on day zero
  assert.equal(exitFeeBps({ ...p, tenureSec: 45n * DAY }), 50n); // half way
  assert.equal(exitFeeBps({ ...p, tenureSec: 90n * DAY }), 0n); // fully decayed
  assert.equal(exitFeeBps({ ...p, tenureSec: 900n * DAY }), 0n); // past the period
});

test('exitFeeBps floors, exactly as the contract does', () => {
  // 100 * (7 - 1) / 7 = 85.71… → 85, not 86.
  assert.equal(exitFeeBps({ exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 7n, tenureSec: 1n }), 85n);
});

test('exitFeeBps: sole holder pays nothing, and a zero maxBps short-circuits', () => {
  // `if (memberShares == ts) feeBps = 0` — the fee accrues to remaining members, and there are none.
  assert.equal(exitFeeBps({ exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 90n * DAY, tenureSec: 0n, isSoleHolder: true }), 0n);
  assert.equal(exitFeeBps({ exitFeeMaxBps: 0, exitFeeDecayPeriodSec: 90n * DAY, tenureSec: 0n }), 0n);
  // A vault configured with a fee but no decay period cannot exist (VaultCore BadConfig), but the
  // display must not divide by zero if the API ever hands us one.
  assert.equal(exitFeeBps({ exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 0n, tenureSec: 0n }), 0n);
});

test('secondsUntilFeeBps answers "how long until this costs me nothing"', () => {
  const p = { exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 90n * DAY, tenureSec: 30n * DAY };
  assert.equal(secondsUntilFeeBps(p, 0n), Number(60n * DAY));
  assert.equal(secondsUntilFeeBps(p, 50n), Number(15n * DAY)); // reach 0.50% at day 45
  assert.equal(secondsUntilFeeBps({ ...p, tenureSec: 90n * DAY }, 0n), null); // already there
  assert.equal(secondsUntilFeeBps({ ...p, exitFeeMaxBps: 0 }, 0n), null); // never charged
});

test('previewExit reproduces the contract order of operations under truncation', () => {
  // Chosen so the intermediate divisions actually floor.
  // ts = 3, burn = 1, keepBps = 9950 (0.50% fee).
  //   slice  = 1000 * 1 / 3 * 9950 / 10000 = 333 * 9950 / 10000 = 3313350/10000 = 331
  //   Reordered as (1000 * 9950 / 10000) * 1 / 3 you would get 995/3 = 331 too, so also pin a
  //   case where the two differ: bal = 7, ts = 3 → 7*1/3 = 2 → 2*9950/10000 = 1;
  //   reordered: 7*9950/10000 = 6 → 6/3 = 2. The contract pays 1.
  const r = previewExit({
    burnShares: 1n,
    memberShares: 1n,
    totalShares: 3n,
    idleUsdc: 0n,
    basket: [
      { symbol: 'WETH', balance: 1000n, decimals: 18 },
      { symbol: 'cbBTC', balance: 7n, decimals: 8 },
    ],
    exitFeeMaxBps: 50,
    exitFeeDecayPeriodSec: 100n,
    tenureSec: 0n,
  });
  assert.equal(r.ok, true);
  assert.equal(r.feeBps, 50n);
  assert.equal(r.keepBps, 9950n);
  assert.equal(r.slices[0].amount, 331n);
  assert.equal(r.slices[1].amount, 1n, 'must floor per-step, not once at the end');
});

test('previewExit: idle USDC leg follows cashTargetWad → /usdcScalar → cap at idle', () => {
  // idle 1,000 USDC, ts 4 WAD, burn 1 WAD, no fee ⇒ exactly a quarter.
  const r = previewExit({
    burnShares: WAD,
    memberShares: WAD,
    totalShares: 4n * WAD,
    idleUsdc: 1_000_000_000n, // 1,000.000000 USDC
    basket: [],
    exitFeeMaxBps: 0,
    exitFeeDecayPeriodSec: 0n,
    tenureSec: 0n,
  });
  assert.equal(r.ok, true);
  assert.equal(r.usdcPay, 250_000_000n); // 250.000000 USDC
  assert.equal(r.coversFromChildren, false);
});

test('previewExit: the exit fee stays in the vault — payout drops by exactly keepBps', () => {
  const base = {
    burnShares: WAD,
    memberShares: WAD,
    totalShares: 4n * WAD,
    idleUsdc: 1_000_000_000n,
    basket: [],
    exitFeeDecayPeriodSec: 100n,
    tenureSec: 0n,
  };
  const free = previewExit({ ...base, exitFeeMaxBps: 0 });
  const feed = previewExit({ ...base, exitFeeMaxBps: 100 }); // 1%, the protocol cap
  assert.equal(free.usdcPay, 250_000_000n);
  assert.equal(feed.usdcPay, 247_500_000n); // 250 × 9900/10000
  assert.equal(feed.feeBps, 100n);
});

test('previewExit prices the payout only when every leg is priced', () => {
  const priced = previewExit({
    burnShares: WAD,
    memberShares: WAD,
    totalShares: 2n * WAD,
    idleUsdc: 100_000_000n, // 100 USDC
    basket: [{ symbol: 'WETH', balance: 2n * WAD, decimals: 18, priceWad: 3_000n * WAD }],
    exitFeeMaxBps: 0,
    exitFeeDecayPeriodSec: 0n,
    tenureSec: 0n,
  });
  assert.equal(priced.valueComplete, true);
  // 50 USDC (=50 WAD-scaled) + 1 WETH @ 3000 = 3050 USD in WAD
  assert.equal(priced.payoutValueWad, 3050n * WAD);

  const unpriced = previewExit({
    burnShares: WAD,
    memberShares: WAD,
    totalShares: 2n * WAD,
    idleUsdc: 100_000_000n,
    basket: [{ symbol: 'WETH', balance: 2n * WAD, decimals: 18, priceWad: null }],
    exitFeeMaxBps: 0,
    exitFeeDecayPeriodSec: 0n,
    tenureSec: 0n,
  });
  // An unpriced slice must not be silently valued at zero — the total is refused instead.
  assert.equal(unpriced.valueComplete, false);
  assert.equal(unpriced.payoutValueWad, null);
  assert.equal(unpriced.slices[0].amount, WAD, 'the token amount is still exact and shown');
});

test('previewExit flags a payout that would unwind child vaults as not fully modelled', () => {
  // idle cannot cover the cash target once child value is included ⇒ SV-5 shortfall path.
  const r = previewExit({
    burnShares: WAD,
    memberShares: WAD,
    totalShares: 2n * WAD,
    idleUsdc: 1_000_000n, // 1 USDC of idle
    childValueWad: 1_000n * WAD, // but $1,000 sitting in a child
    basket: [],
    exitFeeMaxBps: 0,
    exitFeeDecayPeriodSec: 0n,
    tenureSec: 0n,
  });
  assert.equal(r.coversFromChildren, true);
  assert.equal(r.usdcPay, 1_000_000n, 'capped at idle, as the contract caps it');
});

test('a RESIDUAL is not a child unwind — the dust bound is the contract’s own', () => {
  // SHORTFALL_DUST_WAD is 1e12 and usdcScalar is ALSO 1e12 at USDC's 6 decimals, so
  // `cashTargetWad - usdcPay * usdcScalar` is uniform in [0, 1e12) and ALWAYS below the bound:
  // the contract's child-unwind loop never runs on it. Comparing against 0n instead flags
  // essentially every exit, root vaults with no children included.
  assert.equal(SHORTFALL_DUST_WAD, 1_000_000_000_000n);
  const residual = previewExit({
    burnShares: WAD,
    memberShares: WAD,
    totalShares: 3n * WAD, // 1/3 of an odd idle balance: does NOT divide evenly
    idleUsdc: 1_000_000_001n,
    basket: [],
    exitFeeMaxBps: 0,
    exitFeeDecayPeriodSec: 0n,
    tenureSec: 0n,
  });
  assert.equal(residual.usdcPay, 333_333_333n);
  assert.ok(residual.usdcPay * 1_000_000_000_000n < 1_000_000_001n * 1_000_000_000_000n / 3n,
    'a real sub-scalar residual exists here');
  assert.equal(residual.coversFromChildren, false, 'sub-dust residual is not a child unwind');

  // A genuine child shortfall still trips it.
  const child = previewExit({
    burnShares: WAD, memberShares: WAD, totalShares: 2n * WAD,
    idleUsdc: 1_000_000n, childValueWad: 1_000n * WAD, basket: [],
    exitFeeMaxBps: 0, exitFeeDecayPeriodSec: 0n, tenureSec: 0n,
  });
  assert.equal(child.coversFromChildren, true);
  assert.equal(child.feeValueWad, null, 'un-recovered child value is not an exit fee');
});

test('the 10% performance fee is modelled as a CEILING, on every leg', () => {
  // VaultCore.sol:660-704 withholds perfFee UNIFORMLY across the USDC leg and every token slice
  // AFTER the point the rest of this module stops. The exact fee needs the per-(member,operator)
  // HWM loss carry, which no projection exposes — so only the bound `gain / 10` is modelled.
  const r = previewExit({
    burnShares: WAD,
    memberShares: WAD,
    totalShares: 2n * WAD,
    idleUsdc: 200_000_000n, // 200 USDC idle; the exiter's half is 100
    basket: [{ symbol: 'WETH', balance: 2n * WAD, decimals: 18, priceWad: 3_000n * WAD }],
    costBasisUsdc: 1_000_000_000n, // $1,000 basis, all of it removed — this is a full exit
    exitFeeMaxBps: 0,
    exitFeeDecayPeriodSec: 0n,
    tenureSec: 0n,
  });
  // payout = 100 USDC + 1 WETH @ $3,000 = $3,100. basisRemoved = costBasis * burn / memberShares
  // = the whole $1,000. gain = 2,100.
  assert.equal(r.payoutValueWad, 3_100n * WAD);
  assert.equal(r.perfFee.gainUsdc, 2_100_000_000n);
  assert.equal(r.perfFee.maxUsdc, 210_000_000n, 'the contract clamps at gain / 10');
  // feeFracWad = perfFee * usdcScalar * WAD / payoutValueWad
  const frac = (210_000_000n * 10n ** 12n * WAD) / (3_100n * WAD);
  assert.equal(r.perfFee.maxFracWad, frac);
  assert.equal(r.usdcPayMin, r.usdcPay - (r.usdcPay * frac) / WAD);
  assert.equal(r.slices[0].amountMin, r.slices[0].amount - (r.slices[0].amount * frac) / WAD);
  assert.ok(r.usdcPayMin < r.usdcPay, 'the USDC leg is reduced too, not only the token slices');
  assert.ok(r.payoutValueMinWad < r.payoutValueWad);
  // The bound is at most 10% of the payout, and reached only when the whole payout is gain.
  assert.ok(frac <= WAD / 10n);
});

test('no cost basis, no unpriced leg, no child unwind ⇒ no fabricated fee bound', () => {
  const noBasis = previewExit({
    burnShares: WAD, memberShares: WAD, totalShares: 2n * WAD, idleUsdc: 200_000_000n,
    basket: [], exitFeeMaxBps: 0, exitFeeDecayPeriodSec: 0n, tenureSec: 0n,
  });
  assert.equal(noBasis.perfFee, null, 'the HWM carry is not guessed at');
  assert.equal(noBasis.usdcPayMin, null);

  const atALoss = previewExit({
    burnShares: WAD, memberShares: WAD, totalShares: 2n * WAD, idleUsdc: 200_000_000n,
    costBasisUsdc: 10_000_000_000n, basket: [], exitFeeMaxBps: 0, exitFeeDecayPeriodSec: 0n, tenureSec: 0n,
  });
  assert.equal(atALoss.perfFee.gainUsdc, 0n, 'no gain, no performance fee');
  assert.equal(atALoss.perfFee.maxUsdc, 0n);
  assert.equal(atALoss.usdcPayMin, atALoss.usdcPay);
});

test('previewExit refuses rather than guesses on bad input', () => {
  const missing = previewExit({ burnShares: WAD, memberShares: WAD, totalShares: undefined, idleUsdc: 0n, basket: [] });
  assert.equal(missing.ok, false);
  const tooMany = previewExit({ burnShares: 2n * WAD, memberShares: WAD, totalShares: 4n * WAD, idleUsdc: 0n, basket: [] });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /do not hold/);
  const zero = previewExit({ burnShares: 0n, memberShares: WAD, totalShares: WAD, idleUsdc: 0n, basket: [] });
  assert.equal(zero.ok, false);
});

test('previewExit marks a full-balance exit and a sole-holder exit distinctly', () => {
  const sole = previewExit({
    burnShares: WAD, memberShares: WAD, totalShares: WAD, idleUsdc: 100n, basket: [],
    exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 100n, tenureSec: 0n,
  });
  assert.equal(sole.isSoleHolder, true);
  assert.equal(sole.isFullExit, true);
  assert.equal(sole.feeBps, 0n, 'last member out is waived — there is nobody to accrue the fee to');
});
