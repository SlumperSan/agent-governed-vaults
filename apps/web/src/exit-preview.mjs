// @ts-check
/**
 * What an exit actually pays out — mirroring `VaultCore._settleExit` and `VaultCore._exitFeeBps`
 * term for term, in BigInt.
 *
 * Why term for term: every `/` in Solidity floors, so the ORDER matters. The contract computes
 *   slice_i = assetBalance[a] * burnShares / totalShares * keepBps / BPS
 * and an algebraically-identical reordering (`* keepBps / BPS` first) returns a different integer.
 * A preview that is off by dust from the settlement is a preview the user cannot trust, so this
 * module reproduces the expression rather than simplifying it. See test/exit-preview.test.mjs,
 * which pins a deliberately-truncating case.
 *
 * Scope, stated honestly: this models the common path — a vault whose exit is covered by idle
 * USDC plus basket slices. `_settleExit`'s child-unwind shortfall loop (SV-5) is NOT modelled;
 * a shortfall past the contract's own dust tolerance sets `coversFromChildren`, and callers must
 * present the payout as indicative in that case rather than exact. It is not guessed at.
 *
 * THE PERFORMANCE FEE IS A RANGE, NOT A NUMBER. After the legs above, `_settleExit` withholds
 * `perfFee` UNIFORMLY across the USDC leg and every token slice (VaultCore.sol:660-704):
 *
 *     feeFracWad = perfFee * usdcScalar * WAD / payoutValueWad
 *     usdcPay   -= usdcPay * feeFracWad / WAD
 *     memberPart = slice - slice * feeFracWad / WAD
 *
 * `perfFee` is whatever `FeeEngine.onRealize` returns, clamped to `gain / 10`. It depends on the
 * per-`(member, operator)` high-water-mark loss carry, which NO projection exposes — so the exact
 * fee is not computable here and is not guessed. What IS computable is the CEILING, `gain / 10`,
 * so every payout leg is returned as a `[min, max]` pair and callers must render it as a range.
 */

import { BPS, USDC_SCALAR, toBig } from './format.mjs';

/** WAD one. */
const WAD = 10n ** 18n;

/**
 * `VaultCore.SHORTFALL_DUST_WAD` (VaultCore.sol:49) — the tolerance below which the contract does
 * NOT run its child-unwind loop at all. It is 1e12, and `usdcScalar` is ALSO 1e12 at USDC's 6
 * decimals, so the residual of `cashTargetWad - usdcPay * usdcScalar` is uniform in
 * `[0, usdcScalar - 1]` and therefore always strictly below this bound. Comparing the residual
 * against zero instead flags essentially every exit — root vaults with no children included.
 */
export const SHORTFALL_DUST_WAD = 1_000_000_000_000n;

/**
 * The contract's tenure-decayed exit fee. `fee = maxBps * (period - tenure) / period`, integer.
 *
 * TENURE RESETS ON EVERY DEPOSIT. `VaultCore._mintShares` sets `lastDepositTime[member] =
 * block.timestamp`, so a top-up restores the FULL fee on the member's ENTIRE position, not just
 * the new money. This is the single most expensive non-obvious behaviour in the product and the
 * deposit flow must say so before the signature, not after.
 *
 * @param {{exitFeeMaxBps:bigint|number|string, exitFeeDecayPeriodSec:bigint|number|string,
 *          tenureSec:bigint|number|string, isSoleHolder?:boolean}} p
 * @returns {bigint} basis points
 */
export function exitFeeBps({ exitFeeMaxBps, exitFeeDecayPeriodSec, tenureSec, isSoleHolder = false }) {
  // `_settleExit`: `if (memberShares == ts) feeBps = 0` — the last member out pays nothing,
  // because the fee accrues to remaining members and there are none (EE-8/EE-9).
  if (isSoleHolder) return 0n;
  const maxBps = toBig(exitFeeMaxBps) ?? 0n;
  if (maxBps <= 0n) return 0n;
  const period = toBig(exitFeeDecayPeriodSec) ?? 0n;
  if (period <= 0n) return 0n;
  const tenure = toBig(tenureSec) ?? 0n;
  if (tenure >= period) return 0n;
  const t = tenure < 0n ? 0n : tenure;
  return (maxBps * (period - t)) / period;
}

