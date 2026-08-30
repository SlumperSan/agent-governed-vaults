// @ts-check
/**
 * What a deposit actually does — mirroring `VaultCore._deposit` / `_mintShares` in BigInt, and
 * naming every one of its revert conditions before the user signs rather than after.
 *
 * The three things this exists to stop the UI getting wrong:
 *
 *  1. CAPACITY. The contract checks `navUsdc + totalPendingUsdc + amount <= capacityCapUsdc`.
 *     A utilisation bar drawn from NAV alone under-reports it and promises headroom that other
 *     people's escrowed-but-not-yet-active deposits have already consumed.
 *  2. SHARES ARE UNKNOWABLE ON THE WINDOW PATH. Minting is forward-priced at ACTIVATION NAV
 *     (ARCHITECTURE §4.3), four hours after the number the user is looking at. `shares` here is
 *     therefore returned with `sharesAreIndicative`, and callers must never render it as a
 *     promise on that path.
 *  3. TENURE RESET. `_mintShares` sets `lastDepositTime[member] = block.timestamp`, so any
 *     top-up restores the full exit fee across the member's WHOLE position. An existing member
 *     with a decayed fee is told, in money, what this deposit costs them.
 */

import { USDC_SCALAR, toBig } from './format.mjs';
import { exitFeeBps } from './exit-preview.mjs';

/**
 * Capacity as the contract measures it. `capacityCapUsdc === 0` means the vault opted out
 * (ARCHITECTURE §6 — the cap is optional), which is NOT the same as "full".
 * @param {{navUsdc:bigint|string, totalPendingUsdc:bigint|string, capacityCapUsdc:bigint|string}} v
 * @returns {{capped:boolean, used:bigint, cap:bigint, headroom:bigint|null, usedBps:number|null}}
 */
export function capacity({ navUsdc, totalPendingUsdc, capacityCapUsdc }) {
  const nav = toBig(navUsdc) ?? 0n;
  const pending = toBig(totalPendingUsdc) ?? 0n;
  const cap = toBig(capacityCapUsdc) ?? 0n;
  const used = nav + pending;
  if (cap === 0n) return { capped: false, used, cap: 0n, headroom: null, usedBps: null };
  const headroom = cap > used ? cap - used : 0n;
  return { capped: true, used, cap, headroom, usedBps: Number((used * 10_000n) / cap) };
}

/**
 * Which entry path a deposit takes. `_deposit` branches on
 * `windowCleared[member] || sharesOf[member] > 0`.
 * @returns {'immediate'|'window'}
 */
export function entryPath({ windowCleared = false, sharesHeld = 0n }) {
  return windowCleared || (toBig(sharesHeld) ?? 0n) > 0n ? 'immediate' : 'window';
}

/**
 * Indicative shares from `_mintShares`: `ts == 0 ? amountWad : amountWad * ts / navWad`.
 * Rounds DOWN against the depositor, as the contract does.
 * @returns {bigint|null} null when NAV is unknown — an unknowable share count is shown as
 *   unknown, never as an invented one.
 */
export function indicativeShares({ amountUsdc, totalShares, navWad }) {
  const amount = toBig(amountUsdc);
  const ts = toBig(totalShares);
  if (amount === null || amount <= 0n) return null;
  const amountWad = amount * USDC_SCALAR;
  if (ts === null) return null;
  if (ts === 0n) return amountWad; // first deposit: NAV/share is defined as 1e18
  const nav = toBig(navWad);
  if (nav === null || nav <= 0n) return null;
  return (amountWad * ts) / nav;
}

/**
 * Full deposit preview. Returns `blockers` (the deposit will revert — the contract's own error
 * names are carried so a failure the user hits on-chain reads the same as the warning they saw)
 * and `consequences` (it will succeed and this is what it costs).
 *
 * @param {Object} p
 * @param {bigint|string} p.amountUsdc
 * @param {bigint|string} p.minDepositUsdc
 * @param {bigint|string} p.navUsdc
 * @param {bigint|string} p.navWad
 * @param {bigint|string} p.totalPendingUsdc
 * @param {bigint|string} p.capacityCapUsdc
 * @param {bigint|string} p.totalShares
 * @param {bigint|string} [p.walletUsdc]
 * @param {boolean} [p.frozen]              oracle breaker tripped
 * @param {boolean} [p.windowCleared]       member already past/skipped the window here
 * @param {bigint|string} [p.sharesHeld]
 * @param {boolean} [p.hasPendingDeposit]   a pending deposit already exists (PendingExists)
 * @param {{exitFeeMaxBps:any, exitFeeDecayPeriodSec:any, tenureSec:any}} [p.tenure]
 */
