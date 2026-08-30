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
 * `childValueWad > 0` sets `coversFromChildren`, and callers must present the payout as
 * indicative in that case rather than exact. It is not guessed at.
 */

import { BPS, USDC_SCALAR, toBig } from './format.mjs';

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
  // smallest t with maxBps*(period-t)/period <= target  ⇒  t >= period - (target*period)/maxBps
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
 * @param {bigint|number|string} p.exitFeeMaxBps
 * @param {bigint|number|string} p.exitFeeDecayPeriodSec
 * @param {bigint|number|string} p.tenureSec
 * @returns {{ok:true, feeBps:bigint, keepBps:bigint, isSoleHolder:boolean, isFullExit:boolean,
 *            usdcPay:bigint, slices:Array<{symbol:string,amount:bigint,decimals:number,
 *            valueWad:bigint|null}>, payoutValueWad:bigint|null, feeValueWad:bigint|null,
 *            valueComplete:boolean, coversFromChildren:boolean}
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
    slices.push({ symbol: a.symbol, amount, decimals: a.decimals, valueWad });
  }

  // The fee is the difference between the un-feed and feed payout, in value terms. Only
  // computable when every leg is priced.
  let feeValueWad = null;
  if (valueComplete && keepBps > 0n) {
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
    slices,
    payoutValueWad: valueComplete ? payoutValueWad : null,
    feeValueWad,
    valueComplete,
    coversFromChildren: shortfallWad > 0n,
  };
}