/**
 * Seconds of tenure still needed for the fee to reach `targetBps` or below. Drives the honest
 * "wait N days and this costs you nothing" readout next to the fee.
 * @returns {number|null} null when the fee is already at/below target, or never decays
 */
export function secondsUntilFeeBps({ exitFeeMaxBps, exitFeeDecayPeriodSec, tenureSec }, targetBps) {
  const maxBps = toBig(exitFeeMaxBps) ?? 0n;
  const period = toBig(exitFeeDecayPeriodSec) ?? 0n;
  const tenure = toBig(tenureSec) ?? 0n;
  const target = toBig(targetBps) ?? 0n;
  if (maxBps <= 0n || period <= 0n) return null;
  const current = exitFeeBps({ exitFeeMaxBps, exitFeeDecayPeriodSec, tenureSec });
  if (current <= target) return null;
  // t at which the EXACT rational fee reaches target: maxBps*(period-t)/period == target.
  // The contract's integer division floors, so the displayed fee actually reaches target slightly
  // earlier than this; the value returned is therefore an over-estimate of the wait, which is the
  // safe direction — it never promises a free exit before one is available.
  const needed = period - (target * period) / maxBps;
  const delta = needed - tenure;
  return delta <= 0n ? null : Number(delta);
}

/**
 * Full in-kind exit preview.
 *
 * @param {Object} p
 * @param {bigint|string} p.burnShares          shares being redeemed (WAD)
 * @param {bigint|string} p.memberShares        the member's total shares (WAD)
 * @param {bigint|string} p.totalShares         vault totalShares (WAD)
 * @param {bigint|string} p.idleUsdc            vault idle USDC (6dp base units)
 * @param {Array<{symbol:string, address?:string, balance:bigint|string, decimals:number,
 *                priceWad?:bigint|string|null}>} p.basket  vault-level asset balances
 * @param {bigint|string} [p.childValueWad]     look-through value of child positions (WAD)
 * @param {bigint|string} [p.costBasisUsdc]     the member's total cost basis — needed for the
 *                                              performance-fee ceiling, absent ⇒ `perfFee: null`
 * @param {bigint|number|string} p.exitFeeMaxBps
 * @param {bigint|number|string} p.exitFeeDecayPeriodSec
 * @param {bigint|number|string} p.tenureSec
 * @returns {{ok:true, feeBps:bigint, keepBps:bigint, isSoleHolder:boolean, isFullExit:boolean,
 *            usdcPay:bigint, usdcPayMin:bigint|null,
 *            slices:Array<{symbol:string,amount:bigint,amountMin:bigint|null,decimals:number,
 *            valueWad:bigint|null}>, payoutValueWad:bigint|null, payoutValueMinWad:bigint|null,
 *            perfFee:{gainUsdc:bigint,maxUsdc:bigint,maxFracWad:bigint}|null,
 *            feeValueWad:bigint|null, valueComplete:boolean, coversFromChildren:boolean}
 *          |{ok:false, error:string}}
 */