export function previewDeposit(p) {
  const amount = toBig(p.amountUsdc);
  const blockers = [];
  const consequences = [];

  const cap = capacity({
    navUsdc: p.navUsdc,
    totalPendingUsdc: p.totalPendingUsdc,
    capacityCapUsdc: p.capacityCapUsdc,
  });
  const path = entryPath({ windowCleared: p.windowCleared, sharesHeld: p.sharesHeld });

  // ── blockers, in the order VaultCore checks them ──
  if (p.frozen) {
    blockers.push({
      code: 'StaleOracle',
      title: 'Deposits are paused — the oracle is frozen',
      detail:
        'The capacity check reads NAV, and NAV reverts while the price oracle is stale. ' +
        'Nothing you sign will land until the price sources recover.',
    });
  }
  if (amount === null || amount <= 0n) {
    blockers.push({ code: 'ZeroAmount', title: 'Enter an amount', detail: 'Deposits must be above zero.' });
  } else {
    const min = toBig(p.minDepositUsdc) ?? 0n;
    if (amount < min) {
      blockers.push({
        code: 'BelowMinDeposit',
        title: 'Below this vault’s minimum deposit',
        detail: 'The vault sets a floor at creation; it is immutable.',
        min,
      });
    }
    const wallet = toBig(p.walletUsdc);
    if (wallet !== null && amount > wallet) {
      blockers.push({ code: 'InsufficientBalance', title: 'More than your USDC balance', detail: '', have: wallet });
    }
    if (cap.capped && cap.used + amount > cap.cap) {
      blockers.push({
        code: 'CapacityExceeded',
        title: 'Over the vault’s capacity cap',
        detail:
          'Capacity counts live NAV plus everyone’s escrowed pending deposits, not NAV alone — ' +
          'so headroom can be smaller than the vault’s value suggests.',
        headroom: cap.headroom,
      });
    }
  }
  if (path === 'window' && p.hasPendingDeposit) {
    blockers.push({
      code: 'PendingExists',
      title: 'You already have a deposit in the observation window',
      detail: 'One pending deposit per member per vault. Cancel or activate it first.',
    });
  }

  // ── consequences of a deposit that WILL succeed ──
  if (path === 'window') {
    consequences.push({
      code: 'ObservationWindow',
      severity: 'info',
      title: 'Escrowed for 4 hours, with 0 shares',
      detail:
        'Your USDC is held outside the vault’s NAV, mints no shares and carries no vote until ' +
        'it activates. You can cancel for a full refund at any point in the window.',
    });
    consequences.push({
      code: 'ForwardPricedEntry',
      severity: 'info',
      title: 'Your share count is set in 4 hours, not now',
      detail:
        'Shares mint at the NAV at activation, so the estimate below is indicative. This is why ' +
        'you cannot mint against a valuation you read four hours earlier.',
    });
  }

  // Tenure reset — the expensive one. Quantified, not just asserted.
  if (p.tenure) {
    const before = exitFeeBps({
      exitFeeMaxBps: p.tenure.exitFeeMaxBps,
      exitFeeDecayPeriodSec: p.tenure.exitFeeDecayPeriodSec,
      tenureSec: p.tenure.tenureSec,
    });
    const after = exitFeeBps({
      exitFeeMaxBps: p.tenure.exitFeeMaxBps,
      exitFeeDecayPeriodSec: p.tenure.exitFeeDecayPeriodSec,
      tenureSec: 0n,
    });
    if (after > before) {
      consequences.push({
        code: 'TenureReset',
        severity: 'warn',
        title: 'This deposit resets your exit-fee clock on your whole position',
        detail:
          'The vault times tenure from your LAST deposit, so topping up restores the full exit ' +
          'fee across every share you hold — not just the new ones.',
        fromBps: before,
        toBps: after,
      });
    }
  }

  const shares = indicativeShares({ amountUsdc: p.amountUsdc, totalShares: p.totalShares, navWad: p.navWad });

  return {
    ok: blockers.length === 0,
    path,
    blockers,
    consequences,
    capacity: cap,
    shares,
    sharesAreIndicative: path === 'window' || shares === null,
  };
}
