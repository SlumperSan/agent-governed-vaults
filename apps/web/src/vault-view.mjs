// @ts-check
/**
 * Composes a vault record + the viewer's position into the facts every screen renders. Kept out
 * of index.html so the derivations that decide what a user is shown are testable.
 */

import { toBig, USDC_SCALAR } from './format.mjs';
import { capacity } from './deposit-preview.mjs';
import { exitFeeBps } from './exit-preview.mjs';
import { resolveExitMode } from './governance.mjs';
import { actions, vaultStatus } from './vault-state.mjs';
import { stackedPerfFeeBps, stackedExitFeeCapBps } from './fees.mjs';

/**
 * Per-asset oracle health. A freeze is PER ASSET — `OracleAggregator.priceWad(asset)` reverts
 * `StaleOracle` for the one asset whose sources went stale, and `VaultCore.navWad` walks the
 * whole basket, so a single stale feed freezes the entire vault. Showing which asset, and how far
 * past its bound, is what turns "frozen" from a scary opaque word into a legible mechanism.
 *
 * @param {Array<{symbol:string, oracleUpdatedAt:number|null, maxStalenessSec:number|null, priceWad:any}>} basket
 * @param {number} nowSec
 */
export function oracleHealth(basket, nowSec) {
  const assets = (basket ?? []).map((a) => {
    if (!Number.isFinite(a.oracleUpdatedAt) || !Number.isFinite(a.maxStalenessSec)) {
      return { symbol: a.symbol, state: /** @type {const} */ ('unknown'), ageSec: null, boundSec: null, overBySec: null };
    }
    const age = Math.max(0, nowSec - Number(a.oracleUpdatedAt));
    const bound = Number(a.maxStalenessSec);
    if (age > bound) {
      return { symbol: a.symbol, state: /** @type {const} */ ('stale'), ageSec: age, boundSec: bound, overBySec: age - bound };
    }
    // Within bound, but close enough that a user should not start a transaction on it.
    const state = age > bound * 0.8 ? /** @type {const} */ ('ageing') : /** @type {const} */ ('fresh');
    return { symbol: a.symbol, state, ageSec: age, boundSec: bound, overBySec: null };
  });
  const stale = assets.filter((a) => a.state === 'stale');
  const unknown = assets.filter((a) => a.state === 'unknown');
  return {
    assets,
    frozen: stale.length > 0,
    // A vault whose feed freshness we cannot read is not provably live.
    determinable: unknown.length === 0,
    culprits: stale.map((a) => a.symbol),
  };
}

/**
 * The viewer's position in one vault, valued at the vault's NAV/share.
 * @returns {{shares:bigint, valueUsdc:bigint|null, costBasisUsdc:bigint|null,
 *            pnlUsdc:bigint|null, tenureSec:number, feeBpsNow:bigint, isSoleHolder:boolean,
 *            queuedExitShares:bigint}|null}
 */
export function position(vault, holding, nowSec) {
  if (!vault || !holding) return null;
  const shares = toBig(holding.shares) ?? 0n;
  const totalShares = toBig(vault.totalShares) ?? 0n;
  const navWad = toBig(vault.navWad);
  const basis = toBig(holding.costBasisUsdc);

  // value = shares/totalShares × NAV, in USDC. Unknowable while frozen — NAV cannot be read.
  let valueUsdc = null;
  if (!vault.frozen && navWad !== null && totalShares > 0n) {
    valueUsdc = (navWad * shares) / totalShares / USDC_SCALAR;
  }

  const tenureSec = Math.max(0, nowSec - Number(holding.lastDepositTime ?? nowSec));
  const isSoleHolder = totalShares > 0n && shares === totalShares;

  return {
    shares,
    valueUsdc,
    costBasisUsdc: basis,
    pnlUsdc: valueUsdc !== null && basis !== null ? valueUsdc - basis : null,
    tenureSec,
    feeBpsNow: exitFeeBps({
      exitFeeMaxBps: vault.exitFeeMaxBps,
      exitFeeDecayPeriodSec: vault.exitFeeDecayPeriodSec,
      tenureSec,
      isSoleHolder,
    }),
    isSoleHolder,
    queuedExitShares: toBig(holding.queuedExitShares) ?? 0n,
  };
}

/**
 * Everything a card or a detail page needs, in one object, so the two cannot disagree about
 * whether a vault is frozen or whether its exits queue.
 *
 * @param {object} vault    a fixture/API vault record
 * @param {object|null} wallet
 * @param {number} nowSec
 */
export function vaultView(vault, wallet, nowSec) {
  const holding = wallet?.positions?.find((p) => eqAddr(p.vault, vault.address)) ?? null;
  const pendingDeposit = wallet?.pending?.find((p) => eqAddr(p.vault, vault.address)) ?? null;
  const pos = position(vault, holding, nowSec);

  const oracle = oracleHealth(vault.basket, nowSec);
  // The record's own `frozen` flag and the feed ages must agree; if either says frozen, frozen.
  const frozen = Boolean(vault.frozen) || oracle.frozen;

  const cap = capacity({
    navUsdc: (toBig(vault.navWad) ?? 0n) / USDC_SCALAR,
    totalPendingUsdc: vault.totalPendingUsdc ?? 0n,
    capacityCapUsdc: vault.capacityCapUsdc ?? 0n,
  });

  const mode = resolveExitMode(vault.proposal ?? null, nowSec);

  const facts = {
    frozen,
    attested: Boolean(vault.attested),
    exitMode: mode.mode,
    isMember: (pos?.shares ?? 0n) > 0n,
    hasPendingDeposit: Boolean(pendingDeposit),
    pendingMatured: Boolean(pendingDeposit) && nowSec >= Number(pendingDeposit.availableAt),
    hasQueuedExit: (pos?.queuedExitShares ?? 0n) > 0n,
    capacityFull: cap.capped && cap.headroom === 0n,
    walletConnected: Boolean(wallet),
  };

  const levels = Number(vault.depth ?? 0) + 1;
  return {
    vault,
    holding,
    pendingDeposit,
    position: pos,
    oracle,
    frozen,
    capacity: cap,
    mode,
    facts,
    status: vaultStatus(facts),
    actions: actions(facts),
    fees: {
      levels,
      stackedPerfFeeBps: stackedPerfFeeBps(levels),
      stackedExitFeeCapBps: stackedExitFeeCapBps((vault.exitFeeMaxBpsByLevel ?? []).slice(0, levels)),
      exitFeeMaxBps: Number(vault.exitFeeMaxBps ?? 0),
      exitFeeDecayPeriodSec: Number(vault.exitFeeDecayPeriodSec ?? 0),
    },
  };
}

function eqAddr(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/** Sort keys for discovery. Each names the signal it ranks on, so the UI never sorts on a proxy. */
export const SORTS = {
  capacity: { label: 'Capacity used', fn: (a, b) => (b.capacity.usedBps ?? -1) - (a.capacity.usedBps ?? -1) },
  size: { label: 'Vault NAV', fn: (a, b) => cmpBig(toBig(b.vault.navWad) ?? 0n, toBig(a.vault.navWad) ?? 0n) },
  members: { label: 'Members', fn: (a, b) => Number(b.vault.holderCount ?? 0) - Number(a.vault.holderCount ?? 0) },
  fee: { label: 'Lowest exit fee', fn: (a, b) => a.fees.exitFeeMaxBps - b.fees.exitFeeMaxBps },
};

function cmpBig(x, y) {
  return x > y ? 1 : x < y ? -1 : 0;
}