export function previewExit(p) {
  const burn = toBig(p.burnShares);
  const mine = toBig(p.memberShares);
  const ts = toBig(p.totalShares);
  const idle = toBig(p.idleUsdc);
  if (burn === null || mine === null || ts === null || idle === null) {
    return { ok: false, error: 'Missing vault accounting — cannot preview this exit.' };
  }
  if (burn <= 0n) return { ok: false, error: 'Enter a share amount above zero.' };
  if (burn > mine) return { ok: false, error: 'You do not hold that many shares.' };
  if (ts <= 0n) return { ok: false, error: 'Vault has no shares outstanding.' };

  const isSoleHolder = mine === ts;
  const feeBps = exitFeeBps({
    exitFeeMaxBps: p.exitFeeMaxBps,
    exitFeeDecayPeriodSec: p.exitFeeDecayPeriodSec,
    tenureSec: p.tenureSec,
    isSoleHolder,
  });
  const keepBps = BPS - feeBps;

  const childValWad = toBig(p.childValueWad ?? 0n) ?? 0n;

  // ── contract order, preserved exactly ──
  // cashTargetWad = (idleUsdc * usdcScalar + childValTotalWad) * burnShares / ts * keepBps / BPS
  const cashTargetWad = (((idle * USDC_SCALAR + childValWad) * burn) / ts) * keepBps / BPS;
  let usdcPay = cashTargetWad / USDC_SCALAR;
  if (usdcPay > idle) usdcPay = idle; // capped at idle; the remainder unwinds children (SV-5)
  const shortfallWad = cashTargetWad - usdcPay * USDC_SCALAR;

  let payoutValueWad = usdcPay * USDC_SCALAR;
  let valueComplete = true;

  const slices = [];
  for (const a of p.basket ?? []) {
    const bal = toBig(a.balance);
    if (bal === null) { valueComplete = false; continue; }
    // slice = assetBalance * burnShares / ts * keepBps / BPS
    const amount = ((bal * burn) / ts) * keepBps / BPS;
    const price = toBig(a.priceWad ?? null);
    let valueWad = null;
    if (price !== null && Number.isInteger(a.decimals)) {
      valueWad = (amount * price) / 10n ** BigInt(a.decimals);
      payoutValueWad += valueWad;
    } else if (amount > 0n) {
      valueComplete = false; // an unpriced slice: show the token amount, refuse to total it
    }
    slices.push({ symbol: a.symbol, amount, amountMin: null, decimals: a.decimals, valueWad });
  }

  const coversFromChildren = shortfallWad > SHORTFALL_DUST_WAD;

  // ── the performance-fee CEILING, withheld uniformly across every leg above ──
  // `perfFee <= gain / 10` is the contract's own defensive clamp; the actual value depends on the
  // HWM loss carry, which no projection carries. Only the ceiling is knowable, so only a range is
  // reported — and only when every leg is priced and no child unwind is involved, because both
  // would change `payoutValueWad`, which is the denominator of `feeFracWad`.
  let perfFee = null;
  let usdcPayMin = null;
  let payoutValueMinWad = null;
  const basis = toBig(p.costBasisUsdc ?? null);
  if (valueComplete && !coversFromChildren && basis !== null && payoutValueWad > 0n) {
    const basisRemoved = (basis * burn) / mine; // contract order: costBasis * burnShares / memberShares
    const payoutValueUsdc = payoutValueWad / USDC_SCALAR;
    const gain = payoutValueUsdc > basisRemoved ? payoutValueUsdc - basisRemoved : 0n;
    const maxUsdc = gain / 10n;
    const maxFracWad = (maxUsdc * USDC_SCALAR * WAD) / payoutValueWad;
    perfFee = { gainUsdc: gain, maxUsdc, maxFracWad };

    usdcPayMin = usdcPay - (usdcPay * maxFracWad) / WAD;
    payoutValueMinWad = usdcPayMin * USDC_SCALAR;
    for (const s of slices) {
      s.amountMin = s.amount - (s.amount * maxFracWad) / WAD;
      if (s.valueWad !== null && s.amount > 0n) {
        payoutValueMinWad += (s.valueWad * s.amountMin) / s.amount;
      }
    }
  }

  // The exit fee is the difference between the un-feed and feed payout, in value terms. Only
  // computable when every leg is priced — and never when a child unwind is in play, because
  // `grossWad` then carries child value that `payoutValueWad` does not model, and the difference
  // would be reported as an exit fee it is not.
  let feeValueWad = null;
  if (valueComplete && keepBps > 0n && !coversFromChildren) {
    let grossWad = ((idle * USDC_SCALAR + childValWad) * burn) / ts;
    for (const a of p.basket ?? []) {
      const bal = toBig(a.balance);
      const price = toBig(a.priceWad ?? null);
      if (bal === null || price === null || !Number.isInteger(a.decimals)) continue;
      grossWad += (((bal * burn) / ts) * price) / 10n ** BigInt(a.decimals);
    }
    feeValueWad = grossWad > payoutValueWad ? grossWad - payoutValueWad : 0n;
  }

  return {
    ok: true,
    feeBps,
    keepBps,
    isSoleHolder,
    isFullExit: burn === mine,
    usdcPay,
    usdcPayMin,
    slices,
    payoutValueWad: valueComplete ? payoutValueWad : null,
    payoutValueMinWad,
    perfFee,
    feeValueWad,
    valueComplete,
    coversFromChildren,
  };
}
